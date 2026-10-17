import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostBackoff } from "./jobs.ts";
import { parseJobDone, parseRunning, jobBubble, jobNodeId, jobProps, okJobHost, parseTmux, mineOnly, sharedMineDir, pullJobs, type RunSsh } from "./jobs.ts";
import { setCharacter } from "./characters.ts";
import { loadConfig } from "./config.ts";
import { Bus } from "./bus.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ops", "usagi-run");

test("parseJobDone: 이름은 한 줄로 자르고, 시간·종료 코드는 숫자만(null = 모름)", () => {
  assert.deepEqual(parseJobDone({ name: " 학습\n  resnet ", seconds: 61, code: 0 }), { name: "학습 resnet", seconds: 61, code: 0 });
  assert.deepEqual(parseJobDone({ name: "a", seconds: 0, code: null }, "gpu1"), { name: "a", seconds: 0, code: null, host: "gpu1" });
  assert.equal(parseJobDone({ name: "x".repeat(500), seconds: 1, code: 1 })!.name.length, 120);
  for (const bad of [null, [], {}, { name: "", seconds: 1, code: 0 }, { name: "a", seconds: -1, code: 0 }, { name: "a", seconds: "1", code: 0 }, { name: "a", seconds: 1, code: 1.5 }, { name: "a", seconds: Infinity, code: 0 }]) {
    assert.equal(parseJobDone(bad), null, JSON.stringify(bad));
  }
});

test("jobBubble: 0·모름은 끝(done), 그 밖은 실패(error) — 캐릭터 말투, 서버 이름을 붙인다", () => {
  setCharacter("shisa");
  const ok = jobBubble({ name: "학습", seconds: 3725, code: 0 }, "j1");
  assert.deepEqual(ok, { id: "j1", kind: "done", ttlMs: 30 * 60e3, text: "'학습' 끝났어요! 1시간 2분 걸렸어요" });
  assert.equal(jobBubble({ name: "학습", seconds: 5, code: null, host: "gpu1" }, "j2").text, "'학습 @gpu1' 끝났어요! 5초 걸렸어요");
  const bad = jobBubble({ name: "학습", seconds: 90, code: 137 }, "j3");
  assert.equal(bad.kind, "error");
  assert.equal(bad.text, "'학습' 이(가) 1분 만에 멈췄어요. 종료 코드 137");
  setCharacter("usagi");
  assert.match(jobBubble({ name: "학습", seconds: 60, code: 0 }, "j4").text, /^(야하!|이야하~!!!)\('학습' .*1분 걸렸어!\)$/);
  setCharacter("shisa");
});

test("okJobHost: ssh 별칭·user@host 만, 옵션처럼 읽히거나 셸 문자가 든 값은 거절", () => {
  for (const h of ["gpu1", "lab.example.ac.kr", "reo@10.0.0.5", "a_b-c"]) assert.ok(okJobHost(h), h);
  for (const h of ["-oProxyCommand=sh", "a b", "h;rm -rf ~", "$(id)", "", "x".repeat(200), 3, null]) assert.ok(!okJobHost(h), String(h));
});

