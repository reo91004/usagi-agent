import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { buildDashboard, gitRootOf } from "./dashboard.ts";
import type { RepoActivity } from "./git.ts";

const now = new Date("2026-10-08T05:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * 3600e3).toISOString();

function session(store: Store, id: string, cwd: string, updated: string, extra: Record<string, unknown> = {}) {
  store.upsertNode(`session:${id}`, "session", `세션 ${id}`, { cwd, lastPrompt: `요청 ${id}`, ...extra }, updated);
  store.upsertNode(`project:${cwd}`, "project", cwd.split("/").at(-1)!, { path: cwd }, updated);
  store.link(`session:${id}`, "in", `project:${cwd}`);
}

test("숨은 폴더(.plans)는 위 폴더로, 레포 안 폴더는 바깥 폴더로 합치고, 서버가 다르면 합치지 않으며, 서버 홈은 바깥으로 치지 않는다", async () => {
  const store = new Store(":memory:");
  session(store, "a", "pacl-205:/home/user/reo/dp", ago(30), { branch: "main" });
  session(store, "b", "pacl-205:/home/user/reo/dp/.plans/2026-10-07-B", ago(5));
  session(store, "c", "pacl-205:/home/user/reo/dp/sub/dir", ago(2), { branch: "feat" });
  session(store, "d", "pacl-208:/home/user/reo/dp", ago(1));
  session(store, "f", "pacl-205:/home/user", ago(40));
  session(store, "g", "/code/app", ago(3));
  session(store, "h", "/code/app/desktop", ago(1));
  const repos: RepoActivity[] = [
    { path: "/code/app", name: "app", branch: "main", commitsToday: [{ sha: "a1", subject: "x", time: ago(2) }], recentCommits: [{ sha: "a1", subject: "x", time: ago(2) }, { sha: "a0", subject: "y", time: ago(50) }] },
    { path: "/code/app/desktop", name: "desktop", commitsToday: [{ sha: "d1", subject: "z", time: ago(0.2) }], recentCommits: [{ sha: "d1", subject: "z", time: ago(0.2) }, { sha: "a1", subject: "x", time: ago(2) }] },
  ];
  const d = await buildDashboard(loadConfig(), store, { now, git: async () => repos });
  assert.deepEqual(d.projects.map((p) => p.path).sort(), ["/code/app", "pacl-205:/home/user", "pacl-205:/home/user/reo/dp", "pacl-208:/home/user/reo/dp"]);
  const dp = d.projects.find((p) => p.path === "pacl-205:/home/user/reo/dp")!;
  assert.equal(dp.name, "dp");
  assert.equal(dp.sessions24h, 2); // b · c (a 는 30시간 전)
  assert.equal(dp.lastTitle, "세션 c");
  assert.equal(dp.branch, "feat");
  assert.equal(d.projects.find((p) => p.path === "pacl-208:/home/user/reo/dp")!.sessions24h, 1);
  const app = d.projects.find((p) => p.path === "/code/app")!;
  assert.equal(app.sessions24h, 2);
  assert.equal(app.commitsToday, 2);
  assert.deepEqual(app.recentCommits.map((c) => c.sha), ["d1", "a1", "a0"]);
  assert.equal(app.name, "app");
});

test("Claude 워크트리는 본 레포로 합치고, 합쳐진 바깥 폴더를 숨기면 줄도 숨는다", async () => {
  const store = new Store(":memory:");
  session(store, "a", "srv:/work/proj", ago(3));
  session(store, "b", "srv:/work/proj/.claude/worktrees/x/src", ago(1));
  store.hideProject("srv:/work/proj", "proj");
  const d = await buildDashboard(loadConfig(), store, { now, git: async () => [] });
  assert.deepEqual(d.projects.map((p) => [p.path, p.hidden, p.sessions24h]), [["srv:/work/proj", true, 2]]);
});

test("서버 이름을 나중에 알게 된 세션은 옛 접두 없는 프로젝트 줄에 또 세지 않는다", async () => {
  const store = new Store(":memory:");
  session(store, "a", "pacl-reo:/home/reo/dp", ago(1));
  store.upsertNode("project:/home/reo/dp", "project", "dp", { path: "/home/reo/dp" }, ago(1));
  store.link("session:a", "in", "project:/home/reo/dp");
  const d = await buildDashboard(loadConfig(), store, { now, git: async () => [] });
  assert.deepEqual(d.projects.map((p) => [p.path, p.sessions24h]), [["pacl-reo:/home/reo/dp", 1]]);
});

test("gitRootOf: 가장 가까운 .git 이 든 조상, 없으면 그대로", () => {
  const base = mkdtempSync(join(tmpdir(), "gitroot-"));
  mkdirSync(join(base, "repo", ".git"), { recursive: true });
  mkdirSync(join(base, "repo", "a", "b"), { recursive: true });
  mkdirSync(join(base, "repo", "inner", ".git"), { recursive: true });
  mkdirSync(join(base, "plain", "x"), { recursive: true });
  assert.equal(gitRootOf(join(base, "repo", "a", "b")), join(base, "repo"));
  assert.equal(gitRootOf(join(base, "repo", "inner")), join(base, "repo", "inner"));
  assert.equal(gitRootOf(join(base, "plain", "x")), join(base, "plain", "x"));
});
