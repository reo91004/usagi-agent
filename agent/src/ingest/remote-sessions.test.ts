import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../store.ts";
import { scanSessions } from "../kg/chunks.ts";
import { ingestSessions } from "./sessions.ts";
import { parseList, remoteSessionDirs, sessionDirs, syncRemoteSessions, type FetchBatch } from "./remote-sessions.ts";

test("parseList: 정해진 두 폴더 아래 셸에 안전한 .jsonl 만, wc 의 total 줄은 뺀다", () => {
  const out = [
    "  120 .claude/projects/-home-me-exp/s1.jsonl",
    "7 .codex/sessions/2026/10/16/rollout-2026-10-16T01-02-03-abc.jsonl",
    "  127 total",
    "5 .claude/projects/../../.ssh/id_rsa.jsonl",
    "5 .claude/projects/x/a b.jsonl",
    "5 .claude/projects/x/$(id).jsonl",
    "5 .claude/projects/x/'q'.jsonl",
    "5 .config/other.jsonl",
    "5 .claude/projects/x/notes.txt",
    "",
  ].join("\n");
  assert.deepEqual(parseList(out), [
    { rel: ".claude/projects/-home-me-exp/s1.jsonl", size: 120 },
    { rel: ".codex/sessions/2026/10/16/rollout-2026-10-16T01-02-03-abc.jsonl", size: 7 },
  ]);
});

test("sessionDirs: 이 맥 다음에 받아 둔 서버마다", () => {
  const dirs = sessionDirs({ claudeProjectsDir: "/c", codexSessionsDir: "/x", sessionHosts: ["gpu1"] }, "/r");
  assert.deepEqual(dirs, [
    { claude: "/c", codex: "/x", host: undefined },
    { claude: "/r/gpu1/.claude/projects", codex: "/r/gpu1/.codex/sessions", host: "gpu1" },
  ]);
});

test("syncRemoteSessions: 늘어난 만큼만 받고, 줄었으면 처음부터, 목록에서 빠지면 지운다", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-remote-"));
  const remote = new Map<string, string>([[".claude/projects/p/a.jsonl", "a1\n"], [".codex/sessions/2026/b.jsonl", "b1\n"]]);
  const calls: [string, number][] = [];
  let ssh = 0;
  const run = async () => [...remote].map(([rel, s]) => `${Buffer.byteLength(s)} ${rel}`).join("\n");
  const fetch: FetchBatch = async (host, items) => {
    assert.equal(host, "gpu1");
    ssh++;
    for (const { rel, from, to } of items) {
      calls.push([rel, from]);
      const bytes = Buffer.from(remote.get(rel)!).subarray(from);
      if (from) appendFileSync(to, bytes); else writeFileSync(to, bytes);
    }
  };
  const local = (rel: string) => join(root, "gpu1", rel);
  const sync = () => syncRemoteSessions("gpu1", { run, fetch, root });

  assert.equal(await sync(), 2);
  assert.deepEqual(calls.splice(0), [[".claude/projects/p/a.jsonl", 0], [".codex/sessions/2026/b.jsonl", 0]]);
  assert.equal(ssh, 1); // 바뀐 파일이 둘이어도 받기는 한 번

  remote.set(".claude/projects/p/a.jsonl", "a1\na2\n");
  assert.equal(await sync(), 1);
  assert.deepEqual(calls.splice(0), [[".claude/projects/p/a.jsonl", 3]]);
  assert.equal(readFileSync(local(".claude/projects/p/a.jsonl"), "utf8"), "a1\na2\n");

  remote.set(".claude/projects/p/a.jsonl", "new\n");
  assert.equal(await sync(), 1);
  assert.deepEqual(calls.splice(0), [[".claude/projects/p/a.jsonl", 0]]);
  assert.equal(readFileSync(local(".claude/projects/p/a.jsonl"), "utf8"), "new\n");

  remote.delete(".codex/sessions/2026/b.jsonl");
  assert.equal(await sync(), 0);
  assert.equal(existsSync(local(".codex/sessions/2026/b.jsonl")), false);
  assert.equal(existsSync(local(".claude/projects/p/a.jsonl")), true);

  await assert.rejects(syncRemoteSessions("-oProxyCommand=sh", { run, fetch, root }), /sessionHosts/);
});

