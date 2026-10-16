import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { notePathFor, researchSummary } from "./research.ts";
import { notePath } from "./research-note.ts";
import { Bus } from "./bus.ts";

const NOW = new Date("2026-10-17T03:00:00Z"); // KST 12:00
const ago = (h: number) => new Date(NOW.getTime() - h * 3600e3).toISOString();

test("researchSummary: 연구 연결이 없으면 없음. 도는 작업은 다, 끝난 것은 최근 6개, 상태는 running·done·failed·lost", () => {
  const store = new Store(":memory:");
  assert.equal(researchSummary({ sshHosts: [], jobHosts: [], tineGraph: undefined }, store, NOW), undefined);
  store.upsertNode("job:g:run", "job", "학습", { host: "g", start: 100, running: true, cwd: "/w" }, ago(0.1));
  store.upsertNode("job:g:ok", "job", "평가", { host: "g", start: 100, seconds: 60, code: 0, files: ["a.json"] }, ago(1));
  store.upsertNode("job:g:bad", "job", "ablation", { host: "g", seconds: 5, code: 137 }, ago(2));
  store.upsertNode("job:g:lost", "job", "죽음", { host: "g", start: 100, lost: true }, ago(3));
  for (let i = 0; i < 8; i++) store.upsertNode(`job:old${i}`, "job", `옛 ${i}`, { seconds: 1, code: 0 }, ago(10 + i));
  store.upsertNode("job:ancient", "job", "아주 옛날", { seconds: 1, code: 0 }, ago(24 * 5));
  const r = researchSummary({ sshHosts: ["g"], jobHosts: ["g", "h"], tineGraph: undefined }, store, NOW)!;
  assert.deepEqual(r.hosts, ["g", "h"]);
  assert.deepEqual(r.jobs.map((j) => [j.name, j.state]), [["학습", "running"], ["평가", "done"], ["ablation", "failed"], ["죽음", "lost"], ["옛 0", "done"], ["옛 1", "done"], ["옛 2", "done"]]);
  assert.deepEqual(r.jobs[0], { id: "job:g:run", name: "학습", state: "running", at: ago(0.1), host: "g", start: 100, cwd: "/w" });
  assert.deepEqual(r.jobs[1].files, ["a.json"]);
  assert.equal(r.jobs[2].code, 137);
  assert.equal(r.note, undefined);
});

test("researchSummary·notePathFor: 오늘 노트가 있나, 어제 요약, 열 수 있는 경로만", () => {
  const graph = mkdtempSync(join(tmpdir(), "cy-tine-"));
  mkdirSync(join(graph, "pages"));
  const store = new Store(":memory:");
  const cfg = { sshHosts: [], jobHosts: [], tineGraph: graph };
  assert.deepEqual(researchSummary(cfg, store, NOW)!.note, { day: "2026-10-17", exists: false });
  writeFileSync(notePath(graph, "2026-10-17"), "x");
  store.upsertNode("note-summary:2026-10-16", "note-summary", "2026-10-16", { lines: ["a"], next: ["b"] });
  assert.deepEqual(researchSummary(cfg, store, NOW)!.note, { day: "2026-10-17", exists: true, yesterday: { day: "2026-10-16", lines: ["a"], next: ["b"] } });
  assert.equal(notePathFor(cfg, "2026-10-17"), notePath(graph, "2026-10-17"));
  assert.equal(notePathFor(cfg, "2026-10-16"), null); // 파일 없음
  assert.equal(notePathFor(cfg, "../../etc/passwd"), null);
  assert.equal(notePathFor({ tineGraph: undefined }, "2026-10-17"), null);
});

test("HTTP: /research/gpu·/research/note 는 헤더 필수, 노트 없으면 404", async () => {
  const bus = new Bus();
  let gpu = 0;
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    researchGpu: async () => { gpu++; return { hosts: [] }; },
    researchNote: (day) => (day === "2026-10-17" ? "/g/pages/n.md" : null),
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const get = (p: string, headers: Record<string, string> = { "x-cy-agent": "1" }) => fetch(`${base}${p}`, { headers });
  try {
    assert.equal((await get("/research/gpu", {})).status, 403);
    assert.equal(gpu, 0);
    assert.equal((await get("/research/gpu")).status, 200);
    assert.equal(gpu, 1);
    assert.deepEqual(await (await get("/research/note?day=2026-10-17")).json(), { path: "/g/pages/n.md" });
    assert.equal((await get("/research/note?day=2026-10-16")).status, 404);
  } finally {
    bus.close();
  }
});
