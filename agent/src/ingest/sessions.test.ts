import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.ts";
import { ingestSessions, parseClaudeSession, parseCodexSession, readLines } from "./sessions.ts";

const claudeLines = [
  { type: "user", sessionId: "s1", cwd: "/r/app", gitBranch: "main", timestamp: "2026-10-08T01:00:00Z", message: { content: "버튼 색 바꿔줘" } },
  { type: "user", sessionId: "s1", timestamp: "2026-10-08T01:00:01Z", message: { content: [{ type: "tool_result", content: "x" }] } },
  { type: "user", sessionId: "s1", timestamp: "2026-10-08T01:00:02Z", message: { content: "<command-name>/clear</command-name>" } },
  { type: "assistant", sessionId: "s1", timestamp: "2026-10-08T01:01:00Z", message: { content: [
    { type: "tool_use", name: "Edit", input: { file_path: "/r/app/page.tsx" } },
    { type: "text", text: "바꿨어" },
  ] } },
  { type: "ai-title", aiTitle: "버튼 색 변경", sessionId: "s1" },
].map((l) => JSON.stringify(l)).join("\n");

test("claude 세션: 사람 프롬프트·제목·수정 파일만 뽑는다", () => {
  const s = parseClaudeSession(claudeLines, "fallback")!;
  assert.equal(s.id, "s1");
  assert.equal(s.title, "버튼 색 변경");
  assert.equal(s.turns, 1);
  assert.equal(s.firstPrompt, "버튼 색 바꿔줘");
  assert.equal(s.lastAssistant, "바꿨어");
  assert.deepEqual(s.files, ["/r/app/page.tsx"]);
  assert.equal(s.ended, "2026-10-08T01:01:00Z");
});

test("codex 세션: AGENTS 주입문은 프롬프트로 치지 않는다", () => {
  const raw = [
    { type: "session_meta", timestamp: "2026-09-22T01:00:00Z", payload: { id: "c1", cwd: "/r/meet" } },
    { type: "response_item", timestamp: "2026-09-22T01:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /r/meet" }] } },
    { type: "response_item", timestamp: "2026-09-22T01:00:02Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "mcp 구조 파악해봐" }] } },
    { type: "response_item", timestamp: "2026-09-22T01:00:03Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "봤어" }] } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const s = parseCodexSession(raw, "x")!;
  assert.equal(s.id, "c1");
  assert.equal(s.cwd, "/r/meet");
  assert.equal(s.turns, 1);
  assert.equal(s.firstPrompt, "mcp 구조 파악해봐");
});

test("ingestSessions: 그래프에 반영하고 안 바뀐 파일은 건너뛴다", () => {
  const root = mkdtempSync(join(tmpdir(), "cy-"));
  mkdirSync(join(root, "claude", "-r-app"), { recursive: true });
  writeFileSync(join(root, "claude", "-r-app", "s1.jsonl"), claudeLines);
  const store = new Store(":memory:");
  const dirs = { claude: join(root, "claude"), codex: join(root, "codex") };
  assert.equal(ingestSessions(store, dirs), 1);
  assert.equal(ingestSessions(store, dirs), 0);
  assert.equal(store.node("session:s1")?.label, "버튼 색 변경");
  assert.deepEqual(store.neighbors("session:s1", "in"), ["project:/r/app"]);
  assert.deepEqual(store.neighbors("session:s1", "edited"), ["file:/r/app/page.tsx"]);
  assert.equal(store.search("버튼")[0].id, "session:s1");
});

test("isCyAgentCwd: 이 설치와 같은 맥의 다른 시사 설치 폴더 세션은 뺀다", async () => {
  const { isCyAgentCwd } = await import("./sessions.ts");
  assert.equal(isCyAgentCwd("/h/.cy-agent-test/brain", "/h/.cy-agent-test", "/h"), true);
  assert.equal(isCyAgentCwd("/h/.cy-agent/brain", "/h/.cy-agent-test", "/h"), true); // 다른 설치
  assert.equal(isCyAgentCwd("/h/.cy-agent/worktrees/app-1", undefined, "/h"), true);
  assert.equal(isCyAgentCwd("/h/code/app", "/h/.cy-agent", "/h"), false);
  assert.equal(isCyAgentCwd(undefined, "/h/.cy-agent", "/h"), false);
});

