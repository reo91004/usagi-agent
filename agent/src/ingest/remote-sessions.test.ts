import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../store.ts";
import { scanSessions } from "../kg/chunks.ts";
import { ingestSessions } from "./sessions.ts";
import { checkCmd, listCmd, parseList, remoteSessionDirs, sessionDirs, syncRemoteSessions, type FetchBatch, type Sink } from "./remote-sessions.ts";
import { makeReceiver } from "./slim.ts";
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

// 가짜 서버가 sink 로 바이트를 보낸다(from 뒤부터)
const send = (sink: Sink, rel: string, content: string, from: number, step = Infinity) => {
  const b = Buffer.from(content).subarray(from);
  sink.begin(rel, from);
  for (let i = 0; i < b.length; i += step) sink.data(rel, b.subarray(i, i + step));
};
const cl = (t: string) => JSON.stringify({ type: "user", message: { content: t } }) + "\n"; // 슬림해도 그대로 남는 줄
const cx = JSON.stringify({ type: "turn_context", payload: { cwd: "/x" } }) + "\n";
const sideOf = (root: string, host: string) => JSON.parse(readFileSync(join(root, host, ".slim.json"), "utf8"));

test("syncRemoteSessions: 늘어난 만큼만 받고, 줄었으면 처음부터, 목록에서 빠지면 지운다", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-remote-"));
  const remote = new Map<string, string>([[".claude/projects/p/a.jsonl", cl("a1")], [".codex/sessions/2026/b.jsonl", cx]]);
  const calls: [string, number][] = [];
  let ssh = 0;
  let checks = 0;
  const run = async (a: string[]) => {
    if (a[2].includes("head -c")) { checks++; return [...remote.keys()].filter((r) => a[2].includes(`'${r}'`)).join("\n"); } // 새 파일 검사: 전부 사람 세션
    return [...remote].map(([rel, s]) => `${Buffer.byteLength(s)} ${rel}`).join("\n");
  };
  const fetch: FetchBatch = async (host, items, sink) => {
    assert.equal(host, "gpu1");
    ssh++;
    for (const { rel, from } of items) {
      calls.push([rel, from]);
      send(sink, rel, remote.get(rel)!, from);
    }
  };
  const local = (rel: string) => join(root, "gpu1", rel);
  const sync = () => syncRemoteSessions("gpu1", { run, fetch, root });

  assert.equal(await sync(), 2);
  assert.deepEqual(calls.splice(0), [[".claude/projects/p/a.jsonl", 0], [".codex/sessions/2026/b.jsonl", 0]]);
  assert.equal(ssh, 1); // 바뀐 파일이 둘이어도 받기는 한 번
  assert.equal(checks, 1); // 새 파일 검사도 한 번

  remote.set(".claude/projects/p/a.jsonl", cl("a1") + cl("a2"));
  assert.equal(await sync(), 1);
  assert.deepEqual(calls.splice(0), [[".claude/projects/p/a.jsonl", cl("a1").length]]);
  assert.equal(checks, 1); // 이미 받아 둔 파일은 다시 검사하지 않는다
  assert.equal(readFileSync(local(".claude/projects/p/a.jsonl"), "utf8"), cl("a1") + cl("a2"));

  remote.set(".claude/projects/p/a.jsonl", cl("n"));
  assert.equal(await sync(), 1);
  assert.deepEqual(calls.splice(0), [[".claude/projects/p/a.jsonl", 0]]);
  assert.equal(readFileSync(local(".claude/projects/p/a.jsonl"), "utf8"), cl("n"));

  const emptyList = syncRemoteSessions("gpu1", { run: async () => "", fetch, root });
  assert.equal(await emptyList, 0);
  assert.equal(existsSync(local(".codex/sessions/2026/b.jsonl")), true); // 서버 목록이 통째로 비면 지우지 않는다
  remote.delete(".codex/sessions/2026/b.jsonl");
  assert.equal(await sync(), 0);
  assert.equal(existsSync(local(".codex/sessions/2026/b.jsonl")), false);
  assert.equal(existsSync(local(".claude/projects/p/a.jsonl")), true);
  assert.deepEqual(Object.keys(sideOf(root, "gpu1").files), [".claude/projects/p/a.jsonl"]); // 사이드카도 같이 정리

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
    // 맥 파일은 슬림이라 서버와 다르다. 사이드카의 srv 가 서버 바이트 수와 같으면 한 줄도 빠짐없이 받은 것
    for (const rel of [".codex/sessions/2026/c.jsonl", s1]) assert.equal(sideOf(root, "gpu1").files[rel].srv, statSync(join(home, rel)).size);
    assert.equal(existsSync(join(root, "gpu1", ".claude/projects/-home-me-exp/old.jsonl")), false); // 14일 넘음
    assert.equal(existsSync(join(root, "gpu1", ".claude/projects/-home-me-exp/bad name.jsonl")), false);

    appendFileSync(join(home, s1), line({ type: "user", sessionId: "rs1", timestamp: "2026-10-16T02:00:00Z", message: { content: "다시 돌려줘" } }));
    assert.equal(await syncRemoteSessions("gpu1", { root }), 1);
    assert.equal(sideOf(root, "gpu1").files[s1].srv, statSync(join(home, s1)).size);
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
    if (!c[2].includes("head -c")) return `2 ${rels.h}\n${autoSize} ${rels.a}`;
    seen.push(c[2]);
    return rels.h; // auto 는 서버 검사에서 걸러짐
  };
  const fetch: FetchBatch = async (_h, items, sink) => { for (const i of items) send(sink, i.rel, "x\n", 0); };
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

