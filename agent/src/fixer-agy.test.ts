// 뇌가 agy 인 수정 run: 가짜 agy(stream-json)로 이벤트·결과·턴 사이 --conversation·훅 넣고 빼기·샌드박스 규칙, 그리고 훅 판정(진짜 agy 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGY_GUARD, runFix, prepareContinue, type AgyRun } from "./fixer.ts";
import { RunRegistry } from "./runs.ts";
import { injectedPrompt } from "./run-inbox.ts";
import type { Config } from "./config.ts";
import type { Proposal } from "./store.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function setupRepo(extra?: (seed: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "cy-fixag-"));
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# demo\n");
  extra?.(seed);
  git(seed, "add", "-A");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: seed });
  git(root, "clone", "-q", "--bare", seed, "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), "app");
  return { root, app: join(root, "app"), origin: join(root, "origin.git"), wts: join(root, "wts") };
}
const cfgFor = (root: string) => ({ repoRoots: [root], gitAuthor: { name: "Bot", email: "bot@example.com" }, models: { code: "claude-x", general: "claude-opus-5-5" }, brain: { provider: "agy" } }) as unknown as Config;
const proposal = (app: string, id: string): Proposal => ({ id, repo: app, title: "add hello", plan: "hello.txt 추가", status: "approved", created: new Date().toISOString() });
const REPORT = (summary: string) => ({ summary, commit_message: "feat: add hello", tests_ran: "npm test", tests_passed: true });
const until = async (cond: () => boolean, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

type Ctx = { cwd: string; env: NodeJS.ProcessEnv; emit: (e: any) => void; signal: AbortSignal };
function fakeAgy(turn: (n: number, args: string[], ctx: Ctx) => Promise<number | void>) {
  const calls: { args: string[]; cwd: string; env: NodeJS.ProcessEnv; hooks: boolean }[] = [];
  const fn: AgyRun = async (args, o) => {
    calls.push({ args, cwd: o.cwd, env: o.env, hooks: existsSync(join(o.cwd, ".agents", "hooks.json")) });
    const code = await turn(calls.length, args, { cwd: o.cwd, env: o.env, emit: (e) => o.onLine(JSON.stringify(e)), signal: o.signal });
    return { code: o.signal.aborted ? null : (code ?? 0), stderr: "" };
  };
  return { fn, calls };
}
const upd = (u: Record<string, unknown>) => ({ event: "step_update", step_update: { conversation_id: "cv-1", ...u } });
const result = (out: unknown) => ({ event: "result", result: { conversation_id: "cv-1", status: "SUCCESS", response: "", structured_output: out } });

test("agy 수정 run: 샌드박스 규칙·훅을 넣고, 이벤트를 세션 창으로, 턴 사이 말은 --conversation, 훅은 커밋 전에 빼고 커밋·푸시는 데몬이", async () => {
  const { root, app, origin, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ag = fakeAgy(async (n, _args, { cwd, emit }) => {
    if (n === 1) {
      emit(upd({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } } }));
      emit(upd({ step_index: 1, state: "DONE", step_type: "tool", tool_name: "run_command" }));
      writeFileSync(join(cwd, "hello.txt"), "hi\n");
      emit(upd({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: join(cwd, "hello.txt") } } }));
      emit(upd({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "write_to_file" }));
      emit(upd({ step_index: 3, state: "ERROR", step_type: "tool", tool_name: "write_to_file", tool_info: { error: { message: "denied by pre-tool hook" } } }));
      emit(upd({ step_index: 4, state: "DONE", step_type: "agent_response", text_delta: "hello 를 추가했어요" }));
      await gate;
      emit(upd({ step_index: 5, state: "ACTIVE", step_type: "tool", tool_name: "finish", tool_info: { parameters: REPORT("hello 추가") } }));
      emit(result(REPORT("hello 추가")));
    } else {
      appendFileSync(join(cwd, "README.md"), "한 줄 더\n");
      emit(result(REPORT("hello + README 한 줄")));
    }
  });
  const allowed: string[][] = [];
  const steps: string[] = [];
  const p = runFix(cfgFor(root), proposal(app, "prop-ag-1"), (s) => steps.push(s), { agyRun: ag.fn, agyAllow: (r) => allowed.push(r), runs: reg, worktreesDir: wts });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.name === "Write"));
  const id = reg.listRuns()[0].id;
  const sr = await reg.sendMessage(id, "그리고 README에 한 줄 추가해", { clientId: "c-1" }) as any;
  assert.equal(sr.ok, true);
  release();
  const r = await p;
  assert.equal(r.ok, true, r.summary);

  assert.equal(ag.calls.length, 2);
  const [a, b] = ag.calls;
  for (const x of ["--sandbox", "--dangerously-skip-permissions", "accept-edits", "--json-schema", "stream-json"]) assert.ok(a.args.includes(x), x);
  assert.ok(!a.args.includes("--conversation"));
  assert.equal(a.args[a.args.indexOf("--model") + 1], "claude-opus-5-5");
  assert.match(a.args[1], /제목: add hello/);
  assert.deepEqual(b.args.slice(b.args.indexOf("--conversation"), b.args.indexOf("--conversation") + 2), ["--conversation", "cv-1"]);
  assert.equal(b.args[1], injectedPrompt("그리고 README에 한 줄 추가해"));
  assert.equal(a.env.USAGI_AGY_WT, a.cwd);
  assert.ok(a.hooks && b.hooks, "실행 중엔 워크트리에 훅이 있다");
  assert.ok(!existsSync(join(a.cwd, ".agents")), "끝나면 훅을 뺀다");
  assert.equal(allowed.length, 1);
  assert.ok(allowed[0].includes(`write_file(${wts})`));
  assert.ok(allowed[0].some((x) => /^read_file\(.*\.gitconfig\)$/.test(x)));
  assert.ok(allowed[0].some((x) => x === `read_file(${join(app, ".git")})` || x.startsWith("read_file(") && x.endsWith("/app/.git)")));

  const g = reg.getRun(id)!;
  assert.equal(g.run.status, "done");
  assert.equal(g.run.sdkSessionId, "agy:cv-1");
  assert.ok(g.events.some((e) => e.type === "tool_use" && e.name === "Bash" && e.input === "npm test"));
  assert.ok(g.events.some((e) => e.type === "tool_result" && e.isError && /pre-tool hook/.test(e.output ?? "")));
  assert.ok(g.events.some((e) => e.type === "assistant" && e.text === "hello 를 추가했어요"));
  assert.ok(!g.events.some((e) => e.type === "tool_use" && e.name === "finish"));
  assert.ok(steps.includes("$ npm test"));
  assert.equal(git(origin, "show", `${r.branch}:hello.txt`), "hi");
  assert.match(git(origin, "show", `${r.branch}:README.md`), /한 줄 더/);
  assert.equal(git(origin, "ls-tree", "-r", "--name-only", r.branch!).split("\n").filter((f) => f.startsWith(".agents")).length, 0, "훅은 커밋되지 않는다");
  assert.equal(git(origin, "log", "-1", "--format=%an", r.branch!), "Bot");

  // 이어서 하기: 앞선 run 이 agy 대화면 그 대화를 이어 쓴다(갈래 없음), 요약은 넣지 않는다
  const ag2 = fakeAgy(async (_n, _args, { cwd, emit }) => { appendFileSync(join(cwd, "README.md"), "또 한 줄\n"); emit(result(REPORT("또 한 줄"))); });
  const seen: string[] = [];
  const c = prepareContinue(cfgFor(root), { parent: g.run, repo: app, branch: r.branch!, text: "한 줄 더", summary: "앞선 요약" },
    { agyRun: ag2.fn, agyAllow: () => {}, runs: reg, worktreesDir: wts, prState: () => undefined, sessionExists: async (sid) => { seen.push(sid); return true; } });
  const r2 = await c.start(() => {});
  assert.equal(r2.ok, true, r2.summary);
  assert.deepEqual(seen, ["agy:cv-1"]);
  assert.ok(ag2.calls[0].args.includes("--conversation"));
  assert.doesNotMatch(ag2.calls[0].args[1], /앞선 요약/);
});

