// 새 Slack → 할 일 가벼운 맥락: 새 글 + 열린 할 일 + 규칙만, 프롬프트 크기 비교
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { thinkPrompt } from "./brain.ts";
import { slackTodoTask } from "./core.ts";

test("light 맥락: 열린 할 일·새 글은 있고 세션·일정·끝낸 일은 없고, 전체 맥락보다 훨씬 작다", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cy-light-")), "t.db"));
  const cfg = loadConfig({});
  const at = new Date().toISOString();
  for (let i = 0; i < 30; i++) store.upsertNode(`session:${i}`, "session", `세션 ${i}`, { cwd: "/p/a", tool: "claude", turns: 9, lastPrompt: "긴 요청 ".repeat(30), lastAssistant: "긴 응답 ".repeat(60) }, at);
  store.addTodo({ key: "slack:C1:1.0", title: "배포 노트 쓰기", source: "slack", priority: 2 } as any);
  const task = slackTodoTask("- [DM] 동준: 입력창이 안 비어요", ["slack:C1:1.1"]);
  const light = thinkPrompt(cfg, store, task, { light: true, scope: "briefing" });
  const full = thinkPrompt(cfg, store, task, { scope: "briefing" });
  console.log(`[slack-todo prompt] full=${full.length} light=${light.length} chars`);
  assert.match(light, /배포 노트 쓰기/);
  assert.match(light, /입력창이 안 비어요/);
  assert.doesNotMatch(light, /최근 48시간 작업 세션|긴 응답/);
  assert.ok(light.length * 3 < full.length);
});