test("pullJobs: 끝난 것(D)은 읽고 지우고, 도는 것(R)은 두되 끊긴 표시(살아 있지 않음)·깨진 것은 지운다", async () => {
  const calls: string[][] = [];
  const run: RunSsh = async (args) => {
    calls.push(args);
    if (calls.length > 1) return "";
    return [
      `D\t20261016-1-1.json\t{"name":"학습","seconds":10,"code":0,"id":"20261016-1-1","cwd":"/home/u/exp","files":["r.json"]}`,
      `D\t20261016-1-2.json\t{"name":"평가","seconds":5,"code":2}`,
      `D\tbroken.json\t{oops`,
      `D\t../evil.json\t{"name":"x","seconds":1,"code":0}`,
      `R\t20261017-1-3.running\t1\t{"id":"20261017-1-3","name":"긴 학습","cwd":"/home/u/exp","cmd":"python t.py","start":1792171509,"pid":42}`,
      `R\t20261017-1-4.running\t0\t{"id":"20261017-1-4","name":"죽은 학습","start":1792171000,"pid":43}`,
      `R\tbad.running\t1\t{"name":"id 없음"}`,
      `no tab line`,
    ].join("\n");
  };
  const { done, running, tmux } = await pullJobs("gpu1", run);
  assert.deepEqual(tmux, []);
  assert.deepEqual(done, [
    { name: "학습", seconds: 10, code: 0, host: "gpu1", id: "20261016-1-1", cwd: "/home/u/exp", files: ["r.json"] },
    { name: "평가", seconds: 5, code: 2, host: "gpu1" },
  ]);
  assert.deepEqual(running, [
    { id: "20261017-1-3", name: "긴 학습", host: "gpu1", start: 1792171509, alive: true, cwd: "/home/u/exp", cmd: "python t.py" },
    { id: "20261017-1-4", name: "죽은 학습", host: "gpu1", start: 1792171000, alive: false },
  ]);
  assert.equal(calls.length, 1); // 지우기 ssh 는 따로 나가지 않는다
  assert.deepEqual(calls[0].slice(0, 2), ["--", "gpu1"]);
  // 지우기는 다음 목록 ssh 명령 앞에 합쳐서, 그 다음엔 없다
  const quiet: string[][] = [];
  assert.deepEqual(await pullJobs("gpu1", async (a) => { quiet.push(a); return ""; }), { done: [], running: [], tmux: [] });
  assert.equal(quiet.length, 1);
  assert.ok(quiet[0][2].startsWith("(cd ~/.usagi-agent/jobs && rm -f -- '20261016-1-1.json' '20261016-1-2.json' 'broken.json' '20261017-1-4.running' 'bad.running'); "));
  await pullJobs("gpu1", async (a) => { quiet.push(a); return ""; });
  assert.ok(!quiet[1][2].includes("rm -f"));
  await assert.rejects(pullJobs("-oProxyCommand=x", run), /jobHosts/);
});

test("parseJobDone·parseRunning: 덧붙는 칸은 믿지 않는 입력 — 이상한 칸만 빼고, 파일은 8개까지", () => {
  const j = parseJobDone({ name: "a", seconds: 1, code: 0, id: "../x", cwd: "  /h/e\nx ", cmd: 3, start: -1, files: ["a", 2, "", ...Array(20).fill("f")] });
  assert.deepEqual(j, { name: "a", seconds: 1, code: 0, cwd: "/h/e x", files: ["a", "f", "f", "f", "f", "f", "f", "f"] });
  assert.equal(parseRunning({ name: "a", id: "1", start: 1.5 }, "h", true), null);
  assert.equal(parseRunning({ name: "", id: "1", start: 1 }, "h", true), null);
});

test("jobNodeId·jobProps: 도는 중과 끝이 같은 노드, 상태 표시는 하나만", () => {
  assert.equal(jobNodeId({ id: "20261017-1-3", host: "gpu1" }), "job:gpu1:20261017-1-3");
  assert.equal(jobNodeId({ id: "20261017-1-3" }), "job:20261017-1-3");
  assert.match(jobNodeId({}), /^job:job-[0-9a-f-]{36}$/);
  const r = { id: "1", name: "a", host: "gpu1", start: 10, alive: true, cwd: "/w" };
  assert.deepEqual(jobProps(r, "running"), { host: "gpu1", cwd: "/w", start: 10, running: true });
  assert.deepEqual(jobProps({ name: "a", seconds: 5, code: 1, host: "gpu1", start: 10, files: ["o.txt"] }), { host: "gpu1", start: 10, seconds: 5, code: 1, files: ["o.txt"] });
});

test("HTTP: POST /jobs/done 은 헤더 필수, 잘못된 본문은 400, 맞으면 처리기로", async () => {
  const bus = new Bus();
  const got: unknown[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}),
    todoDone: () => true, chat: () => "c",
    jobDone: (j) => { got.push(j); },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (body: string, headers: Record<string, string> = { "x-cy-agent": "1" }) =>
    fetch(`${base}/jobs/done`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
  try {
    assert.equal((await post(`{"name":"a","seconds":1,"code":0}`, {})).status, 403);
    assert.equal((await post(`{"name":"","seconds":1,"code":0}`)).status, 400);
    assert.equal((await post(`{"name":"a","seconds":1,"code":0}`)).status, 200);
    assert.deepEqual(got, [{ name: "a", seconds: 1, code: 0 }]);
  } finally {
    bus.close();
  }
});

