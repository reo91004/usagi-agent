import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRules, RULES, type Rules } from "./agent-rules.ts";
import { Bus } from "./bus.ts";
import type { RunSsh } from "./jobs.ts";

const dirWith = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "rules-"));
  for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
  return d;
};
const text = (d: string, f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : null);
// 이 Mac(fs)과 서버(실제 sh 로 도는 같은 스크립트) 두 길을 같은 폴더 모양으로 돌려 결과 바이트가 같은지 본다
const localSh: RunSsh = async (args) => {
  const r = spawnSync("sh", ["-c", args[2]], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};
const both = async (files: Record<string, string>, apply = true) => {
  const mac = dirWith(files), srv = dirWith(files);
  const a = await agentRules(mac, [mac], apply);
  const b = await agentRules(`gpu1:${srv}`, [`gpu1:${srv}`], apply, localSh);
  assert.deepEqual(a, b);
  for (const f of ["AGENTS.md", "CLAUDE.md"]) assert.equal(text(mac, f), text(srv, f), f);
  return { mac, res: a as Rules };
};

test("규칙: 둘 다 있으면 각각 끝에 덧붙이고 원래 내용은 앞에 그대로, 두 번 눌러도 한 번만", async () => {
  const { mac, res } = await both({ "AGENTS.md": "# 지침\n내용\n", "CLAUDE.md": "클로드 전용\n" });
  assert.deepEqual(res, { agents: "added", claude: "added" });
  assert.equal(text(mac, "AGENTS.md"), `# 지침\n내용\n\n${RULES}`);
  assert.equal(text(mac, "CLAUDE.md"), `클로드 전용\n\n${RULES}`);
  const before = text(mac, "AGENTS.md");
  assert.deepEqual(await agentRules(mac, [mac], true), res);
  assert.equal(text(mac, "AGENTS.md"), before);
});

test("규칙: AGENTS 만 있으면 CLAUDE.md 는 @AGENTS.md 한 줄로 새로 만든다(이미 가져오는 CLAUDE.md 는 그대로)", async () => {
  const { mac, res } = await both({ "AGENTS.md": "x\n" });
  assert.deepEqual(res, { agents: "added", claude: "imports" });
  assert.equal(text(mac, "CLAUDE.md"), "@AGENTS.md\n");
  const imp = await both({ "AGENTS.md": "x\n", "CLAUDE.md": "# a\n@AGENTS.md\n" });
  assert.deepEqual(imp.res, { agents: "added", claude: "imports" });
  assert.equal(text(imp.mac, "CLAUDE.md"), "# a\n@AGENTS.md\n");
});

test("규칙: 둘 다 없으면 AGENTS.md 는 정본 글 그대로 새로 만든다", async () => {
  const { mac, res } = await both({});
  assert.deepEqual(res, { agents: "added", claude: "imports" });
  assert.equal(text(mac, "AGENTS.md"), RULES);
  assert.equal(text(mac, "CLAUDE.md"), "@AGENTS.md\n");
});

test("규칙: 사람이 이미 넣은 표시가 있으면 손대지 않고, 끝 줄바꿈 없는 파일은 줄바꿈 하나만 먼저 넣는다", async () => {
  const done = await both({ "AGENTS.md": `앞\n\n${RULES}`, "CLAUDE.md": "<!-- usagi-run:v1 -->\n" });
  assert.deepEqual(done.res, { agents: "added", claude: "added" });
  assert.equal(text(done.mac, "AGENTS.md"), `앞\n\n${RULES}`);
  assert.equal(text(done.mac, "CLAUDE.md"), "<!-- usagi-run:v1 -->\n");
  const noNl = await both({ "AGENTS.md": "끝줄바꿈 없음", "CLAUDE.md": "" });
  assert.equal(text(noNl.mac, "AGENTS.md"), `끝줄바꿈 없음\n\n${RULES}`);
  assert.equal(noNl.res.claude, "added");
});

test("규칙: 상태만 읽을 때는 아무것도 쓰지 않는다", async () => {
  const { mac, res } = await both({ "AGENTS.md": "x\n" }, false);
  assert.deepEqual(res, { agents: "missing", claude: "absent" });
  assert.equal(text(mac, "AGENTS.md"), "x\n");
  assert.equal(text(mac, "CLAUDE.md"), null);
});

test("규칙: 연구·프로젝트 폴더가 아니거나 안전하지 않은 경로는 error", async () => {
  const d = dirWith({});
  for (const p of [d, "/etc", 5, undefined]) assert.ok("error" in (await agentRules(p, [join(d, "other")], true, localSh)), String(p)); // 목록 밖
  for (const p of ["gpu1:/a/../b", "-o:/a", "gpu1:/a b", "gpu1:rel"]) assert.ok("error" in (await agentRules(p, [p], true, localSh)), p); // 목록 안이어도 모양이 나쁨
  assert.ok("error" in (await agentRules(join(d, "none"), [join(d, "none")], true)));
  assert.equal(text(d, "AGENTS.md"), null);
});

test("GET·POST /research/projects/rules: 헤더 필수, 목록 밖 경로는 400", async () => {
  const d = dirWith({});
  const bus = new Bus();
  await bus.listen(0, { approve: async () => {}, hold: async () => {}, briefing: async () => {}, dashboard: async () => ({}), todoDone: () => true, chat: () => "c",
    agentRules: (p, apply) => agentRules(p, [d], apply) });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}/research/projects/rules`;
  const h = { "x-cy-agent": "1", "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${base}?path=${encodeURIComponent(d)}`)).status, 403);
    assert.equal((await fetch(base, { method: "POST", body: JSON.stringify({ path: d }) })).status, 403);
    assert.equal((await fetch(`${base}?path=/etc`, { headers: h })).status, 400);
    assert.equal((await fetch(base, { method: "POST", headers: h, body: "null" })).status, 400);
    assert.deepEqual(await (await fetch(`${base}?path=${encodeURIComponent(d)}`, { headers: h })).json(), { agents: "absent", claude: "absent" });
    assert.deepEqual(await (await fetch(base, { method: "POST", headers: h, body: JSON.stringify({ path: d }) })).json(), { agents: "added", claude: "imports" });
    assert.equal(text(d, "AGENTS.md"), RULES);
  } finally {
    bus.close();
  }
});
