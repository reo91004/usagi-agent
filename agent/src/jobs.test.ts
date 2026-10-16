import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJobDone, jobBubble, okJobHost, pullJobs, type RunSsh } from "./jobs.ts";
import { setCharacter } from "./characters.ts";
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

test("pullJobs: 파일 이름<TAB>내용을 읽고 읽은 파일만 지운다. 깨진 내용·이상한 이름은 건너뛰되 깨진 파일은 지운다", async () => {
  const calls: string[][] = [];
  const run: RunSsh = async (args) => {
    calls.push(args);
    if (calls.length > 1) return "";
    return [
      `20261016-1-1.json\t{"name":"학습","seconds":10,"code":0}`,
      `20261016-1-2.json\t{"name":"평가","seconds":5,"code":2}`,
      `broken.json\t{oops`,
      `../evil.json\t{"name":"x","seconds":1,"code":0}`,
      `no tab line`,
    ].join("\n");
  };
  const jobs = await pullJobs("gpu1", run);
  assert.deepEqual(jobs, [{ name: "학습", seconds: 10, code: 0, host: "gpu1" }, { name: "평가", seconds: 5, code: 2, host: "gpu1" }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ["--", "gpu1"]);
  assert.equal(calls[1][2], "cd ~/.usagi-agent/jobs && rm -f -- '20261016-1-1.json' '20261016-1-2.json' 'broken.json'");
  // 끝난 게 없으면 지우지 않는다
  const quiet: string[][] = [];
  assert.deepEqual(await pullJobs("gpu1", async (a) => { quiet.push(a); return ""; }), []);
  assert.equal(quiet.length, 1);
  await assert.rejects(pullJobs("-oProxyCommand=x", run), /jobHosts/);
});

test("HTTP: POST /jobs/done 은 헤더 필수, 잘못된 본문은 400, 맞으면 처리기로", async () => {
  const bus = new Bus();
  const got: unknown[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}),
    todoDone: () => true, chat: () => "c", chatHistory: () => [],
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
  assert.deepEqual(j, { name: `학습 "v2"\\끝 탭`, seconds: j!.seconds, code: 3 });
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
    assert.throws(() => readdirSync(join(home, ".usagi-agent", "jobs")), /ENOENT/);
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
  const jobs = await pullJobs("gpu1", localSh);
  assert.deepEqual(jobs.map((j) => [j.name, j.code, j.host]).sort(), [["학습 A", 0, "gpu1"], ["학습 B", 1, "gpu1"]]);
  assert.deepEqual(readdirSync(join(home, ".usagi-agent", "jobs")), []);
  assert.deepEqual(await pullJobs("gpu1", localSh), []);
  // 폴더가 아직 없는 서버도 조용히 빈 목록
  assert.deepEqual(await pullJobs("gpu1", async (a) => spawnSync("sh", ["-c", a[2]], { env: { ...env, HOME: mkdtempSync(join(tmpdir(), "empty-")) }, encoding: "utf8" }).stdout), []);
});