test("usagi-run: 데몬이 없으면 ~/.usagi-agent/jobs 에 JSON 을 남기고 종료 코드는 명령 그대로", () => {
  const home = mkdtempSync(join(tmpdir(), "usagi-run-"));
  const env = { ...process.env, HOME: home, CY_AGENT_PORT: "9" }; // 9 번(discard)엔 데몬이 없다
  const r = spawnSync("sh", [SCRIPT, "-n", `학습 "v2"\\끝\t탭`, "--", "sh", "-c", "exit 3"], { env, encoding: "utf8" });
  assert.equal(r.status, 3);
  const dir = join(home, ".usagi-agent", "jobs");
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}-\d{6}-\d+\.json$/);
  const j = parseJobDone(JSON.parse(readFileSync(join(dir, files[0]), "utf8")));
  assert.deepEqual({ name: j!.name, code: j!.code, cmd: j!.cmd }, { name: `학습 "v2"\\끝 탭`, code: 3, cmd: "sh -c exit 3" });
  assert.equal(`${j!.id}.json`, files[0]);
  // 이름이 없으면 명령 자체가 이름, 인자가 없으면 사용법(2)
  assert.equal(spawnSync("sh", [SCRIPT], { env, encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("sh", [SCRIPT, "--pid", "abc"], { env, encoding: "utf8" }).status, 2);
});

