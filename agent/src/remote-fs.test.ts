import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatGpu, formatList, parseGpu, remoteGpuData, formatRead, readScript, remoteFind, remoteGpu, remoteLs, remotePath, remoteRead, size, when, type RemoteRun } from "./remote-fs.ts";

const cfg = { sshHosts: ["gpu1"], jobHosts: ["gpu2"] };
const sh = (script: string, home: string) => spawnSync("sh", ["-c", script], { env: { ...process.env, HOME: home }, encoding: "utf8" }).stdout;

test("remotePath: 홈 기준으로 풀고, 따옴표·셸 문자는 글자 그대로(주입 안 됨)", () => {
  const home = mkdtempSync(join(tmpdir(), "rfs-"));
  for (const [p, want] of [["~", home], ["~/exp/a b", `${home}/exp/a b`], ["exp", `${home}/exp`], ["/etc/x", "/etc/x"], [`~/x'; touch PWNED; echo '`, `${home}/x'; touch PWNED; echo '`], ["~/$(id)`id`", `${home}/$(id)\`id\``]] as const) {
    assert.equal(sh(`printf '%s' ${remotePath(p)}`, home), want, p);
  }
  for (const bad of ["", "  ", "~root/x", "a\nb", 3, null, "x".repeat(1001)]) assert.equal(remotePath(bad), null, String(bad));
});

test("readScript: 없는 경로·비밀 파일은 거절하고, 심볼릭 링크로 돌아가도 실제 경로로 막는다", () => {
  const home = mkdtempSync(join(tmpdir(), "rfs-"));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_ed25519"), "SECRET");
  writeFileSync(join(home, ".env"), "TOKEN=1");
  writeFileSync(join(home, ".bash_history"), "export HF_TOKEN=hf_x");
  symlinkSync(join(home, ".ssh", "id_ed25519"), join(home, "innocent.txt"));
  const read = (p: string) => sh(readScript(remotePath(p)!, { mode: "tail", bytes: 100 }), home).split("\n")[0];
  assert.equal(read("~/innocent.txt"), "ERR 비밀 파일·폴더라 열지 않아요");
  assert.equal(read("~/.ssh/id_ed25519"), "ERR 비밀 파일·폴더라 열지 않아요");
  assert.equal(read("~/.env"), "ERR 비밀 파일·폴더라 열지 않아요");
  assert.equal(read("~/.bash_history"), "ERR 비밀 파일·폴더라 열지 않아요");
  assert.equal(read("~/없음"), "ERR 없는 경로예요");
  assert.ok(!sh(readScript(remotePath("~/innocent.txt")!, { mode: "match", text: "SECRET" }), home).includes("SECRET"));
});

test("formatList: 최근 순 줄, 폴더는 /, 전체 수와 시간 초과 안내", () => {
  const t = 1792171509;
  const out = `OK /home/u/exp\n${t}\td\t4096\truns/\n${t - 60}\tf\t1536\tlog.txt\nTOTAL\t120\t124\n`;
  const r = formatList(out, "폴더 gpu1:", 2);
  assert.equal(r.ok, true);
  assert.equal(r.title, "폴더 gpu1: /home/u/exp · 전체 120개 중 최근 2개");
  assert.equal(r.body.split("\n")[0], `- ${when(t)}  runs/`);
  assert.equal(r.body.split("\n")[1], `- ${when(t - 60)}  log.txt  (1.5 KB)`);
  assert.match(r.body, /다 훑지 못했어요/);
  assert.deepEqual(formatList("ERR 없는 경로예요\n", "x", 5), { ok: false, title: "x", body: "없는 경로예요" });
  assert.equal(formatList("bash: oops\n", "x", 5).ok, false);
});

