import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeItems, codexItems, sessionChunks } from "../kg/chunks.ts";
import { parseClaudeSession, parseCodexSession } from "./sessions.ts";
import { makeReceiver } from "./slim.ts";

const jl = (...o: object[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
const long = "x".repeat(5000);
const ts = (n: number) => `2026-10-16T01:00:${String(n).padStart(2, "0")}Z`;

// 줄 종류마다 하나씩: 소비자가 읽는 것, 읽지 않는 것(버려져야 하는 것), 시각·cwd 만 바꾸는 것
const CLAUDE = jl(
  { type: "file-history-snapshot", snapshot: { a: long } },
  { type: "user", sessionId: "s1", cwd: "/w/a", gitBranch: "main", timestamp: ts(0), entrypoint: "cli", message: { content: "첫 요청입니다 " + long } },
  { type: "ai-title", aiTitle: "첫 제목", sessionId: "s1" },
  { type: "ai-title", aiTitle: "둘째 제목" },
  { type: "assistant", sessionId: "s1", cwd: "/w/a", timestamp: ts(1), message: { content: [
    { type: "thinking", thinking: long },
    { type: "text", text: "답변 " + long },
    { type: "tool_use", name: "Bash", input: { command: "ls   -la\n" + long, description: "목록", timeout: 5 } },
    { type: "tool_use", name: "Write", input: { file_path: "/w/a/f.py", content: long } },
    { type: "tool_use", name: "Edit", input: { file_path: "/w/a/g.py", old_string: long, new_string: long } },
    { type: "tool_use", name: "WebFetch", input: { url: "https://e.x/" + long } },
  ] } },
  { type: "user", timestamp: ts(2), message: { content: [{ type: "tool_result", tool_use_id: "t", content: long }] } },
  { type: "user", timestamp: ts(3), isMeta: true, message: { content: [{ type: "text", text: "<command-name>/x</command-name>" }, { type: "tool_result", content: "r" }] } },
  { type: "user", timestamp: ts(4), message: { content: [{ type: "text", text: "두 번째 요청" }] } },
  { type: "custom-title", customTitle: "내 제목" },
  { type: "attachment", timestamp: ts(5), cwd: "/w/b", gitBranch: "dev", attachment: { a: long } },
  { type: "system", timestamp: ts(6), subtype: "x" },
);
const CODEX = jl(
  { type: "session_meta", timestamp: ts(0), payload: { id: "c1", cwd: "/w/c", originator: "codex-tui", source: "cli", git: { branch: "main", commit_hash: "abc" }, instructions: long } },
  { type: "event_msg", timestamp: ts(1), payload: { type: "task_started", turn_id: "t1" } },
  { type: "event_msg", timestamp: ts(1), payload: { type: "token_count", info: { a: long } } },
  { type: "turn_context", timestamp: ts(2), payload: { cwd: "/w/d", model: "m", summary: long } },
  { type: "response_item", timestamp: ts(3), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "코덱스 요청 " + long }] } },
  { type: "response_item", timestamp: ts(4), payload: { type: "reasoning", summary: [{ text: long }], encrypted_content: long } },
  { type: "response_item", timestamp: ts(5), payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "ls " + long], workdir: "/w/d" }) } },
  { type: "response_item", timestamp: ts(6), payload: { type: "function_call_output", output: long } },
  { type: "response_item", timestamp: ts(7), payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Add File: /w/d/n.py\n+" + long } },
  { type: "response_item", timestamp: ts(8), payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "코덱스 답변 " + long }] } },
  { type: "response_item", timestamp: ts(9), payload: { type: "local_shell_call", name: "sh", action: { command: ["git", "status"] } } },
  { type: "compacted", timestamp: ts(10), payload: { replacement_history: [long] } },
  { type: "event_msg", timestamp: ts(11), payload: { type: "item_completed", item: { a: long } } },
);

function slim(raw: string, tool: "claude" | "codex") {
  const rx = makeReceiver(tool);
  return rx.feed(Buffer.from(raw)) + rx.end();
}
const lines = (s: string) => s.split("\n").filter(Boolean);
const claudeAll = (l: string[]) => ({
  digest: parseClaudeSession(l, "fb"),
  items: claudeItems(l, "fb"),
  sub: claudeItems(l, "fb", { subagent: true }),
  chunks: sessionChunks(claudeItems(l, "fb"), "g"),
});
const codexAll = (l: string[]) => ({ digest: parseCodexSession(l, "fb"), items: codexItems(l, "fb"), chunks: sessionChunks(codexItems(l, "fb"), "g") });

test("slim: Claude 줄 종류마다 소비자(ingest·KG 항목·청크 id/글)가 원본과 같은 결과를 낸다", () => {
  const out = slim(CLAUDE, "claude");
  assert.deepEqual(claudeAll(lines(out)), claudeAll(lines(CLAUDE)));
  assert.ok(out.length < CLAUDE.length / 2);
  assert.ok(!out.includes("old_string") && !out.includes("thinking") && !out.includes("tool_result"));
  assert.ok(out.includes(long.slice(0, 4000)), "글은 자르지 않는다");
});

test("slim: Codex 줄 종류마다 소비자가 원본과 같은 결과를 낸다", () => {
  const out = slim(CODEX, "codex");
  assert.deepEqual(codexAll(lines(out)), codexAll(lines(CODEX)));
  assert.ok(out.length < CODEX.length / 2);
  assert.ok(!out.includes("Begin Patch") && !out.includes("reasoning") && !out.includes("token_count"));
});

test("receiver: 줄이 조각 사이에서 갈라져도, 끝이 안 온 줄은 쓰지 않고 오프셋은 마지막 줄바꿈까지", () => {
  for (const [raw, tool] of [[CLAUDE, "claude"], [CODEX, "codex"]] as const) {
    const whole = slim(raw, tool);
    const tail = JSON.stringify({ type: "user", message: { content: "끝이 안 온 줄" } }); // 줄바꿈 없음
    const buf = Buffer.from(raw + tail);
    for (const cut of [1, 7, 100, 1001, buf.length >> 1, buf.length - 3]) {
      const rx = makeReceiver(tool);
      const got = rx.feed(buf.subarray(0, cut)) + rx.feed(buf.subarray(cut)) + rx.end();
      assert.equal(got, whole);
      assert.equal(rx.off, Buffer.byteLength(raw));
    }
  }
});

test("receiver: 8MB 넘는 줄은 쌓지 않고 건너뛰되 오프셋은 그 줄까지 센다", () => {
  const rx = makeReceiver("claude");
  const ok = JSON.stringify({ type: "user", message: { content: "다음" } }) + "\n";
  const big = Buffer.alloc((8 << 20) + 10, 120);
  let out = rx.feed(big.subarray(0, 5 << 20)) + rx.feed(big.subarray(5 << 20)); // 줄바꿈 전까지 8MB 를 넘는다
  assert.equal(out, "");
  assert.equal(rx.off, 0);
  out += rx.feed(Buffer.concat([Buffer.from("\n"), Buffer.from(ok)]));
  assert.equal(out, ok);
  assert.equal(rx.off, big.length + 1 + Buffer.byteLength(ok));
});
