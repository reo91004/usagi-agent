// 뇌가 codex 인 수정 run: 가짜 codex(JSONL)로 이벤트 옮기기·결과·턴 사이에 보낸 말 resume·이어서 fork·정지(진짜 Codex 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runFix, prepareContinue, type CodexRun } from "./fixer.ts";
import { RunRegistry } from "./runs.ts";
import { injectedPrompt } from "./run-inbox.ts";
import type { Config } from "./config.ts";
import type { Proposal } from "./store.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "cy-fixcx-"));
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# demo\n");
  git(seed, "add", "-A");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: seed });
  git(root, "clone", "-q", "--bare", seed, "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), "app");
  return { root, app: join(root, "app"), origin: join(root, "origin.git"), wts: join(root, "wts") };
}
const cfgFor = (root: string) => ({ repoRoots: [root], gitAuthor: { name: "Bot", email: "bot@example.com" }, models: { code: "claude-x" }, brain: { provider: "codex" }, codexSessionsDir: join(root, "no-sessions") }) as unknown as Config;
const proposal = (app: string, id: string): Proposal => ({ id, repo: app, title: "add hello", plan: "hello.txt 추가", status: "approved", created: new Date().toISOString() });
const REPORT = (summary: string) => JSON.stringify({ summary, commit_message: "feat: add hello", tests_ran: "npm test", tests_passed: true });
const until = async (cond: () => boolean, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

type Ctx = { cwd: string; emit: (e: any) => void; signal: AbortSignal };
function fakeCodex(turn: (n: number, args: string[], input: string, ctx: Ctx) => Promise<number | void>) {
  const calls: { args: string[]; input: string; cwd: string }[] = [];
  const fn: CodexRun = async (args, o) => {
    calls.push({ args, input: o.input, cwd: o.cwd });
    const code = await turn(calls.length, args, o.input, { cwd: o.cwd, emit: (e) => o.onLine(JSON.stringify(e)), signal: o.signal });
    return { code: o.signal.aborted ? null : (code ?? 0), stderr: "" };
  };
  return { fn, calls };
}
const said = (text: string) => ({ type: "item.completed", item: { id: "item_9", type: "agent_message", text } });

test("codex 수정 run: 이벤트를 세션 창으로, 턴 사이에 보낸 말은 exec resume, 결과로 커밋·푸시", async () => {
  const { root, app, origin, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const cx = fakeCodex(async (n, _args, _input, { cwd, emit }) => {
    emit({ type: "thread.started", thread_id: "th-1" });
    emit({ type: "turn.started" });
    if (n === 1) {
      emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'npm test'" } });
      emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'npm test'", aggregated_output: "ok", exit_code: 0 } });
      writeFileSync(join(cwd, "hello.txt"), "hi\n");
      emit({ type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: join(cwd, "hello.txt"), kind: "add" }] } });
      await gate; // 이 사이에 사용자가 메시지를 보낸다(Codex 는 턴 중간에 못 받는다 → 다음 턴)
      emit(said(REPORT("hello 추가")));
    } else {
      appendFileSync(join(cwd, "README.md"), "한 줄 더\n");
      emit(said(REPORT("hello + README 한 줄")));
    }
    emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const steps: string[] = [];
  const p = runFix(cfgFor(root), proposal(app, "prop-cx-1"), (s) => steps.push(s), { codexRun: cx.fn, runs: reg, worktreesDir: wts });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.name === "Write"));
  const id = reg.listRuns()[0].id;
  const sr = await reg.sendMessage(id, "그리고 README에 한 줄 추가해", { clientId: "c-1" }) as any;
  assert.equal(sr.ok, true);
  release();
  const r = await p;
  assert.equal(r.ok, true, r.summary);

  assert.equal(cx.calls.length, 2);
  const [a, b] = cx.calls;
  assert.deepEqual(a.args.slice(0, 2), ["exec", "--json"]); // 처음엔 새 대화
  for (const x of ["--ignore-user-config", 'sandbox_mode="workspace-write"', "sandbox_workspace_write.network_access=false", "--output-schema"]) assert.ok(a.args.includes(x), x);
  assert.equal(a.args.at(-1), "-");
  assert.match(a.input, /제목: add hello/);
  assert.deepEqual(b.args.slice(0, 3), ["exec", "resume", "th-1"]);
  assert.equal(b.input, injectedPrompt("그리고 README에 한 줄 추가해"));
  assert.equal(a.cwd, b.cwd);

  const g = reg.getRun(id)!;
  assert.equal(g.run.status, "done");
  assert.equal(g.run.sdkSessionId, "codex:th-1");
  assert.ok(g.events.some((e) => e.type === "tool_use" && e.name === "Bash" && e.input === "npm test"));
  assert.ok(g.events.some((e) => e.type === "tool_result" && e.output === "ok" && !e.isError));
  assert.deepEqual(g.events.filter((e) => e.type === "delivery").map((e) => [e.msgId, e.state]), [[sr.msgId, "delivered"]]);
  assert.equal(g.events.filter((e) => e.type === "system" && /세션 시작 · Codex/.test(e.text ?? "")).length, 1); // resume 은 같은 대화 — 두 번 안 찍는다
  assert.ok(steps.includes("$ npm test"));
  assert.match(git(origin, "show", `${r.branch}:README.md`), /한 줄 더/);
  assert.equal(git(origin, "show", `${r.branch}:hello.txt`), "hi");
  assert.equal(git(origin, "log", "-1", "--format=%an", r.branch!), "Bot"); // 커밋은 cy-agent 가

  // 이어서 하기: 앞선 run 이 Codex 대화면 exec fork(앞선 대화는 그대로), 새 갈래를 run 의 세션으로
  const cx2 = fakeCodex(async (_n, _args, _input, { cwd, emit }) => {
    emit({ type: "thread.started", thread_id: "th-2" });
    appendFileSync(join(cwd, "README.md"), "또 한 줄\n");
    emit(said(REPORT("README 또 한 줄")));
    emit({ type: "turn.completed" });
  });
  const seen: string[] = [];
  const c = prepareContinue(cfgFor(root), { parent: g.run, repo: app, branch: r.branch!, text: "한 줄 더 써 줘", summary: "앞선 요약" },
    { codexRun: cx2.fn, runs: reg, worktreesDir: wts, prState: () => undefined, sessionExists: async (sid) => { seen.push(sid); return true; } });
  const r2 = await c.start(() => {});
  assert.equal(r2.ok, true, r2.summary);
  assert.deepEqual(seen, ["codex:th-1"]);
  assert.deepEqual(cx2.calls[0].args.slice(0, 3), ["exec", "fork", "th-1"]);
  assert.doesNotMatch(cx2.calls[0].input, /앞선 요약/); // fork 면 요약을 넣지 않는다
  assert.equal(reg.getRun(c.run.id)!.run.sdkSessionId, "codex:th-2");
  assert.match(git(origin, "show", `${r.branch}:README.md`), /또 한 줄/);
});

test("codex 수정 run: 앞선 run 이 Claude 세션이면 fork 하지 않고 요약으로 새로, 정지하면 커밋 안 함", async () => {
  const { root, app, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const cx = fakeCodex(async (_n, _args, _input, { emit, signal }) => {
    emit({ type: "thread.started", thread_id: "th-9" });
    await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
  });
  const parent = { id: "run-old", title: "옛 작업", kind: "fix", status: "done", sdkSessionId: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", cwd: join(wts, "gone") } as any;
  const c = prepareContinue(cfgFor(root), { parent, repo: app, branch: "cy/none", text: "이어서", summary: "앞선 요약" },
    { codexRun: cx.fn, runs: reg, worktreesDir: wts, prState: () => undefined, sessionExists: async () => { throw new Error("Claude 세션은 묻지 않는다"); } });
  const p = c.start(() => {});
  await until(() => cx.calls.length === 1);
  assert.deepEqual(cx.calls[0].args.slice(0, 2), ["exec", "--json"]);
  assert.match(cx.calls[0].input, /앞선 요약/);
  await reg.stop(c.run.id);
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.summary, /정지/);
});