test("syncRemoteSessions: 조각 사이에서 갈라진 줄과 끝이 안 온 줄 — 줄바꿈까지만 쓰고 나머지는 서버 오프셋부터 다시 받는다", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-recv-"));
  const rel = ".claude/projects/p/a.jsonl";
  const l1 = cl("첫째 줄"), l2 = cl("둘째 줄");
  let remote = l1 + l2.slice(0, 10); // 둘째 줄은 쓰는 중
  const froms: number[] = [];
  const run = async (a: string[]) => (a[2].includes("head -c") ? rel : `${Buffer.byteLength(remote)} ${rel}`);
  const fetch: FetchBatch = async (_h, items, sink) => { froms.push(items[0].from); send(sink, rel, remote, items[0].from, 7); };
  await syncRemoteSessions("g", { run, fetch, root });
  assert.equal(readFileSync(join(root, "g", rel), "utf8"), l1);
  assert.deepEqual(sideOf(root, "g").files[rel], { srv: Buffer.byteLength(l1), loc: Buffer.byteLength(l1) });
  remote = l1 + l2;
  await syncRemoteSessions("g", { run, fetch, root });
  assert.deepEqual(froms, [0, Buffer.byteLength(l1)]);
  assert.equal(readFileSync(join(root, "g", rel), "utf8"), l1 + l2);
});

test("syncRemoteSessions: 서버 파일이 줄면 새 파일로 처음부터(inode 가 바뀐다), 맥 파일이 사이드카보다 크면 자르고 작거나 없으면 처음부터", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-restart-"));
  const rel = ".claude/projects/p/a.jsonl";
  const to = join(root, "g", rel);
  let remote = cl("a") + cl("b") + cl("c");
  const froms: number[] = [];
  const run = async (a: string[]) => (a[2].includes("head -c") ? rel : `${Buffer.byteLength(remote)} ${rel}`);
  const fetch: FetchBatch = async (_h, items, sink) => { froms.push(items[0].from); send(sink, rel, remote, items[0].from); };
  const sync = () => syncRemoteSessions("g", { run, fetch, root });
  await sync();
  const ino = statSync(to).ino;
  remote = cl("z"); // 서버에서 새로 쓴 짧은 파일
  await sync();
  assert.equal(readFileSync(to, "utf8"), cl("z"));
  assert.notEqual(statSync(to).ino, ino);
  assert.deepEqual(froms, [0, 0]);

  appendFileSync(to, "덧붙다 멈춘 흔적\n"); // 덧붙인 뒤 사이드카를 쓰기 전에 죽은 경우
  remote = cl("z") + cl("y");
  await sync();
  assert.equal(readFileSync(to, "utf8"), cl("z") + cl("y"));
  assert.equal(froms[2], Buffer.byteLength(cl("z")));

  writeFileSync(to, cl("z").slice(0, 5)); // 사이드카보다 작아졌다
  remote += cl("x");
  await sync();
  assert.equal(froms[3], 0);
  assert.equal(readFileSync(to, "utf8"), cl("z") + cl("y") + cl("x"));
});

test("syncRemoteSessions: 사이드카가 없으면(슬림 이전 미러 포함) 맥 파일을 믿지 않고 서버에서 0부터 받아 슬림으로 바꾼다", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-noside-"));
  const rel = ".claude/projects/p/a.jsonl";
  const to = join(root, "g", rel);
  const think = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x".repeat(2000) }, { type: "text", text: "답" }] } }) + "\n";
  const remote = cl("질문") + think;
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, remote); // 원본 그대로인 옛 미러(이미 슬림이어도 사이드카가 없으면 구별할 수 없다)
  const slim = (() => { const rx = makeReceiver("claude"); return rx.feed(Buffer.from(remote)) + rx.end(); })();
  const froms: number[] = [];
  const run = async (a: string[]) => (a[2].includes("head -c") ? rel : `${Buffer.byteLength(remote)} ${rel}`);
  const fetch: FetchBatch = async (_h, items, sink) => { froms.push(items[0].from); send(sink, rel, remote, items[0].from); };
  const ino = statSync(to).ino;
  await syncRemoteSessions("g", { run, fetch, root });
  assert.deepEqual(froms, [0]);
  assert.notEqual(statSync(to).ino, ino); // 새 파일로 바꿔 ingest 이어 읽기 표시가 무효가 된다
  assert.equal(readFileSync(to, "utf8"), slim);
  assert.equal(sideOf(root, "g").files[rel].srv, Buffer.byteLength(remote));
  assert.equal(await syncRemoteSessions("g", { run, fetch, root }), 0);
  assert.equal(froms.length, 1);
});

test("syncRemoteSessions: 0부터 다시 받을 파일의 옛 사이드카 값은 받기 전에 지워 둔다(받은 뒤 저장 전에 멈춰도 새 파일을 옛 크기로 자르지 않게)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-stale-"));
  const rel = ".claude/projects/p/a.jsonl";
  const to = join(root, "g", rel);
  let remote = cl("하나") + cl("둘");
  const run = async (a: string[]) => (a[2].includes("head -c") ? rel : `${Buffer.byteLength(remote)} ${rel}`);
  let seen: unknown = "unset";
  const fetch: FetchBatch = async (_h, items, sink) => { seen = existsSync(join(root, "g", ".slim.json")) ? sideOf(root, "g").files[rel] : undefined; send(sink, rel, remote, items[0].from); };
  await syncRemoteSessions("g", { run, fetch, root });
  assert.equal(seen, undefined);
  remote = cl("짧음"); // 서버 파일이 줄었다 → 0부터
  await syncRemoteSessions("g", { run, fetch, root });
  assert.equal(seen, undefined, "받기 시작할 때 디스크의 사이드카에 옛 값이 없어야 한다");
  assert.equal(readFileSync(to, "utf8"), cl("짧음"));
});
