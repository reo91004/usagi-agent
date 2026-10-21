import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Store } from "./store.ts";
import { REPORT_EVERY_MS, autoBlock, autoId, collectDay, formatDay, noteFrozen, notePath, plain, reportDay, reportInput, sharedGit, writeNote, type DayNote } from "./research-note.ts";
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

test("collectDay·autoBlock: 그날 세션(숨긴·임시 폴더 빼고, 요청·마지막 답 포함)·실험(도는 것 빼고)·일정·할 일·집중·커밋을 보고서 모양으로", async () => {
  const store = new Store(":memory:");
  store.upsertNode("session:a", "session", "학습 스크립트 고치기", { tool: "claude", cwd: "gpu1:/home/me/exp", turns: 3, lastPrompt: "다시 돌려줘", files: ["a.py", "b.py"] }, at("10:00"));
  store.upsertNode("session:f1", "session", "You are auditing the repository in the current directory (read-only; do NOT modify any file)", { tool: "codex", cwd: "gpu1:/home/me/exp", turns: 1 }, at("10:10"));
  store.upsertNode("session:f2", "session", "You are auditing the repository in the current directory (read-only; do NOT modify any file)", { tool: "codex", cwd: "gpu1:/home/me/exp", turns: 2 }, at("10:20"));
  store.upsertNode("session:b", "session", "어제 것", { tool: "codex", cwd: "/r/app", turns: 1 }, new Date("2026-10-16T14:00:00Z").toISOString()); // 16일 23시 KST
  store.upsertNode("session:c", "session", "숨김", { tool: "claude", cwd: "/secret/x", turns: 1 }, at("11:00"));
  store.hideProject("/secret", "secret");
  store.upsertNode("session:d", "session", "임시 폴더", { tool: "claude", cwd: "/private/tmp/x", turns: 1 }, at("11:30"));
  store.upsertNode("session:g", "session", "- TODO 목록 정리", { tool: "claude", cwd: "/r/app/.claude/worktrees/w1", turns: 2 }, at("11:50")); // 워크트리는 레포로, 작업 표시는 막는다
  store.upsertNode("session:e", "session", "하위 에이전트", { tool: "claude", cwd: "/r/app/.claude/worktrees/agent-1", turns: 0 }, at("11:40")); // 0턴은 뺀다
  store.upsertNode("job:gpu1:1", "job", "resnet 학습", { seconds: 3725, code: 0, host: "gpu1", cwd: "/home/me/exp", cmd: "python train.py", files: ["out/m.json"] }, at("12:00"));
  store.upsertNode("job:gpu1:q1", "job", "우사기 확인", { seconds: 1, code: 0, host: "gpu1", cwd: "/home/me", cmd: "sleep 1" }, at("12:10"));
  store.upsertNode("job:gpu1:q2", "job", "빨리 죽은 것", { seconds: 2, code: 1, host: "gpu1" }, at("12:20")); // 짧아도 실패는 그대로
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
  led.run(at("09:41"), "t7", "논문 그림 2 고치기", "done"); // 같은 제목은 한 번만
  led.run(at("09:40"), "t4", "생겼다 끝낸 일", "added");
  led.run(at("09:50"), "t4", "생겼다 끝낸 일", "done");
  led.run(at("09:55"), "t5", "생겼다 지운 일", "added");
  led.run(at("09:56"), "t5", "생겼다 지운 일", "trashed");
  led.run(at("09:57"), "reminder:r1", "미리알림에서 가져온 생일", "added");
  led.run(at("09:58"), "t6", "김호은 DM 확인 답장", "added");
  led.run(at("09:59"), "t6", "김호은 DM 확인 답장", "skipped");
  led.run(at("10:01"), "t8", "생겼다 끝낸 일", "skipped"); // 끝낸 일과 같은 제목은 「안 함」에서 뺀다
  const git = async (now: Date) => {
    assert.equal(now.toISOString(), at("12:00"));
    return [{ path: "/r/app", name: "app", commitsToday: [
      { sha: "abc1234", subject: "fix: 그림", time: at("15:00") },
      { sha: "def5678", subject: "다음 날", time: new Date("2026-10-17T15:30:00Z").toISOString() }, // 18일 0:30 KST
    ], recentCommits: [] }];
  };
  const n = await collectDay(cfg, store, "2026-10-17", { git, focus: { stats: () => ({ from: "", to: "", total: 4000, days: [{ date: "2026-10-17", seconds: 4000, longest: 1800 }] }) } });
  assert.deepEqual(n.sessions[0].items[0], { title: "학습 스크립트 고치기", tool: "Claude Code", turns: 3, files: 2, ask: "다시 돌려줘" });
  assert.deepEqual(n.jobs, [
    { id: "job:gpu1:1", name: "resnet 학습", seconds: 3725, code: 0, host: "gpu1", cwd: "/home/me/exp", cmd: "python train.py", files: ["out/m.json"] },
    { id: "job:gpu1:q1", name: "우사기 확인", seconds: 1, code: 0, host: "gpu1", cwd: "/home/me", cmd: "sleep 1" },
    { id: "job:gpu1:q2", name: "빨리 죽은 것", seconds: 2, code: 1, host: "gpu1" },
    { id: "job:gpu1:3", name: "죽은 것", seconds: 0, code: null, host: "gpu1", lost: true },
  ]);
  assert.deepEqual(n.meetings, [{ time: "14:00", title: "랩 미팅" }]);
  assert.deepEqual(n.sessions.map((p) => p.project), ["gpu1:/home/me/exp", "/r/app"]);
  assert.deepEqual(n.done, ["논문 그림 2 고치기", "논문 그림 2 고치기", "생겼다 끝낸 일"]);
  assert.deepEqual(n.skipped, ["김호은 DM 확인 답장", "생겼다 끝낸 일"]);
  assert.deepEqual(n.added, ["교수님께 결과 보내기"]);
  assert.deepEqual(n.focus, { seconds: 4000, longest: 1800 });
  assert.deepEqual(n.commits, [{ repo: "app", path: "/r/app", sha: "abc1234", subject: "fix: 그림" }]);
  assert.equal(n.report, undefined);

  const md = `${autoBlock(n)}\n`;
  assert.equal(md, [
    "- ## 오늘 한 일", `  id:: ${autoId("2026-10-17")}`,
    "\t- 집중 1시간 6분(최장 30분) · 실험 3건 · 작업 세션 4건 · 커밋 1건 · 할 일 완료 2건",
    "\t- ### 실험",
    "\t\t- **resnet 학습** · `gpu1` · 1시간 2분 · 완료", "\t\t\t- 명령 `python train.py`", // 보고서가 없으면 명령만(폴더·바뀐 파일은 싣지 않는다)
    "\t\t- **빨리 죽은 것** · `gpu1` · 2초 · ==실패(종료 코드 1)==",
    "\t\t- **죽은 것** · `gpu1` · ==중단(종료 기록 없음)==",
    "\t\t- 짧은 작업 1건(10초 미만, 모두 완료)",
    "\t- ### 작업",
    "\t\t- [[exp]] `gpu1`", "\t\t\t- 학습 스크립트 고치기 진행",
    "\t\t\t- You are auditing the repository in the current directory (r… 진행",
    "\t\t- [[app]]", "\t\t\t- `abc1234` fix: 그림", "\t\t\t- \u200bTODO 목록 정리 진행",
    "\t- ### 일정", "\t\t- **14:00** 랩 미팅",
    "\t- ### 할 일", "\t\t- 완료", "\t\t\t- 논문 그림 2 고치기", "\t\t\t- 생겼다 끝낸 일", "\t\t- 불필요로 종료", "\t\t\t- 김호은 DM 확인 답장", "\t\t- 신규", "\t\t\t- 교수님께 결과 보내기",
    "",
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
test("collectDay: 그날 「일정」을 그대로 옮긴 캘린더 할 일은 「신규」에서 뺀다(#293)", async () => {
  const store = new Store(":memory:");
  store.db.exec("CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, subject TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL)");
  store.db.prepare("INSERT INTO meetings VALUES (?, ?, ?, ?)").run("m1", "디지털논리회로", at("13:00"), at("15:00"));
  store.db.prepare("INSERT INTO meetings VALUES (?, ?, ?, ?)").run("m2", "피아노 학원", at("19:30"), at("20:30"));
  const led = store.db.prepare("INSERT INTO todo_ledger (day, at, todo_id, title, action, by) VALUES ('2026-10-17', ?, ?, ?, 'added', 'briefing')");
  for (const [id, title, source] of [
    ["calendar:a", "디지털논리회로 수업", "calendar"],
    ["calendar:b", "피아노 학원 준비물 챙기기", "calendar"], // 할 일이 붙으면 그대로
    ["user:c", "피아노 학원", "user"], // 캘린더 출처가 아니면 그대로
    ["calendar:d", "논문 초안 제출", "calendar"], // 그날 일정에 없으면 그대로
  ]) { store.upsertTodo({ id, title, source, priority: 2 }); led.run(at("09:00"), id, title); }
  const n = await collectDay({ ...cfg, readSessions: false }, store, "2026-10-17", { git: async () => [] });
  assert.deepEqual(n.meetings.map((m) => m.title), ["디지털논리회로", "피아노 학원"]);
  assert.deepEqual(n.added, ["피아노 학원 준비물 챙기기", "피아노 학원", "논문 초안 제출"]);
});

test("collectDay·autoBlock: 연구·프로젝트로 정한 폴더는 바꾼 이름으로, 합친 폴더는 그 프로젝트 아래에(#299)", async () => {
  const store = new Store(":memory:");
  store.upsertNode("session:a", "session", "그림 고치기", { tool: "claude", cwd: "/r/paper", turns: 2 }, at("10:00"));
  store.upsertNode("session:b", "session", "실험 코드", { tool: "claude", cwd: "gpu1:/home/me/exp", turns: 1 }, at("10:30"));
  store.upsertNode("session:c", "session", "옆 폴더", { tool: "codex", cwd: "/r/tools", turns: 1 }, at("11:00"));
  const meta = { subs: [], url: null, mergedInto: null };
  store.putResearchMeta({ ...meta, path: "/r/paper", kind: "research", name: "확산 [모델] 논문" });
  store.putResearchMeta({ ...meta, path: "gpu1:/home/me/exp", kind: null, name: null, mergedInto: "/r/paper" });
  store.putResearchMeta({ ...meta, path: "/r/tools", kind: "none", name: "안 쓰는 이름" }); // 「아니에요」로 뺀 폴더는 폴더 이름 그대로
  const git = async () => [{ path: "/r/paper", name: "paper", commitsToday: [{ sha: "abc1234", subject: "fix: 그림", time: at("15:00") }], recentCommits: [] }];
  const n = await collectDay(cfg, store, "2026-10-17", { git });
  assert.deepEqual(n.sessions.map((p) => [p.project, p.items.map((s) => s.title)]), [["/r/paper", ["그림 고치기", "실험 코드"]], ["/r/tools", ["옆 폴더"]]]);
  assert.deepEqual(n.names, { "/r/paper": "확산 [모델] 논문" });
  const md = autoBlock(n).split("\n");
  assert.deepEqual(md.slice(md.indexOf("\t- ### 작업") + 1), [
    "\t\t- [[확산 모델 논문]]", "\t\t\t- `abc1234` fix: 그림", "\t\t\t- 그림 고치기 진행", "\t\t\t- 실험 코드 진행",
    "\t\t- [[tools]]", "\t\t\t- 옆 폴더 진행",
  ]);
  assert.match(reportInput(n).prompt, /"name":"확산 모델 논문"/);
});

const empty: DayNote = { day: "2026-10-17", focus: { seconds: 0, longest: 0 }, sessions: [], jobs: [], meetings: [], done: [], skipped: [], added: [], commits: [] };
const one: DayNote = { ...empty, done: ["a"] };
const oneBlock = `- ## 오늘 한 일\n  id:: ${autoId("2026-10-17")}\n\t- 할 일 완료 1건\n\t- ### 할 일\n\t\t- 완료\n\t\t\t- a`;

test("notePath: config.edn 의 저널 폴더·파일 이름 형식, 없으면 Logseq 기본", () => {
  assert.match(notePath(graphDir(), "2026-10-17"), /\/journals\/2026_10_17\.md$/);
  assert.match(notePath(graphDir('{:journals-directory "일지" :journal/file-name-format "yyyy-MM-dd" :journal/page-title-format "MMM do, yyyy"}'), "2026-10-07"), /\/일지\/2026-10-07\.md$/);
  assert.match(notePath(mkdtempSync(join(tmpdir(), "cy-tine-")), "2026-10-17"), /\/journals\/2026_10_17\.md$/); // config.edn 없음
});

test("writeNote: 저널이 없으면 폴더째 우사기 블록만 담아 만들고, 빈 날은 안 만들고, 같으면 안 쓴다", () => {
  const graph = graphDir();
  const store = new Store(":memory:");
  assert.equal(writeNote(store, graph, empty), "empty");
  assert.equal(writeNote(store, graph, { ...empty, focus: { seconds: 1, longest: 1 } }), "empty"); // 1분 안 되는 집중만 있는 날은 만들지 않는다
  assert.ok(!autoBlock({ ...one, focus: { seconds: 59, longest: 59 } }).includes("집중"));
  assert.equal(existsSync(join(graph, "journals")), false);
  const path = notePath(graph, "2026-10-17");
  assert.equal(writeNote(store, graph, one), "written");
  assert.equal(readFileSync(path, "utf8"), `${oneBlock}\n`);
  assert.equal(writeNote(store, graph, one), "same");
  assert.deepEqual(readdirSync(join(graph, "journals")), ["2026_10_17.md"]); // 임시 파일 안 남음
  assert.equal(existsSync(join(graph, "pages")), false);
});

test("writeNote: 0.6.0 이 쓴 「우사기 기록」(usagi-auto) 블록은 다음 쓰기 때 「오늘 한 일」로 바꾸고 앞뒤 사용자 블록은 그대로", () => {
  const graph = graphDir();
  const store = new Store(":memory:");
  const path = notePath(graph, "2026-10-17");
  const legacy = "- 우사기 기록\n  usagi-auto:: true\n\t- ### 할 일\n\t\t- 끝냄: a";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `- 앞\n${legacy}\n- 뒤\n`);
  store.setMark(`tine-note-auto:${path}`, parseInt(createHash("sha1").update(legacy).digest("hex").slice(0, 13), 16)); // 0.6.0 이 그 블록을 쓴 뒤 남긴 해시
  assert.equal(writeNote(store, graph, one), "written");
  assert.equal(readFileSync(path, "utf8"), `- 앞\n${oneBlock}\n- 뒤\n`);
  assert.match(autoId("2026-10-17"), /^75736167-6900-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(autoId("2026-10-17"), autoId("2026-10-18"));
});

test("writeNote: Tine 이 줄바꿈만 넣어 만든 빈 일지에는 빈 줄 없이 블록만", () => {
  const graph = graphDir();
  const store = new Store(":memory:");
  const path = notePath(graph, "2026-10-17");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "\n");
  assert.equal(writeNote(store, graph, one), "written");
  assert.equal(readFileSync(path, "utf8"), `${oneBlock}\n`);
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
  const edited = readFileSync(path, "utf8").replace("\t\t\t- a", "\t\t\t- a (내가 고침)");
  writeFileSync(path, `- 내 블록\n${edited}`);
  assert.equal(writeNote(store, graph, { ...one, done: ["a", "b"] }), "edited");
  assert.equal(noteFrozen(store, graph, "2026-10-17"), true, "고친 날은 보고서도 안 쓴다");
  assert.equal(readFileSync(path, "utf8"), `- 내 블록\n${edited}`);

  const g2 = graphDir();
  const p2 = notePath(g2, "2026-10-17");
  writeNote(store, g2, one);
  writeFileSync(p2, "- 내 블록만\n");
  assert.equal(writeNote(store, g2, { ...one, done: ["a", "c"] }), "removed");
  assert.equal(noteFrozen(store, g2, "2026-10-17"), true);
  assert.equal(noteFrozen(store, g2, "2026-10-18"), false);
  assert.equal(readFileSync(p2, "utf8"), "- 내 블록만\n");
});

test("reportDay: 재료가 바뀌었을 때만, 오늘은 3시간에 한 번까지, 끝난 날은 끝난 뒤 한 번. 답의 i 를 실험 id·레포에 잇고 노트에 개조식으로", async () => {
  const store = new Store(":memory:");
  const n: DayNote = {
    ...empty,
    jobs: [{ id: "job:gpu1:1", name: "resnet", seconds: 3600, code: 0, host: "gpu1", cwd: "/home/me/exp", cmd: "python train.py" }, { id: "job:gpu1:q", name: "확인", seconds: 1, code: 0 }],
    sessions: [{ project: "gpu1:/home/me/exp", items: [{ title: "학습 결과 보기", tool: "Claude Code", turns: 4, files: 1, ask: "결과 정리해줘", result: "top-1 76.1% 확인 ghp_abcdefghijklmnopqrstuvwxyz0123" }] }],
    done: ["그림 고치기"],
  };
  let calls = 0, prompt = "";
  let answer: unknown = { summary: ["ResNet 학습 완료, top-1 76.1% 확인"], experiments: [{ i: 0, line: "ResNet 1시간 학습, 정상 종료" }, { i: 7, line: "없는 실험" }], projects: [{ i: 0, lines: ["학습 결과 정리 완료"] }], next: ["그림 반영 필요"] };
  const execFile: ExecFileLike = async (_f, args, o) => {
    calls++;
    prompt = String(o?.input ?? args.join(" "));
    return { stdout: `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(JSON.stringify(answer))}}}\n`, stderr: "" };
  };
  const ccfg = { brain: { provider: "codex" }, models: { general: "x" }, onboarded: true } as any;
  const deps = { codex: { execFile, commandExists: () => true }, exists: () => true };
  const t0 = new Date("2026-10-17T10:00:00+09:00").getTime();
  assert.equal(await reportDay(ccfg, store, empty, deps, t0), null);
  assert.equal(await reportDay({ ...ccfg, onboarded: false }, store, n, deps, t0), null);
  assert.equal(calls, 0);
  const r = await reportDay(ccfg, store, n, deps, t0);
  assert.deepEqual(r, { summary: ["ResNet 학습 완료, top-1 76.1% 확인"], experiments: { "job:gpu1:1": "ResNet 1시간 학습, 정상 종료" }, projects: { "gpu1:/home/me/exp": ["학습 결과 정리 완료"] }, next: ["그림 반영 필요"] });
  assert.match(prompt, /"resnet"/);
  assert.match(prompt, /결과 정리해줘/);
  assert.ok(!prompt.includes("ghp_abc"), "세션 글의 비밀값은 가린다");
  assert.ok(!reportInput(n).prompt.includes('"확인"'), "짧은 성공 작업은 재료에서 뺀다");
  assert.equal(await reportDay(ccfg, store, { ...n, focus: { seconds: 3000, longest: 3000 } }, deps, t0 + 4 * 3600e3), null, "집중 시간만 바뀌면 안 부른다");
  const more = { ...n, done: ["그림 고치기", "메일 답장"] };
  assert.equal(await reportDay(ccfg, store, more, deps, t0 + 3600e3), null, "3시간 안에는 다시 안 쓴다");
  assert.equal(calls, 1);
  assert.ok(await reportDay(ccfg, store, more, deps, t0 + REPORT_EVERY_MS));
  assert.equal(calls, 2);
  const next = new Date("2026-10-18T01:00:00+09:00").getTime(); // 끝난 날: 재료가 바뀌었으면 한 번 더(final), 그 뒤로는 안 부른다
  const last = { ...more, added: ["논문 읽기"] };
  assert.ok(await reportDay(ccfg, store, last, deps, next));
  assert.equal(await reportDay(ccfg, store, { ...last, added: ["논문 읽기", "또"] }, deps, next + REPORT_EVERY_MS), null);
  assert.equal(calls, 3);

  answer = { summary: [], experiments: [{ i: 9, line: "없는 실험" }], projects: [], next: ["x"] }; // 빈 답은 실패로(저장하면 같은 재료로 다시 안 부른다)
  const fresh = new Store(":memory:");
  await assert.rejects(reportDay(ccfg, fresh, n, deps, t0), /빈 답/);
  assert.equal(fresh.node("note-report:2026-10-17"), undefined);
  assert.equal(await reportDay(ccfg, fresh, { ...empty, focus: { seconds: 3600, longest: 3600 }, jobs: [{ name: "확인", seconds: 1, code: 0 }] }, deps, t0), null, "집중·짧은 작업만 있으면 보고할 거리가 없다");
  const big: DayNote = { ...n, sessions: [{ project: "/r/app", items: Array.from({ length: 40 }, (_, k) => ({ title: `세션 ${k}`, tool: "Codex", turns: k, files: 0, ask: "가".repeat(300), result: "나".repeat(500) })) }] };
  const inp = reportInput(big);
  assert.ok(inp.prompt.length < 16000, String(inp.prompt.length));
  assert.doesNotThrow(() => JSON.parse(inp.prompt.slice(inp.prompt.indexOf("\n") + 1)), "길어도 JSON 이 깨지지 않는다");
  assert.notEqual(reportInput({ ...big, done: ["다른 일"] }).fp, inp.fp);

  const day = await collectDay({ ...cfg, readSessions: false }, store, "2026-10-17", { git: async () => [] });
  assert.equal(day.report!.experiments["job:gpu1:1"], "ResNet 1시간 학습, 정상 종료");
  const md = autoBlock({ ...n, report: day.report });
  assert.ok(md.includes("\t- ### 요약\n\t\t- ResNet 학습 완료, top-1 76.1% 확인\n\t- ### 실험\n\t\t- **resnet** · `gpu1` · 1시간 · 완료\n\t\t\t- ResNet 1시간 학습, 정상 종료\n"), md);
  assert.ok(md.includes("\t\t- [[exp]] `gpu1`\n\t\t\t- 학습 결과 정리 완료\n"), md);
  assert.ok(md.endsWith("\t- ### 향후 계획\n\t\t- 그림 반영 필요"), md);
  assert.ok(!md.includes("ghp_"));
});

test("sharedGit: 어제·오늘 노트가 git 을 한 번만 부르고 날짜로 나눈다", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const commit = (sha: string, time: string) => ({ sha, subject: sha, time });
  const fetch = (async () => {
    calls++;
    return [{ path: "/r/app", name: "app", commitsToday: [commit("old", "2026-10-16T03:00:00Z"), commit("new", "2026-10-17T03:00:00Z")], recentCommits: [] }];
  }) as any;
  const git = sharedGit(cfg as any, "2026-10-16", fetch);
  const a = await collectDay(cfg as any, store, "2026-10-16", { git });
  const b = await collectDay(cfg as any, store, "2026-10-17", { git });
  assert.equal(calls, 1);
  assert.deepEqual(a.commits.map((c) => c.sha), ["old"]);
  assert.deepEqual(b.commits.map((c) => c.sha), ["new"]);
});