test("usagi-run: 이 맥에서 데몬이 켜져 있으면 POST /jobs/done 으로 바로 보낸다", async () => {
  const bodies: string[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { if (req.url === "/jobs/done" && req.headers["x-cy-agent"] === "1") bodies.push(b); res.end("{}"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const home = mkdtempSync(join(tmpdir(), "usagi-run-"));
  try {
    const port = String((srv.address() as any).port);
    const child = spawn("sh", [SCRIPT, "--", "true"], { env: { ...process.env, HOME: home, CY_AGENT_PORT: port } });
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0);
    assert.equal(bodies.length, 1);
    assert.deepEqual(parseJobDone(JSON.parse(bodies[0]))?.code, 0);
    assert.equal(JSON.parse(bodies[0]).name, "true");
    assert.deepEqual(readdirSync(join(home, ".usagi-agent", "jobs")), []); // 도는 중 표시는 끝나면 지운다
  } finally {
    srv.close();
  }
});

test("usagi-run 이 남긴 파일 → pullJobs(원격 명령을 실제 sh 로) → 읽고 지움", async () => {
  const home = mkdtempSync(join(tmpdir(), "usagi-run-"));
  const env = { ...process.env, HOME: home, CY_AGENT_PORT: "9" };
  spawnSync("sh", [SCRIPT, "-n", "학습 A", "--", "true"], { env });
  spawnSync("sh", [SCRIPT, "-n", "학습 B", "--", "sh", "-c", "exit 1"], { env });
  const localSh: RunSsh = async (args) => {
    const r = spawnSync("sh", ["-c", args[2]], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  const { done } = await pullJobs("gpu1", localSh);
  assert.deepEqual(done.map((j) => [j.name, j.code, j.host]).sort(), [["학습 A", 0, "gpu1"], ["학습 B", 1, "gpu1"]]);
  assert.deepEqual(await pullJobs("gpu1", localSh), { done: [], running: [], tmux: [] }); // 이 호출 앞머리에서 지운다
  assert.deepEqual(readdirSync(join(home, ".usagi-agent", "jobs")), []);
  // 폴더가 아직 없는 서버도 조용히 빈 목록
  assert.deepEqual(await pullJobs("gpu1", async (a) => spawnSync("sh", ["-c", a[2]], { env: { ...env, HOME: mkdtempSync(join(tmpdir(), "empty-")) }, encoding: "utf8" }).stdout), { done: [], running: [], tmux: [] });
});

test("usagi-run: 도는 동안 .running 표시(pullJobs 가 살아 있음으로 읽음), 끝나면 지우고 폴더·명령·바뀐 파일을 남긴다", async () => {
  const home = mkdtempSync(join(tmpdir(), "usagi-run-"));
  const work = mkdtempSync(join(tmpdir(), "usagi-work-"));
  const env = { ...process.env, HOME: home, CY_AGENT_PORT: "9" };
  const localSh: RunSsh = async (args) => spawnSync("sh", ["-c", args[2]], { env, encoding: "utf8" }).stdout;
  const child = spawn("sh", [SCRIPT, "-n", "학습", "--", "sh", "-c", "sleep 1; mkdir -p out; echo 1 > out/m.json; echo x > log.txt"], { env, cwd: work });
  await new Promise((r) => setTimeout(r, 400));
  const mid = await pullJobs("gpu1", localSh);
  assert.equal(mid.done.length, 0);
  assert.equal(mid.running.length, 1);
  assert.equal(mid.running[0].alive, true);
  assert.equal(mid.running[0].name, "학습");
  assert.match(mid.running[0].cmd!, /^sh -c sleep 1/);
  assert.equal(await new Promise((r) => child.on("close", r)), 0);
  const { done, running } = await pullJobs("gpu1", localSh);
  assert.deepEqual(running, []);
  assert.equal(done.length, 1);
  assert.equal(done[0].id, mid.running[0].id); // 도는 중 표시와 같은 id → 같은 노드
  assert.equal(done[0].cwd, realpathSync(work));
  assert.deepEqual([...done[0].files!].sort(), ["log.txt", "out/m.json"]);
  await pullJobs("gpu1", localSh); // 지우기는 다음 목록 호출 앞에서
  assert.deepEqual(readdirSync(join(home, ".usagi-agent", "jobs")), []);
});

test("usagi-run: 프로세스가 끝 기록 없이 죽으면 표시만 남고 pullJobs 가 끊김으로 읽은 뒤 지운다", async () => {
  const home = mkdtempSync(join(tmpdir(), "usagi-run-"));
  const env = { ...process.env, HOME: home, CY_AGENT_PORT: "9" };
  const child = spawn("sh", [SCRIPT, "-n", "죽을 학습", "--", "sleep", "3"], { env, stdio: "ignore" }); // 남는 sleep 이 파이프를 붙잡지 않게
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGKILL"); // usagi-run 자체를 강제 종료(서버 재시작과 같은 효과)
  await new Promise((r) => child.on("exit", r));
  const localSh: RunSsh = async (args) => spawnSync("sh", ["-c", args[2]], { env, encoding: "utf8" }).stdout;
  const { running } = await pullJobs("gpu1", localSh);
  assert.equal(running.length, 1);
  assert.equal(running[0].alive, false);
  await pullJobs("gpu1", localSh);
  assert.deepEqual(readdirSync(join(home, ".usagi-agent", "jobs")), []);
});

test("공용 계정: 개인 폴더의 usagi-run(~/reo/bin)은 ~/reo/.usagi-agent/jobs 에 남기고, pullJobs 는 jobDirs 의 그 폴더만 본다", async () => {
  const home = mkdtempSync(join(tmpdir(), "usagi-shared-"));
  const mine = join(home, "reo");
  mkdirSync(join(mine, "bin"), { recursive: true });
  mkdirSync(join(mine, ".usagi-agent"));
  copyFileSync(SCRIPT, join(mine, "bin", "usagi-run"));
  const env = { ...process.env, HOME: home, CY_AGENT_PORT: "9" };
  spawnSync("sh", [join(mine, "bin", "usagi-run"), "-n", "내 학습", "--", "true"], { env });
  spawnSync("sh", [SCRIPT, "-n", "다른 사람 학습", "--", "true"], { env }); // 같은 계정의 다른 사람(기본 위치)
  const localSh: RunSsh = async (args) => spawnSync("sh", ["-c", args[2]], { env, encoding: "utf8" }).stdout;
  const { done } = await pullJobs("gpu1", localSh, "~/reo/.usagi-agent/jobs");
  assert.deepEqual(done.map((j) => j.name), ["내 학습"]);
  assert.equal(readdirSync(join(home, ".usagi-agent", "jobs")).length, 1, "다른 사람 결과는 건드리지 않는다");
  for (const bad of ["~/reo; rm -rf ~", "../x", "~/a/../b", "reo/jobs", "~/a b"]) await assert.rejects(pullJobs("gpu1", localSh, bad), /jobDirs/, bad);
  const cfg = loadConfig({}, { jobDirs: { "pacl-208": "~/reo/.usagi-agent/jobs", "-oX": "~/a", "gpu2": "~/a;b" } } as any);
  assert.deepEqual(cfg.jobDirs, { "pacl-208": "~/reo/.usagi-agent/jobs" });
  assert.ok(cfg.configNotes?.some((n) => /jobDirs/.test(n)));
});

// 실제 서버(pacl-208)에서 본 모양: 세션\t만든 시각\t마지막 활동\t창 프로그램\t창 폴더
test("parseTmux·mineOnly: 세션별로 합치고 셸만 있으면 쉬는 중, 공용 계정은 내 폴더 세션만", async () => {
  const panes = [
    ["claude", "1791532244", "1792224999", "claude", "/home/user/reo/dp"],
    ["train", "1792000000", "1792100000", "bash", "/home/user/reo/exp"],
    ["train", "1792000000", "1792100000", "python", "/home/user/reo/exp/sub"],
    ["idle", "1792000001", "1792000002", "-bash", "/home/user/reo/x"],
    ["other", "1792000001", "1792300000", "python", "/home/user/other/exp"],
    ["sibling", "1792000001", "1792000003", "vim", "/home/user/reo2/exp"],
    ["bad", "x", "1", "bash", "/p"],
  ];
  const all = parseTmux(panes);
  assert.deepEqual(all.map((s) => [s.name, s.running, s.path]), [
    ["other", "python", "/home/user/other/exp"], ["claude", "claude", "/home/user/reo/dp"], ["train", "python", "/home/user/reo/exp/sub"],
    ["sibling", "vim", "/home/user/reo2/exp"], ["idle", null, "/home/user/reo/x"]]);
  assert.deepEqual(mineOnly(all, "~/reo/.usagi-agent/jobs", "/home/user").map((s) => s.name), ["claude", "train", "idle"]); // reo2·other 는 내 폴더 밖
  assert.equal(mineOnly(all, "~/.usagi-agent/jobs", "/home/me").length, 5); // 개인 계정은 거르지 않음
  assert.equal(mineOnly(all, "~/exp/jobs", "/home/me").length, 5); // 개인 계정에서 jobDirs 를 따로 정해도 거르지 않음
  assert.deepEqual(mineOnly(all, "~/reo/.usagi-agent/jobs", ""), []); // 공용인데 홈을 모르면 아무것도 안 보임
  // 같은 ssh 호출 하나에 H·T 줄이 실려 오고 지우기 호출 말고는 ssh 가 늘지 않는다
  const calls: string[][] = [];
  const run: RunSsh = async (a) => { calls.push(a); return "H\t/home/user\nT\tclaude\t1791532244\t1792224999\tclaude\t/home/user/reo/dp\nT\tother\t1\t2\tpython\t/home/user/o\n"; };
  const r = await pullJobs("pacl-208", run, "~/reo/.usagi-agent/jobs");
  assert.deepEqual(r.tmux, [{ name: "claude", created: 1791532244, activity: 1792224999, running: "claude", path: "/home/user/reo/dp" }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0][2], /tmux list-panes -a -F/);
});

test("hostBackoff: 실패마다 간격이 두 배(상한 30분), 성공하면 처음으로", () => {
  let t = 0;
  const b = hostBackoff(120e3, 30 * 60e3, () => t);
  assert.ok(b.due("h"));
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    b.fail("h");
    let w = 0;
    while (!b.due("h")) { t += 120e3; w += 120e3; } // 2분 타이머가 도는 모양
    waits.push(w / 60e3);
  }
  assert.deepEqual(waits, [4, 8, 16, 30, 30, 30]);
  assert.ok(b.due("other"));
  b.fail("h"); b.ok("h");
  assert.ok(b.due("h"));
});

test("sharedMineDir: <내 폴더>/.usagi-agent/jobs 모양만 공용 계정", () => {
  assert.equal(sharedMineDir("~/reo/.usagi-agent/jobs"), "~/reo");
  assert.equal(sharedMineDir("/data/reo/.usagi-agent/jobs/"), "/data/reo");
  assert.equal(sharedMineDir("~/.usagi-agent/jobs"), undefined); // 기본 폴더 = 개인 계정
  assert.equal(sharedMineDir("~/exp/jobs"), undefined);
  assert.equal(sharedMineDir(undefined), undefined);
});
