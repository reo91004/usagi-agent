// Codex 작업 기록 동기화: 가짜 ~/.codex/sessions 의 rollout JSONL 에서 터미널 턴만 붙인다(진짜 Codex·진짜 홈 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliSync, convertCodex, findCodexFile } from "./cli-sync.ts";
import { RunRegistry } from "./runs.ts";
import { Store } from "./store.ts";

const ID = "01a14968-951c-73d1-82c6-8713f41bb325";
const item = (turn: string, it: object, at = "2026-10-17T10:00:00Z") => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "item_completed", turn_id: turn, item: it } });
const started = (turn: string, trigger: string) => JSON.stringify({ timestamp: "2026-10-17T10:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: turn, turn_attribution: { turn_trigger: trigger } } });
const user = (t: string) => ({ type: "UserMessage", id: "u", content: [{ type: "text", text: t }] });
const agent = (t: string, phase = "final_answer") => ({ type: "AgentMessage", id: "a", content: [{ type: "Text", text: t }], phase });
const cmd = (id: string, c: string, code = 0) => ({ type: "CommandExecution", id, command: ["/bin/zsh", "-lc", c], aggregated_output: "out", exit_code: code });

test("Codex 동기화: 데몬 exec 턴은 건너뛰고 터미널 턴만 · 다시 불러도 겹치지 않음 · 다음 턴만 추가", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-codex-sync-"));
  const day = join(dir, "2026", "10", "17");
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-10-17T19-29-13-${ID}.jsonl`);
  writeFileSync(file, [
    started("t1", "exec"), item("t1", user("데몬 질문")), item("t1", agent("데몬 답")),
    started("t2", "user"), item("t2", user("터미널에서 물어봄 token=abcdef1234567890")), item("t2", agent("확인 중", "commentary")),
    item("t2", cmd("c1", "npm test", 1)), item("t2", { type: "Reasoning", id: "r" }), item("t2", agent("끝났어요")),
  ].join("\n") + "\n");
  assert.equal(findCodexFile(dir, ID), file);
  assert.equal(findCodexFile(dir, "nope-nope-nope"), undefined);

  const store = new Store(":memory:");
  const reg = new RunRegistry(store.db);
  const thread = store.createThread({ title: "codex 대화" });
  const run = reg.startRun({ kind: "chat", title: "에이전트", ref: thread.id, origin: { type: "thread", threadId: thread.id } });
  run.setSession(`codex:${ID}`);
  run.end("done");
  const sync = new CliSync({ runs: reg, db: store.db, store, codexDir: dir });
  const before = reg.getRun(run.id)!.events.length;

  const r = sync.sync(run.id);
  assert.equal(r.ok, true);
  const evs = reg.getRun(run.id)!.events.slice(before);
  assert.deepEqual(evs.map((e) => e.type), ["system", "user", "tool_use", "tool_result", "assistant"]);
  assert.ok(evs.every((e) => e.via === "cli"));
  assert.equal(evs[2].input, "npm test");
  assert.equal(evs[3].isError, true);
  assert.ok(!evs.some((e) => /데몬/.test(e.text ?? "")));
  assert.deepEqual(store.threadMessages(thread.id).map((m) => [m.role, m.via]), [["user", "cli"], ["assistant", "cli"]]);
  assert.match(store.threadMessages(thread.id)[0].text, /«redacted»/);

  assert.deepEqual(sync.sync(run.id), { ok: true, imported: 0 });
  appendFileSync(file, [started("t3", "user"), item("t3", user("하나 더")), item("t3", agent("네"))].join("\n") + "\n");
  assert.deepEqual(sync.sync(run.id), { ok: true, imported: 2 });
  assert.deepEqual(store.threadMessages(thread.id).slice(-2).map((m) => m.text), ["하나 더", "네"]);

  const lost = reg.startRun({ kind: "chat", title: "x" });
  lost.setSession("codex:99999999-aaaa-bbbb");
  assert.deepEqual(sync.sync(lost.id), { ok: false, status: 404, error: "이 세션 기록을 찾을 수 없어요" });
});

test("convertCodex: 알 수 없는 줄·MCP·추론은 무시", () => {
  const c = convertCodex([{ type: "world_state" }, JSON.parse(item("t", { type: "McpToolCall" })), JSON.parse(item("t", user("안녕")))], new Set());
  assert.deepEqual(c.events.map((e) => e.type), ["user"]);
});
