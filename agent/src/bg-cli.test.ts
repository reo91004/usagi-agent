// Codex·agy 백그라운드 에이전트: 격리 워크트리에서 가짜 codex/agy 로 돌고, 같은 카드 모양·멈추기·결과 요약·워크트리 커밋(진짜 CLI 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BackgroundAgents } from "./bg-agents.ts";
import { addAgentWorktree, finishAgentWorktree, worktreeNote } from "./agent-worktrees.ts";
import { runCliAgent, type AgyRun, type CodexRun } from "./fixer.ts";
import { RunRegistry } from "./runs.ts";
import { agentsForThread } from "./thread-agents.ts";
import type { Config } from "./config.ts";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo() {
  const root = mkdtempSync(join(tmpdir(), "cy-bgcli-"));
  const app = join(root, "app");
  mkdirSync(app);
  sh(app, "init", "-q", "-b", "main");
  writeFileSync(join(app, "README.md"), "# demo\n");
  sh(app, "add", "-A");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: app });
  return { root, app, wts: join(root, "wts") };
}
const cfgFor = (provider: string) => ({ gitAuthor: { name: "Bot", email: "bot@example.com" }, models: { code: "x", general: "x" }, brain: { provider }, codexSessionsDir: "/none" }) as unknown as Config;
const REPORT = JSON.stringify({ summary: "hello.txt 추가", commit_message: "feat: hello", tests_ran: "npm test", tests_passed: true });
const waitFor = async (fn: () => boolean) => { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

function rig(provider: "codex" | "agy", fake: { codexRun?: CodexRun; agyRun?: AgyRun }) {
  const { app, wts } = repo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const posts: [string, string][] = [];
  const cfg = cfgFor(provider);
  const bg = new BackgroundAgents({
    run: (job, onRun) => runCliAgent(cfg, { ...job, cwd: job.cwd! }, onRun, { runs: reg, worktreesDir: wts, agyAllow: () => {}, ...fake }),
    post: (_t, role, text) => posts.push([role, text]),
    changed: () => {},
    forceIsolation: () => true,
    isolate: async (job) => {
      const w = await addAgentWorktree(app, { label: job.description, id: job.toolUseId, worktreesDir: wts });
      return { path: w.wt, branch: w.branch, finish: async () => worktreeNote(w, await finishAgentWorktree(w, { author: cfg.gitAuthor })) };
    },
  });
  return { reg, posts, bg, app };
}
const req = { toolUseId: "tu-1", threadId: "th-1", via: "chat" as const, description: "hello 추가", prompt: "hello.txt 를 만들어" };

test("Codex 백그라운드 에이전트: 격리 워크트리에서 codex exec(workspace-write·네트워크 끔) → 카드·결과·브랜치 커밋", async () => {
  let args: string[] = [], cwd = "";
  const codexRun: CodexRun = async (a, o) => {
    args = a; cwd = o.cwd;
    o.onLine(JSON.stringify({ type: "thread.started", thread_id: "th-cx" }));
    writeFileSync(join(o.cwd, "hello.txt"), "hi\n");
    o.onLine(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "file_change", changes: [{ path: join(o.cwd, "hello.txt"), kind: "add" }] } }));
    o.onLine(JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: REPORT } }));
    return { code: 0, stderr: "" };
  };
  const { reg, posts, bg, app } = rig("codex", { codexRun });
  assert.match(bg.request(req), /자기 워크트리에서/);
  await bg.idle();
  assert.ok(args.includes('sandbox_mode="workspace-write"') && args.includes("sandbox_workspace_write.network_access=false"));
  assert.notEqual(cwd, app);
  assert.equal(bg.get("tu-1")!.status, "done");
  assert.match(posts[0][1], /hello\.txt 추가[\s\S]*npm test — 통과[\s\S]*커밋/);
  const [card] = agentsForThread(reg, "th-1", (t) => bg.get(t));
  assert.equal(card.status, "done");
  assert.equal(card.background, true);
  assert.equal(card.tools, 1);
  assert.match(sh(app, "branch", "--list", "cy/agent-*"), /cy\/agent-/);
});

test("Codex 백그라운드 에이전트: 멈추기는 프로세스를 끊고 stopped, 실패는 failed", async () => {
  const codexRun: CodexRun = (_a, o) => new Promise((res) => o.signal.addEventListener("abort", () => res({ code: null, stderr: "" })));
  const a = rig("codex", { codexRun });
  a.bg.request(req);
  await waitFor(() => !!a.bg.get("tu-1")!.runId);
  assert.equal(a.bg.stop("tu-1"), true);
  await a.bg.idle();
  assert.equal(a.bg.get("tu-1")!.status, "stopped");
  assert.equal(a.reg.getRun(a.bg.get("tu-1")!.runId!)!.run.status, "stopped");

  const b = rig("codex", { codexRun: async (_a, o) => { o.onLine(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })); return { code: 1, stderr: "" }; } });
  b.bg.request(req);
  await b.bg.idle();
  assert.equal(b.bg.get("tu-1")!.status, "failed");
  assert.match(b.posts[0][1], /boom/);
});

test("agy 백그라운드 에이전트: 같은 드라이버(훅 설치·--sandbox)로 돌고 훅 파일은 지워진다", async () => {
  let args: string[] = [], hooks = false;
  const agyRun: AgyRun = async (a, o) => {
    args = a; hooks = existsSync(join(o.cwd, ".agents", "hooks.json"));
    o.onLine(JSON.stringify({ result: { status: "SUCCESS", structured_output: JSON.parse(REPORT) } }));
    return { code: 0, stderr: "" };
  };
  const { bg, posts, app } = rig("agy", { agyRun });
  bg.request(req);
  await bg.idle();
  assert.ok(args.includes("--sandbox") && hooks);
  assert.equal(bg.get("tu-1")!.status, "done");
  assert.match(posts[0][1], /hello\.txt 추가/);
  assert.equal(sh(app, "worktree", "list").split("\n").length, 1); // 바뀐 게 없어 워크트리를 지웠다(.agents 훅 파일이 커밋에 섞이지 않았다)
});
