import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../store.ts";
import { scanSessions } from "../kg/chunks.ts";
import { ingestSessions } from "./sessions.ts";
import { checkCmd, listCmd, parseList, remoteSessionDirs, sessionDirs, syncRemoteSessions, type FetchBatch } from "./remote-sessions.ts";
import { execFileSync } from "node:child_process";

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
  let checks = 0;
  const run = async (a: string[]) => {
    if (a[2].includes("head -c")) { checks++; return [...remote.keys()].filter((r) => a[2].includes(`'${r}'`)).join("\n"); } // 새 파일 검사: 전부 사람 세션
    return [...remote].map(([rel, s]) => `${Buffer.byteLength(s)} ${rel}`).join("\n");
  };
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
  assert.equal(checks, 1); // 새 파일 검사도 한 번

  remote.set(".claude/projects/p/a.jsonl", "a1\na2\n");
  assert.equal(await sync(), 1);
  assert.deepEqual(calls.splice(0), [[".claude/projects/p/a.jsonl", 3]]);
  assert.equal(checks, 1); // 이미 받아 둔 파일은 다시 검사하지 않는다
  assert.equal(readFileSync(local(".claude/projects/p/a.jsonl"), "utf8"), "a1\na2\n");

  remote.set(".claude/projects/p/a.jsonl", "new\n");
  assert.equal(await sync(), 1);
  assert.deepEqual(calls.splice(0), [[".claude/projects/p/a.jsonl", 0]]);
  assert.equal(readFileSync(local(".claude/projects/p/a.jsonl"), "utf8"), "new\n");

  const emptyList = syncRemoteSessions("gpu1", { run: async () => "", fetch, root });
  assert.equal(await emptyList, 0);
  assert.equal(existsSync(local(".codex/sessions/2026/b.jsonl")), true); // 서버 목록이 통째로 비면 지우지 않는다
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

test("listCmd: 공용 계정은 cwd 가 내 폴더나 그 아래인 기록만 낸다(진짜 sh·find·grep 으로)", () => {
  const home = mkdtempSync(join(tmpdir(), "cy-shared-"));
  const put = (rel: string, ...lines: object[]) => {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  put(".claude/projects/-h-reo-a/mine.jsonl", { type: "user", cwd: `${home}/reo/a` });
  put(".claude/projects/-h/moved.jsonl", { type: "ai-title", aiTitle: "x".repeat(70_000) }, { type: "user", cwd: home }, { type: "user", cwd: `${home}/reo` }); // 홈에서 시작해 옮겨 감
  put(".claude/projects/-h-reo2/other.jsonl", { type: "user", cwd: `${home}/reo2` }); // 이름만 비슷한 남의 폴더
  put(".claude/projects/-h/home.jsonl", { type: "user", cwd: home });
  put(".codex/sessions/2026/10/17/rollout-a.jsonl", { type: "session_meta", payload: { cwd: `${home}/reo/b` } });
  put(".codex/sessions/2026/10/17/rollout-b.jsonl", { type: "session_meta", payload: { cwd: `${home}/jo` } });
  // 프로그램이 돌린 세션은 내 폴더 것이어도 받지 않는다
  put(".codex/sessions/2026/10/17/rollout-exec.jsonl", { type: "session_meta", payload: { cwd: `${home}/reo/b`, originator: "codex_exec", source: "exec" } });
  put(".codex/sessions/2026/10/17/rollout-sub.jsonl", { type: "session_meta", payload: { cwd: `${home}/reo/b`, originator: "codex-tui", source: { subagent: { thread_spawn: {} } } } });
  put(".claude/projects/-h-reo-a/sdk.jsonl", { type: "user", cwd: `${home}/reo/a`, entrypoint: "sdk-cli" });
  const sh = (c: string) => execFileSync("sh", ["-c", c], { env: { ...process.env, HOME: home } }).toString();
  const list = (mine?: string) => {
    const rels = parseList(sh(listCmd())).map((f) => f.rel);
    return sh(checkCmd(rels, mine)).split("\n").filter(Boolean).sort();
  };
  assert.deepEqual(list("~/reo"), [".claude/projects/-h-reo-a/mine.jsonl", ".claude/projects/-h/moved.jsonl", ".codex/sessions/2026/10/17/rollout-a.jsonl"]);
  assert.deepEqual(list(`${home}/reo`), list("~/reo")); // 절대 경로로 적어도 같다
  assert.equal(list().length, 6); // 개인 계정은 남의 폴더도 받되, 프로그램이 돌린 세션 셋은 빼고
});

test("syncRemoteSessions: 거른 파일(프로그램 세션)은 판정을 기록해 다시 검사하지 않고, 두 배 넘게 자라면 다시 본다", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-judged-"));
  const rels = { h: ".claude/projects/p/h.jsonl", a: ".claude/projects/p/auto.jsonl" };
  let autoSize = 100;
  const seen: string[] = [];
  const run = async (c: string[]) => {
    if (!c[2].includes("head -c")) return `1 ${rels.h}\n${autoSize} ${rels.a}`;
    seen.push(c[2]);
    return rels.h; // auto 는 서버 검사에서 걸러짐
  };
  const fetch: FetchBatch = async (_h, items) => { for (const i of items) writeFileSync(i.to, "x"); };
  assert.equal(await syncRemoteSessions("g", { run, fetch, root }), 1);
  assert.equal(seen.length, 1);
  assert.equal(await syncRemoteSessions("g", { run, fetch, root }), 0);
  assert.equal(seen.length, 1); // 사람 세션(맥에 있음)·프로그램 세션(기록됨) 모두 다시 검사하지 않음
  autoSize = 250;
  await syncRemoteSessions("g", { run, fetch, root });
  assert.equal(seen.length, 2);
  assert.ok(seen[1].includes("auto.jsonl") && !seen[1].includes("h.jsonl"));
  writeFileSync(join(root, "g", ".judged.json"), "{깨짐"); // 깨진 기록은 처음부터 다시 판정(동기화는 멈추지 않는다)
  await syncRemoteSessions("g", { run, fetch, root });
  assert.equal(seen.length, 3);
  await syncRemoteSessions("g", { run, fetch, root, mine: "~/reo" }); // 공용 계정 내 폴더가 바뀌면 다시 판정
  assert.equal(seen.length, 4);
});

test("syncRemoteSessions: 공용 계정 이름이 이상하면 ssh 전에 멈춘다", async () => {
  let ssh = 0;
  await assert.rejects(syncRemoteSessions("gpu1", { run: async () => { ssh++; return ""; }, mine: "~/reo'; rm -rf ~" }), /jobDirs/);
  assert.equal(ssh, 0);
});
