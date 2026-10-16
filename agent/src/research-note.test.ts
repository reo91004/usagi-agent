import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { collectDay, formatDay, noteMarkdown, notePath, plain, writeNote, type DayNote } from "./research-note.ts";

const cfg = { repoRoots: [], gitAuthor: { name: "me", email: "me@x" }, onboarded: true, readSessions: true };
const at = (hm: string) => new Date(`2026-10-17T${hm}:00+09:00`).toISOString(); // 테스트는 TZ=Asia/Seoul

test("formatDay: Logseq 저널 제목 형식(기본 MMM do, yyyy)", () => {
  assert.equal(formatDay("2026-10-17", "MMM do, yyyy"), "Oct 17th, 2026");
  assert.equal(formatDay("2026-10-01", "MMM do, yyyy"), "Oct 1st, 2026");
  assert.equal(formatDay("2026-10-12", "MMM do, yyyy"), "Oct 12th, 2026");
  assert.equal(formatDay("2026-10-23", "MMM do, yyyy"), "Oct 23rd, 2026");
  assert.equal(formatDay("2026-03-05", "yyyy-MM-dd EEEE"), "2026-03-05 Thursday");
  assert.equal(formatDay("2026-03-05", "yyyy_MM_dd"), "2026_03_05");
});

test("plain: 한 줄로, 링크·임베드·매크로·태그 문법은 살지 않게", () => {
  assert.equal(plain("a\n  [[page]] ((uuid)) {{embed}} #tag"), "a [ [page] ] ( (uuid) ) { {embed} } ＃tag");
  assert.equal(plain("x".repeat(10), 5), "xxxx…");
});

test("collectDay: 그날 세션(숨긴·임시 폴더 빼고)·긴 작업·끝낸 할 일(다시 연 건 빼고)·집중·커밋", async () => {
  const store = new Store(":memory:");
  store.upsertNode("session:a", "session", "학습 스크립트 고치기", { tool: "claude", cwd: "gpu1:/home/me/exp", turns: 3, lastPrompt: "다시 돌려줘" }, at("10:00"));
  store.upsertNode("session:b", "session", "어제 것", { tool: "codex", cwd: "/r/app", turns: 1 }, new Date("2026-10-16T14:00:00Z").toISOString()); // 16일 23시 KST
  store.upsertNode("session:c", "session", "숨김", { tool: "claude", cwd: "/secret/x", turns: 1 }, at("11:00"));
  store.hideProject("/secret", "secret");
  store.upsertNode("session:d", "session", "임시 폴더", { tool: "claude", cwd: "/private/tmp/x", turns: 1 }, at("11:30"));
  store.upsertNode("job:1", "job", "resnet 학습", { seconds: 3725, code: 0, host: "gpu1" }, at("12:00"));
  const led = store.db.prepare("INSERT INTO todo_ledger (day, at, todo_id, title, action, by) VALUES ('2026-10-17', ?, ?, ?, ?, 'user')");
  led.run(at("09:00"), "t1", "논문 그림 2 고치기", "done");
  led.run(at("09:10"), "t2", "다시 연 일", "done");
  led.run(at("09:20"), "t2", "다시 연 일", "reopened");
  const git = async (now: Date) => {
    assert.equal(now.toISOString(), at("12:00"));
    return [{ path: "/r/app", name: "app", commitsToday: [
      { sha: "abc1234", subject: "fix: 그림", time: at("15:00") },
      { sha: "def5678", subject: "다음 날", time: new Date("2026-10-17T15:30:00Z").toISOString() }, // 18일 0:30 KST
    ], recentCommits: [] }];
  };
  const n = await collectDay(cfg, store, "2026-10-17", { git, focus: { stats: () => ({ from: "", to: "", total: 4000, days: [{ date: "2026-10-17", seconds: 4000, longest: 1800 }] }) } });
  assert.deepEqual(n.sessions, [{ project: "gpu1:/home/me/exp", items: [{ title: "학습 스크립트 고치기", tool: "Claude Code", turns: 3, lastPrompt: "다시 돌려줘" }] }]);
  assert.deepEqual(n.jobs, [{ name: "resnet 학습", seconds: 3725, code: 0, host: "gpu1" }]);
  assert.deepEqual(n.done, ["논문 그림 2 고치기"]);
  assert.deepEqual(n.focus, { seconds: 4000, longest: 1800 });
  assert.deepEqual(n.commits, [{ repo: "app", sha: "abc1234", subject: "fix: 그림" }]);

  const md = noteMarkdown(n, "Oct 17th, 2026");
  assert.match(md, /^tags:: 우사기 연구 노트\ndate:: \[\[Oct 17th, 2026\]\]\n\n- 집중 1시간 6분 \(가장 길게 이어서 30분\)\n- ## 작업 세션\n\t- `gpu1:\/home\/me\/exp`\n\t\t- 학습 스크립트 고치기 \(Claude Code, 3턴\) · 마지막 요청: 다시 돌려줘\n/);
  assert.match(md, /- ## 끝난 긴 작업\n\t- resnet 학습 @gpu1 · 1시간 2분 · 끝\n/);
  assert.match(md, /- ## 끝낸 할 일\n\t- 논문 그림 2 고치기\n- ## 커밋\n\t- app `abc1234` fix: 그림\n$/);

  const off = await collectDay({ ...cfg, readSessions: false, onboarded: false }, store, "2026-10-17", { git: async () => { throw new Error("부르면 안 됨"); } });
  assert.deepEqual([off.sessions, off.commits], [[], []]);
});

test("writeNote: 빈 날은 안 만들고, 같으면 그대로, 사용자가 고친 페이지는 덮지 않는다", () => {
  const graph = mkdtempSync(join(tmpdir(), "cy-tine-"));
  mkdirSync(join(graph, "logseq"));
  mkdirSync(join(graph, "pages"));
  writeFileSync(join(graph, "logseq", "config.edn"), '{:journal/page-title-format "yyyy-MM-dd"}');
  const store = new Store(":memory:");
  const empty: DayNote = { day: "2026-10-17", focus: { seconds: 0, longest: 0 }, sessions: [], jobs: [], done: [], commits: [] };
  assert.equal(writeNote(store, graph, empty), "empty");
  const path = notePath(graph, "2026-10-17");
  assert.equal(existsSync(path), false);

  const one = { ...empty, done: ["a"] };
  assert.equal(writeNote(store, graph, one), "written");
  assert.match(readFileSync(path, "utf8"), /date:: \[\[2026-10-17\]\]/);
  assert.equal(path, join(graph, "pages", "우사기 연구 노트___2026-10-17.md"));
  assert.equal(writeNote(store, graph, one), "same");
  assert.equal(writeNote(store, graph, { ...one, done: ["a", "b"] }), "written");

  writeFileSync(path, readFileSync(path, "utf8") + "- 내 메모\n");
  assert.equal(writeNote(store, graph, { ...one, done: ["a", "b", "c"] }), "edited");
  assert.match(readFileSync(path, "utf8"), /- 내 메모\n$/);
});