test("readLines: 1MB 경계를 넘는 줄도 한 줄로, 마지막 줄바꿈이 없어도", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-lines-"));
  const p = join(dir, "s.jsonl");
  const long = "가".repeat(700_000); // 2.1MB
  writeFileSync(p, `a\n${long}\n\nb`);
  assert.deepEqual([...readLines(p)].map((l) => l.length), [1, long.length, 0, 1]);
  assert.equal([...readLines(p)][1], long);
  rmSync(dir, { recursive: true, force: true });
});

test("ingestSessions: subagents 폴더는 들어가지 않는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-sub-"));
  const line = (id: string) => JSON.stringify({ type: "user", sessionId: id, cwd: "/w", message: { content: "안녕" } }) + "\n";
  mkdirSync(join(dir, "p", "s1", "subagents"), { recursive: true });
  writeFileSync(join(dir, "p", "s1.jsonl"), line("s1"));
  writeFileSync(join(dir, "p", "s1", "subagents", "agent-a.jsonl"), line("sub"));
  const store = new Store(":memory:");
  assert.equal(ingestSessions(store, { claude: dir, codex: join(dir, "none") }), 1);
  assert.ok(store.node("session:s1"));
  assert.equal(store.node("session:sub"), undefined);
});

// 증분 읽기: 파일을 임의 바이트 지점(줄 중간·UTF-8 글자 중간 포함)에서 나눠 덧붙여 가며 수집해도 한 번에 파싱한 것과 같다
const codexLines = [
  { type: "session_meta", timestamp: "2026-10-08T01:00:00Z", payload: { id: "c9", cwd: "/r/x", git: { branch: "dev" } } },
  { type: "response_item", timestamp: "2026-10-08T01:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "첫 요청 🐰" }] } },
  { type: "turn_context", timestamp: "2026-10-08T01:00:02Z", payload: { cwd: "/r/y" } },
  { type: "response_item", timestamp: "2026-10-08T01:00:03Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "했어요" }] } },
  { type: "response_item", timestamp: "2026-10-08T01:00:04Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "둘째 요청" }] } },
].map((l) => JSON.stringify(l)).join("\n");

for (const [tool, raw, parse] of [["claude", claudeLines + "\n" + JSON.stringify({ type: "user", cwd: "/r/app2", timestamp: "2026-10-08T02:00:00Z", message: { content: "다음 일 🐰" } }), parseClaudeSession], ["codex", codexLines, parseCodexSession]] as const) {
  test(`ingestSessions 증분(${tool}): 아무 바이트 지점에서 나눠 읽어도 한 번에 읽은 것과 같다`, () => {
    const bytes = Buffer.from(raw, "utf8"); // 마지막 줄은 줄바꿈 없이 끝난다
    const want = parse(raw, "f")!;
    const dir = mkdtempSync(join(tmpdir(), "cy-inc-"));
    for (let cut = 1; cut < bytes.length; cut += 7) {
      mkdirSync(join(dir, "c", "p"), { recursive: true });
      const path = join(dir, "c", "p", "f.jsonl");
      const dirs = tool === "claude" ? { claude: join(dir, "c"), codex: join(dir, "none") } : { claude: join(dir, "none"), codex: join(dir, "c") };
      const store = new Store(":memory:");
      writeFileSync(path, bytes.subarray(0, cut));
      ingestSessions(store, dirs);
      appendFileSync(path, bytes.subarray(cut));
      utimesSync(path, new Date(), new Date(Date.now() + cut * 1000)); // 같은 ms 안에 쓴 파일도 바뀐 것으로
      ingestSessions(store, dirs);
      const ref = new Store(":memory:");
      rmSync(join(dir, "c"), { recursive: true });
      mkdirSync(join(dir, "c", "p"), { recursive: true });
      writeFileSync(path, bytes);
      ingestSessions(ref, dirs);
      for (const id of [`session:${want.id}`, `project:${want.cwd}`]) {
        assert.deepEqual(store.node(id)?.props, ref.node(id)?.props, `cut=${cut} ${id}`);
        assert.equal(store.node(id)?.label, ref.node(id)?.label);
      }
      assert.deepEqual(store.neighbors(`session:${want.id}`, "edited"), ref.neighbors(`session:${want.id}`, "edited"));
      assert.equal(ref.node(`session:${want.id}`)?.props.turns, want.turns);
      rmSync(join(dir, "c"), { recursive: true });
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

test("ingestSessions 증분: 늘어난 부분만 읽고, 줄었거나 앞이 바뀐 파일은 처음부터 다시 읽는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-shrink-"));
  mkdirSync(join(dir, "p"), { recursive: true });
  const path = join(dir, "p", "s1.jsonl");
  const u = (id: string, text: string) => JSON.stringify({ type: "user", sessionId: id, cwd: "/w", timestamp: "2026-10-08T01:00:00Z", message: { content: text } }) + "\n";
  const store = new Store(":memory:");
  const dirs = { claude: dir, codex: join(dir, "none") };
  const bump = (n: number) => utimesSync(path, new Date(), new Date(Date.now() + n * 1000));
  writeFileSync(path, u("s1", "하나") + u("s1", "둘"));
  ingestSessions(store, dirs);
  assert.equal(store.node("session:s1")?.props.turns, 2);
  // 늘어남: 저장된 위치 이후만 읽는다 — 앞 부분을 같은 길이의 다른 글로 바꿔도(해시가 같지 않으면 다시 읽음) 이어 읽기만 확인하려면 뒤만 덧붙인다
  appendFileSync(path, u("s1", "셋")); bump(1);
  ingestSessions(store, dirs);
  assert.equal(store.node("session:s1")?.props.turns, 3);
  // 줄어듦(교체): 처음부터
  writeFileSync(path, u("s1", "새것")); bump(2);
  ingestSessions(store, dirs);
  assert.equal(store.node("session:s1")?.props.turns, 1);
  assert.equal(store.node("session:s1")?.props.firstPrompt, "새것");
  // 더 길어졌지만 다른 파일(앞 256바이트가 다름): 처음부터
  writeFileSync(path, u("s1", "다른 파일 ".repeat(30)) + u("s1", "하나 더")); bump(3);
  ingestSessions(store, dirs);
  assert.equal(store.node("session:s1")?.props.turns, 2);
  assert.match(String(store.node("session:s1")?.props.firstPrompt), /^다른 파일/);
  // 앞은 같고 읽은 자리 바로 앞이 바뀐 채 길어짐: 처음부터
  const head = u("s1", "다른 파일 ".repeat(30));
  writeFileSync(path, head + u("s1", "바뀐 둘째") + u("s1", "셋째")); bump(4);
  ingestSessions(store, dirs);
  assert.equal(store.node("session:s1")?.props.turns, 3);
  assert.equal(store.node("session:s1")?.props.lastPrompt, "셋째");
  // 새 파일로 바꿔 끼움(inode 다름), 내용은 앞부분이 같고 더 김: 처음부터
  const tmp = join(dir, "new.tmp");
  writeFileSync(tmp, head + u("s1", "바뀐 둘째") + u("s1", "셋째") + u("s1", "넷째"));
  renameSync(tmp, path); bump(5);
  ingestSessions(store, dirs);
  assert.equal(store.node("session:s1")?.props.turns, 4);
  // 저장된 상태가 다른 접는 규칙(버전)의 것이면 처음부터: 틀린 중간 상태를 이어 쌓지 않는다
  const st = JSON.parse(store.stateOf(path)!);
  store.setState(path, JSON.stringify({ ...st, v: -1, fold: { ...st.fold, turns: 99 } }));
  appendFileSync(path, u("s1", "다섯째")); bump(6);
  ingestSessions(store, dirs);
  assert.equal(store.node("session:s1")?.props.turns, 5);
  rmSync(dir, { recursive: true, force: true });
});