test("agy 수정 run: 마지막 턴이 종료 코드 0 인데 구조화 결과가 없으면 앞 턴 결과를 쓰지 않고 실패", async () => {
  const { root, app, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ag = fakeAgy(async (n, _args, { emit }) => {
    if (n === 1) {
      emit(upd({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls" } } }));
      await gate;
      emit(result(REPORT("첫 턴 성공")));
    } else emit({ event: "result", result: { conversation_id: "cv-1", status: "SUCCESS", response: "" } });
  });
  const p = runFix(cfgFor(root), proposal(app, "prop-ag-stale"), () => {}, { agyRun: ag.fn, agyAllow: () => {}, runs: reg, worktreesDir: wts });
  const rejected = assert.rejects(p, /결과를 보고하지 않았어요/);
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.name === "Bash"));
  await reg.sendMessage(reg.listRuns()[0].id, "하나 더");
  release();
  await rejected;
});

test("agy 수정 run: 레포에 원래.agents/hooks.json 이 있으면 덮지 않고 실패", async () => {
  const { root, app, wts } = setupRepo((seed) => { mkdirSync(join(seed, ".agents")); writeFileSync(join(seed, ".agents", "hooks.json"), "{}"); });
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const ag = fakeAgy(async () => {});
  await assert.rejects(runFix(cfgFor(root), proposal(app, "prop-ag-2"), () => {}, { agyRun: ag.fn, agyAllow: () => {}, runs: reg, worktreesDir: wts }), /\.agents\/hooks\.json/);
  assert.equal(ag.calls.length, 0);
});

test("AGY_GUARD: 터미널·finish·워크트리 안 파일은 허용, 밖·웹·MCP 는 거절, 데몬 실행이 아니면 묻기, 이상한 입력에도 죽지 않음", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-guard-"));
  const guard = join(dir, "g.mjs");
  writeFileSync(guard, AGY_GUARD);
  const wt = join(dir, "wt");
  const judge = (input: string, env: Record<string, string> = { USAGI_AGY_WT: wt }) =>
    JSON.parse(execFileSync(process.execPath, [guard], { input, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" })).decision;
  const call = (name: string, args: Record<string, unknown> = {}) => JSON.stringify({ toolCall: { name, args } });
  assert.equal(judge(call("run_command", { CommandLine: "rm -rf /", Cwd: "/" })), "allow"); // 터미널은 샌드박스가 막는다
  assert.equal(judge(call("finish", { summary: "/x" })), "allow");
  assert.equal(judge(call("write_to_file", { TargetFile: join(wt, "a.ts"), CodeContent: "/* 주석 */" })), "allow");
  assert.equal(judge(call("replace_file_content", { TargetFile: "src/b.ts" })), "allow"); // 상대 경로는 워크트리 기준
  assert.equal(judge(call("write_to_file", { TargetFile: join(dir, "outside.txt") })), "deny");
  assert.equal(judge(call("write_to_file", { TargetFile: join(wt, "..", "escape.txt") })), "deny");
  assert.equal(judge(call("view_file", { AbsolutePath: "file:///etc/passwd" })), "deny");
  assert.equal(judge(call("write_to_file", { TargetFile: `${wt}-evil/a` })), "deny"); // 이름만 비슷한 옆 폴더
  for (const n of ["read_url_content", "browser_click_element", "call_mcp_tool", "invoke_subagent", "search_web"]) assert.equal(judge(call(n)), "deny", n);
  assert.equal(judge(call("write_to_file", { TargetFile: "/etc/x" }), {}), "ask"); // 사용자가 직접 쓰는 agy
  assert.equal(judge("{not json"), "deny");
});