test("formatRead·formatGpu·size", () => {
  assert.match(formatRead("OK 2048 1792171509 /h/r.json\nBIN\n", "파일 gpu1:", { mode: "tail", bytes: 100 }).body, /바이너리/);
  const r = formatRead("OK 10 1792171509 /h/log.txt\n3:acc 0.91\n", "파일 gpu1:", { mode: "match", text: "acc" });
  assert.match(r.title, /\/h\/log\.txt \(10 B, .* 수정\) · 「acc」 들어간 줄/);
  assert.equal(r.body, "3:acc 0.91");
  const g = formatGpu("OK\nG\t0, 00000000:01:00.0, NVIDIA RTX 4090, 97, 20000, 24564, 71\nP\t00000000:01:00.0\t4242\t19000\tuser 01:02:03 python train.py --lr 3e-4\n", "gpu1");
  assert.equal(g.body, "- GPU0 NVIDIA RTX 4090: 사용률 97% · 메모리 20000/24564 MiB · 71°C\n- 돌고 있는 프로세스:\n  - GPU0 pid 4242 · 19000 MiB · user 01:02:03 python train.py --lr 3e-4");
  assert.equal(size(5), "5 B");
  assert.equal(size(10 * 1024 * 1024 * 1024), "10 GB");
});

test("도구 본체: 설정한 서버만, 숫자는 범위 안으로, 접속 실패는 오류 결과로", async () => {
  const seen: [string, string][] = [];
  const run: RemoteRun = async (h, s) => { seen.push([h, s]); return "OK /home/u\nTOTAL\t0\t0\n"; };
  assert.equal((await remoteLs(cfg, { host: "evil" }, run)).ok, false);
  assert.match((await remoteLs({ sshHosts: [], jobHosts: [] }, { host: "gpu1" }, run)).body, /sshHosts/);
  assert.equal(seen.length, 0);
  await remoteLs(cfg, { host: "gpu2", path: "~/exp", depth: 99, limit: 9999 }, run); // jobHosts 서버도 된다
  assert.match(seen[0][1], /-maxdepth 4 /);
  assert.match(seen[0][1], /-v L=200 /);
  await remoteFind(cfg, { host: "gpu1", name: "metrics", hours: 3 }, run);
  assert.match(seen[1][1], /-iname '\*metrics\*' -mmin -180 /);
  assert.equal((await remoteFind(cfg, { host: "gpu1", name: "a/b" }, run)).ok, false);
  assert.equal((await remoteRead(cfg, { host: "gpu1", path: "~/a\nb" }, run)).ok, false);
  const down: RemoteRun = async () => { throw new Error("Connection timed out"); };
  const r = await remoteRead(cfg, { host: "gpu1", path: "~/log" }, down);
  assert.deepEqual([r.ok, r.body], [false, "gpu1 에 접속하지 못했어요: Connection timed out"]);
  assert.deepEqual((await remoteGpu(cfg, {}, async (h) => `ERR nvidia-smi 가 없어요 ${h}`)).map((x) => x.title), ["GPU gpu1", "GPU gpu2"]);
});

test("parseGpu·remoteGpuData: 패널 카드용 구조, 서버 하나가 안 되면 그 서버만 실패", async () => {
  const out = "OK\nG\t0, 00000000:01:00.0, NVIDIA RTX 4090, 97, 20000, 24564, 71\nG\t1, 00000000:02:00.0, NVIDIA RTX 4090, 0, 15, 24564, 40\nP\t00000000:01:00.0\t4242\t19000\tuser 01:02:03 python train.py\n";
  assert.deepEqual(parseGpu(out, "g"), { host: "g", ok: true, gpus: [
    { idx: "0", name: "NVIDIA RTX 4090", util: 97, memUsed: 20000, memTotal: 24564, temp: 71 },
    { idx: "1", name: "NVIDIA RTX 4090", util: 0, memUsed: 15, memTotal: 24564, temp: 40 },
  ], procs: [{ gpu: "0", pid: "4242", mem: 19000, who: "user 01:02:03 python train.py" }] });
  const r = await remoteGpuData(cfg, async (h) => { if (h === "gpu2") throw new Error("timeout"); return out; });
  assert.deepEqual(r.map((x) => [x.host, x.ok, x.gpus.length, x.error]), [["gpu1", true, 2, undefined], ["gpu2", false, 0, "접속하지 못했어요: timeout"]]);
});
