import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { collectDay, formatDay, noteMarkdown, notePath, plain, splitBlocks, summarizeDay, summaryPrompt, writeNote, type DayNote } from "./research-note.ts";
import type { ExecFileLike } from "./providers.ts";

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

test("collectDay: 그날 세션(숨긴·임시 폴더 빼고)·실험(도는 것 빼고)·회의·끝낸/새 할 일·집중·커밋", async () => {
  const store = new Store(":memory:");
  store.upsertNode("session:a", "session", "학습 스크립트 고치기", { tool: "claude", cwd: "gpu1:/home/me/exp", turns: 3, lastPrompt: "다시 돌려줘" }, at("10:00"));
  store.upsertNode("session:b", "session", "어제 것", { tool: "codex", cwd: "/r/app", turns: 1 }, new Date("2026-10-16T14:00:00Z").toISOString()); // 16일 23시 KST
  store.upsertNode("session:c", "session", "숨김", { tool: "claude", cwd: "/secret/x", turns: 1 }, at("11:00"));
  store.hideProject("/secret", "secret");
  store.upsertNode("session:d", "session", "임시 폴더", { tool: "claude", cwd: "/private/tmp/x", turns: 1 }, at("11:30"));
  store.upsertNode("job:gpu1:1", "job", "resnet 학습", { seconds: 3725, code: 0, host: "gpu1", cwd: "/home/me/exp", cmd: "python train.py", files: ["out/m.json"] }, at("12:00"));
  store.upsertNode("job:gpu1:2", "job", "도는 중", { host: "gpu1", start: 1, running: true }, at("12:30"));
  store.upsertNode("job:gpu1:3", "job", "죽은 것", { host: "gpu1", start: 1, lost: true }, at("12:40"));
  store.db.exec("CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, subject TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL)");
  store.db.prepare("INSERT INTO meetings VALUES (?, ?, ?, ?)").run("m1", "랩 미팅", at("14:00"), at("15:00"));
  store.db.prepare("INSERT INTO meetings VALUES (?, ?, ?, ?)").run("m2", "다음 날", new Date("2026-10-17T16:00:00Z").toISOString(), new Date("2026-10-17T17:00:00Z").toISOString());
  const led = store.db.prepare("INSERT INTO todo_ledger (day, at, todo_id, title, action, by) VALUES ('2026-10-17', ?, ?, ?, ?, 'user')");
  led.run(at("09:00"), "t1", "논문 그림 2 고치기", "done");
  led.run(at("09:10"), "t2", "다시 연 일", "done");
  led.run(at("09:20"), "t2", "다시 연 일", "reopened");
  led.run(at("09:30"), "t3", "교수님께 결과 보내기", "added");
  led.run(at("09:40"), "t4", "생겼다 끝낸 일", "added");
  led.run(at("09:50"), "t4", "생겼다 끝낸 일", "done");
  led.run(at("09:55"), "t5", "생겼다 지운 일", "added");
  led.run(at("09:56"), "t5", "생겼다 지운 일", "trashed");
  led.run(at("09:57"), "reminder:r1", "미리알림에서 가져온 생일", "added");
  const git = async (now: Date) => {
    assert.equal(now.toISOString(), at("12:00"));
    return [{ path: "/r/app", name: "app", commitsToday: [
      { sha: "abc1234", subject: "fix: 그림", time: at("15:00") },
      { sha: "def5678", subject: "다음 날", time: new Date("2026-10-17T15:30:00Z").toISOString() }, // 18일 0:30 KST
    ], recentCommits: [] }];
  };
  const n = await collectDay(cfg, store, "2026-10-17", { git, focus: { stats: () => ({ from: "", to: "", total: 4000, days: [{ date: "2026-10-17", seconds: 4000, longest: 1800 }] }) } });
  assert.deepEqual(n.sessions, [{ project: "gpu1:/home/me/exp", items: [{ title: "학습 스크립트 고치기", tool: "Claude Code", turns: 3, lastPrompt: "다시 돌려줘" }] }]);
  assert.deepEqual(n.jobs, [
    { name: "resnet 학습", seconds: 3725, code: 0, host: "gpu1", cwd: "/home/me/exp", cmd: "python train.py", files: ["out/m.json"] },
    { name: "죽은 것", seconds: 0, code: null, host: "gpu1", lost: true },
  ]);
  assert.deepEqual(n.meetings, [{ time: "14:00", title: "랩 미팅" }]);
  assert.deepEqual(n.done, ["논문 그림 2 고치기", "생겼다 끝낸 일"]);
  assert.deepEqual(n.added, ["교수님께 결과 보내기"]);
  assert.deepEqual(n.focus, { seconds: 4000, longest: 1800 });
  assert.deepEqual(n.commits, [{ repo: "app", sha: "abc1234", subject: "fix: 그림" }]);
  assert.equal(n.summary, undefined);

  const md = noteMarkdown(n, "Oct 17th, 2026");
  assert.equal(md, [
    "tags:: 우사기 연구 노트", "date:: [[Oct 17th, 2026]]", "", "- 메모",
    "- 우사기 기록", "  usagi-auto:: true",
    "\t- ### 실험",
    "\t\t- resnet 학습 @gpu1 · 1시간 2분 · 끝", "\t\t\t- 폴더 `/home/me/exp` · 명령 `python train.py`", "\t\t\t- 바뀐 파일: `out/m.json`",
    "\t\t- 죽은 것 @gpu1 · 끊김(끝 기록 없이 사라짐)",
    "\t- ### 회의", "\t\t- 14:00 랩 미팅",
    "\t- ### 코드", "\t\t- app `abc1234` fix: 그림", "\t\t- 작업 세션 `gpu1:/home/me/exp`", "\t\t\t- 학습 스크립트 고치기 (Claude Code, 3턴) · 마지막 요청: 다시 돌려줘",
    "\t- ### 할 일", "\t\t- 끝냄: 논문 그림 2 고치기", "\t\t- 끝냄: 생겼다 끝낸 일", "\t\t- 새로 생김: 교수님께 결과 보내기",
    "\t- 집중 1시간 6분 (가장 길게 이어서 30분)", "",
  ].join("\n"));
  assert.deepEqual(splitBlocks(md).head, ["tags:: 우사기 연구 노트", "date:: [[Oct 17th, 2026]]", ""]);
  assert.deepEqual(splitBlocks(md).blocks.map((b) => b[0]), ["- 메모", "- 우사기 기록"]);

  const off = await collectDay({ ...cfg, readSessions: false, onboarded: false }, store, "2026-10-17", { git: async () => { throw new Error("부르면 안 됨"); } });
  assert.deepEqual([off.sessions, off.commits], [[], []]);
});

