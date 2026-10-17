import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { autoBlock, collectDay, formatDay, notePath, plain, summarizeDay, summaryPrompt, writeNote, type DayNote } from "./research-note.ts";
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

  const md = `${autoBlock(n)}\n`;
  assert.equal(md, [
    "- 우사기 기록", "  usagi-auto:: true",
    "\t- ### 실험",
    "\t\t- resnet 학습 @gpu1 · 1시간 2분 · 끝", "\t\t\t- 폴더 `/home/me/exp` · 명령 `python train.py`", "\t\t\t- 바뀐 파일: `out/m.json`",
    "\t\t- 죽은 것 @gpu1 · 끊김(끝 기록 없이 사라짐)",
    "\t- ### 회의", "\t\t- 14:00 랩 미팅",
    "\t- ### 코드", "\t\t- app `abc1234` fix: 그림", "\t\t- 작업 세션 `gpu1:/home/me/exp`", "\t\t\t- 학습 스크립트 고치기 (Claude Code, 3턴) · 마지막 요청: 다시 돌려줘",
    "\t- ### 할 일", "\t\t- 끝냄: 논문 그림 2 고치기", "\t\t- 끝냄: 생겼다 끝낸 일", "\t\t- 새로 생김: 교수님께 결과 보내기",
    "\t- 집중 1시간 6분 (가장 길게 이어서 30분)", "",
  ].join("\n"));

  const off = await collectDay({ ...cfg, readSessions: false, onboarded: false }, store, "2026-10-17", { git: async () => { throw new Error("부르면 안 됨"); } });
  assert.deepEqual([off.sessions, off.commits], [[], []]);
});

const graphDir = (edn = "{}") => {
  const graph = mkdtempSync(join(tmpdir(), "cy-tine-"));
  mkdirSync(join(graph, "logseq"));
  writeFileSync(join(graph, "logseq", "config.edn"), edn);
  return graph;
};
const empty: DayNote = { day: "2026-10-17", focus: { seconds: 0, longest: 0 }, sessions: [], jobs: [], meetings: [], done: [], added: [], commits: [] };
const one: DayNote = { ...empty, done: ["a"] };

test("notePath: config.edn 의 저널 폴더·파일 이름 형식, 없으면 Logseq 기본", () => {
  assert.match(notePath(graphDir(), "2026-10-17"), /\/journals\/2026_10_17\.md$/);
  assert.match(notePath(graphDir('{:journals-directory "일지" :journal/file-name-format "yyyy-MM-dd" :journal/page-title-format "MMM do, yyyy"}'), "2026-10-07"), /\/일지\/2026-10-07\.md$/);
  assert.match(notePath(mkdtempSync(join(tmpdir(), "cy-tine-")), "2026-10-17"), /\/journals\/2026_10_17\.md$/); // config.edn 없음
});

test("writeNote: 저널이 없으면 폴더째 우사기 블록만 담아 만들고, 빈 날은 안 만들고, 같으면 안 쓴다", () => {
  const graph = graphDir();
  const store = new Store(":memory:");
  assert.equal(writeNote(store, graph, empty), "empty");
  assert.equal(existsSync(join(graph, "journals")), false);
  const path = notePath(graph, "2026-10-17");
  assert.equal(writeNote(store, graph, one), "written");
  assert.equal(readFileSync(path, "utf8"), "- 우사기 기록\n  usagi-auto:: true\n\t- ### 할 일\n\t\t- 끝냄: a\n");
  assert.equal(writeNote(store, graph, one), "same");
  assert.deepEqual(readdirSync(join(graph, "journals")), ["2026_10_17.md"]); // 임시 파일 안 남음
  assert.equal(existsSync(join(graph, "pages")), false);
});

test("writeNote: 있는 저널 끝에 덧붙이고, 다시 쓸 때는 우사기 블록 줄만 바꾼다(나머지는 바이트 그대로)", () => {
  const graph = graphDir();
  const store = new Store(":memory:");
  const path = notePath(graph, "2026-10-17");
  mkdirSync(join(graph, "journals"));
  const head = "- [[2026 국가암호공모전]]\n\t- 자식 끝공백  \n\n- 내 블록 #tag\n  id:: abc\n";
  writeFileSync(path, head + "- 끝줄(개행 없음)");
  assert.equal(writeNote(store, graph, one), "written");
  assert.equal(readFileSync(path, "utf8"), `${head}- 끝줄(개행 없음)\n${autoBlock(one)}\n`);

  // 사용자가 우사기 블록 앞에 블록 하나, 뒤에 빈 줄과 중첩 자식 있는 블록을 쓴다
  const tail = "\n- 뒤 블록\n\t- 자식\n\t\t- 손자\n";
  const before = "- 앞 블록\n";
  writeFileSync(path, before + readFileSync(path, "utf8") + tail);
  const next = { ...one, done: ["a", "b"] };
  assert.equal(writeNote(store, graph, next), "written");
  assert.equal(readFileSync(path, "utf8"), `${before}${head}- 끝줄(개행 없음)\n${autoBlock(next)}\n${tail}`);
  assert.equal(writeNote(store, graph, next), "same");
});

test("writeNote: 우사기 블록 안을 고치거나 블록을 지웠으면 그대로 두고 다시 넣지 않는다", () => {
  const graph = graphDir();
  const store = new Store(":memory:");
  const path = notePath(graph, "2026-10-17");
  writeNote(store, graph, one);
  const edited = readFileSync(path, "utf8").replace("끝냄: a", "끝냄: a (내가 고침)");
  writeFileSync(path, `- 내 블록\n${edited}`);
  assert.equal(writeNote(store, graph, { ...one, done: ["a", "b"] }), "edited");
  assert.equal(readFileSync(path, "utf8"), `- 내 블록\n${edited}`);

  const g2 = graphDir();
  const p2 = notePath(g2, "2026-10-17");
  writeNote(store, g2, one);
  writeFileSync(p2, "- 내 블록만\n");
  assert.equal(writeNote(store, g2, { ...one, done: ["a", "c"] }), "removed");
  assert.equal(readFileSync(p2, "utf8"), "- 내 블록만\n");
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
  const md = autoBlock({ ...n, summary: day.summary });
  assert.match(md, /- 우사기 기록\n  usagi-auto:: true\n\t- ### 요약\n\t\t- resnet 학습을 끝냈다\n\t\t- 그림을 고쳤다\n\t\t- 다음: 결과 파일 확인\n\t- ### 실험\n/);
});