test("syncRemoteSessions: 실제 find·wc·tail 명령(가짜 ssh 가 서버 홈에서 sh -c) → 서버 이름 붙은 세션", async () => {
  const base = mkdtempSync(join(tmpdir(), "cy-remote-sh-"));
  const home = join(base, "server-home");
  const bin = join(base, "bin");
  mkdirSync(bin);
  // ssh 옵션·「--」·서버 이름을 건너뛰고 나머지를 서버 홈에서 실행한다(진짜 ssh 처럼 인자를 공백으로 이어 sh -c)
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\ncd "${home}" && HOME="${home}" exec sh -c "$*"\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  const put = (rel: string, s: string) => { mkdirSync(dirname(join(home, rel)), { recursive: true }); writeFileSync(join(home, rel), s); };
  const line = (o: object) => JSON.stringify(o) + "\n";
  const s1 = ".claude/projects/-home-me-exp/s1.jsonl";
  put(s1, line({ type: "user", sessionId: "rs1", cwd: "/home/me/exp", timestamp: "2026-10-16T01:00:00Z", message: { content: "학습 스크립트 고쳐줘" } }));
  put(".claude/projects/-home-me-exp/old.jsonl", line({ type: "user", sessionId: "old", cwd: "/home/me/exp", message: { content: "옛날" } }));
  utimesSync(join(home, ".claude/projects/-home-me-exp/old.jsonl"), new Date(Date.now() - 30 * 864e5), new Date(Date.now() - 30 * 864e5));
  put(".claude/projects/-home-me-exp/bad name.jsonl", line({ type: "user", sessionId: "bad", message: { content: "x" } }));
  put(".claude/projects/-home-me-exp/notes.txt", "x");

  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const root = join(base, "local");
    assert.equal(await syncRemoteSessions("gpu1", { root }), 1);
    put(".codex/sessions/2026/c.jsonl", line({ type: "x" }) + line({ type: "y" }));
    appendFileSync(join(home, s1), line({ type: "user", sessionId: "rs1", message: { content: "셋째" } }));
    assert.equal(await syncRemoteSessions("gpu1", { root }), 2); // c 새로 + s1 이어서 — 한 ssh 로 섞어 받아도 각자 맞다
    for (const rel of [".codex/sessions/2026/c.jsonl", s1]) assert.equal(readFileSync(join(root, "gpu1", rel), "utf8"), readFileSync(join(home, rel), "utf8"));
    const got = join(root, "gpu1", s1);
    assert.equal(readFileSync(got, "utf8"), readFileSync(join(home, s1), "utf8"));
    assert.equal(existsSync(join(root, "gpu1", ".claude/projects/-home-me-exp/old.jsonl")), false); // 14일 넘음
    assert.equal(existsSync(join(root, "gpu1", ".claude/projects/-home-me-exp/bad name.jsonl")), false);

    appendFileSync(join(home, s1), line({ type: "user", sessionId: "rs1", timestamp: "2026-10-16T02:00:00Z", message: { content: "다시 돌려줘" } }));
    assert.equal(await syncRemoteSessions("gpu1", { root }), 1);
    assert.equal(readFileSync(got, "utf8"), readFileSync(join(home, s1), "utf8"));
    assert.equal(await syncRemoteSessions("gpu1", { root }), 0);

    const store = new Store(":memory:");
    assert.equal(ingestSessions(store, remoteSessionDirs("gpu1", root), { host: "gpu1" }), 1);
    const node = store.node("session:rs1")!;
    assert.equal(node.props.cwd, "gpu1:/home/me/exp");
    assert.equal(node.props.turns, 3);
    assert.deepEqual(store.neighbors("session:rs1", "in"), ["project:gpu1:/home/me/exp"]);
    await scanSessions(store, remoteSessionDirs("gpu1", root), { host: "gpu1" });
    const chunk = store.db.prepare("SELECT label, meta FROM kg_chunks WHERE source = 'sessions'").get() as any;
    assert.match(chunk.label, /gpu1:\/home\/me\/exp/);
    assert.equal(JSON.parse(chunk.meta).cwd, "gpu1:/home/me/exp");
  } finally {
    process.env.PATH = path;
  }
});