const graphDir = () => {
  const graph = mkdtempSync(join(tmpdir(), "cy-tine-"));
  mkdirSync(join(graph, "logseq"));
  mkdirSync(join(graph, "pages"));
  writeFileSync(join(graph, "logseq", "config.edn"), '{:journal/page-title-format "yyyy-MM-dd"}');
  return graph;
};
const empty: DayNote = { day: "2026-10-17", focus: { seconds: 0, longest: 0 }, sessions: [], jobs: [], meetings: [], done: [], added: [], commits: [] };

test("writeNote: 빈 날은 안 만들고, 같으면 그대로. 사용자가 쓴 블록은 지키면서 우사기 블록만 고쳐 쓴다", () => {
  const graph = graphDir();
  const store = new Store(":memory:");
  assert.equal(writeNote(store, graph, empty), "empty");
  const path = notePath(graph, "2026-10-17");
  assert.equal(existsSync(path), false);

  const one = { ...empty, done: ["a"] };
  assert.equal(writeNote(store, graph, one), "written");
  assert.match(readFileSync(path, "utf8"), /date:: \[\[2026-10-17\]\]/);
  assert.equal(path, join(graph, "pages", "우사기 연구 노트___2026-10-17.md"));
  assert.equal(writeNote(store, graph, one), "same");

  // 사용자가 메모 아래와 맨 끝에 쓴다(Tine 이 쓰는 모양: 자식은 탭)
  const mine = readFileSync(path, "utf8").replace("- 메모\n", "- 메모\n\t- ablation 다시 볼 것 [[DP]]\n") + "- 내 블록\n\t- 자식\n";
  writeFileSync(path, mine);
  assert.equal(writeNote(store, graph, { ...one, done: ["a", "b"] }), "written");
  const after = readFileSync(path, "utf8");
  assert.match(after, /- 메모\n\t- ablation 다시 볼 것 \[\[DP\]\]\n- 우사기 기록\n  usagi-auto:: true\n\t- ### 할 일\n\t\t- 끝냄: a\n\t\t- 끝냄: b\n- 내 블록\n\t- 자식\n$/);
});

test("writeNote: 우사기 블록 안을 고치거나 지웠으면 그대로 두고, 1판 페이지는 안 고쳤을 때만 2판으로", () => {
  const graph = graphDir();
  const store = new Store(":memory:");
  const path = notePath(graph, "2026-10-17");
  const one = { ...empty, done: ["a"] };
  writeNote(store, graph, one);
  writeFileSync(path, readFileSync(path, "utf8").replace("\t\t- 끝냄: a", "\t\t- 끝냄: a (내가 고침)"));
  assert.equal(writeNote(store, graph, { ...one, done: ["a", "b"] }), "edited");
  assert.match(readFileSync(path, "utf8"), /a \(내가 고침\)/);
  // 우사기 블록을 통째로 지움 → 다시 넣지 않는다
  writeFileSync(path, "tags:: 우사기 연구 노트\n\n- 메모\n");
  assert.equal(writeNote(store, graph, { ...one, done: ["a", "c"] }), "removed");
  assert.equal(readFileSync(path, "utf8"), "tags:: 우사기 연구 노트\n\n- 메모\n");

  // 1판(블록 표시 없음, 페이지 전체 해시) — 안 고쳤으면 2판으로, 고쳤으면 그대로
  const v1 = "tags:: 우사기 연구 노트\ndate:: [[2026-10-18]]\n\n- ## 끝낸 할 일\n\t- a\n";
  const p18 = notePath(graph, "2026-10-18");
  const hash = (x: string) => parseInt(createHash("sha1").update(x).digest("hex").slice(0, 13), 16);
  writeFileSync(p18, v1);
  store.setMark(`tine-note:${p18}`, hash(v1));
  assert.equal(writeNote(store, graph, { ...one, day: "2026-10-18" }), "written");
  assert.match(readFileSync(p18, "utf8"), /- 메모\n- 우사기 기록\n  usagi-auto:: true\n/);
  const p19 = notePath(graph, "2026-10-19");
  writeFileSync(p19, v1 + "- 내가 덧붙임\n");
  store.setMark(`tine-note:${p19}`, hash(v1));
  assert.equal(writeNote(store, graph, { ...one, day: "2026-10-19" }), "edited");
});

test("summarizeDay: 끝난 날 한 번만, 뇌 답을 3줄로 잘라 저장하고 페이지 맨 위에. 재료 없거나 이미 있거나 뇌가 없으면 안 부른다", async () => {
  const store = new Store(":memory:");
  const n: DayNote = { ...empty, jobs: [{ name: "resnet", seconds: 60, code: 0, host: "gpu1" }], done: ["그림 고치기"] };
  let calls = 0, prompt = "";
  const execFile: ExecFileLike = async (_f, args, o) => {
    calls++;
    prompt = String(o?.input ?? args.join(" "));
    return { stdout: `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(JSON.stringify({ lines: ["resnet 학습을 끝냈다", "그림을 고쳤다"], next: ["결과 파일 확인"] }))}}}\n`, stderr: "" };
  };
  const ccfg = { brain: { provider: "codex" }, models: { general: "x" }, onboarded: true } as any;
  const deps = { codex: { execFile, commandExists: () => true }, exists: () => true };
  assert.equal(await summarizeDay(ccfg, store, empty, deps), null);
  assert.equal(await summarizeDay({ ...ccfg, onboarded: false }, store, n, deps), null);
  assert.equal(calls, 0);
  assert.deepEqual(await summarizeDay(ccfg, store, n, deps), { lines: ["resnet 학습을 끝냈다", "그림을 고쳤다"], next: ["결과 파일 확인"] });
  assert.equal(calls, 1);
  assert.match(prompt, /"resnet"/);
  assert.equal(await summarizeDay(ccfg, store, n, deps), null); // 이미 있음
  assert.equal(calls, 1);
  assert.ok(!summaryPrompt({ ...n, summary: { lines: ["x"], next: [] } }).includes('"summary"'));

  const day = await collectDay({ ...cfg, readSessions: false }, store, "2026-10-17", { git: async () => [] });
  assert.deepEqual(day.summary, { lines: ["resnet 학습을 끝냈다", "그림을 고쳤다"], next: ["결과 파일 확인"] });
  const md = noteMarkdown({ ...n, summary: day.summary }, "x");
  assert.match(md, /- 우사기 기록\n  usagi-auto:: true\n\t- ### 요약\n\t\t- resnet 학습을 끝냈다\n\t\t- 그림을 고쳤다\n\t\t- 다음: 결과 파일 확인\n\t- ### 실험\n/);
});
