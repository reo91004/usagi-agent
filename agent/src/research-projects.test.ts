import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { buildDashboard } from "./dashboard.ts";
import { expName, putResearchProject } from "./research-projects.ts";
import { researchSummary } from "./research.ts";

const now = new Date("2026-10-08T05:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * 3600e3).toISOString();
const build = (store: Store, tmux = {}) => buildDashboard(loadConfig(), store, { now, git: async () => [], tmux });

function session(store: Store, id: string, cwd: string, updated: string) {
  store.upsertNode(`session:${id}`, "session", `세션 ${id}`, { cwd, tool: "claude" }, updated);
  store.upsertNode(`project:${cwd}`, "project", cwd, { path: cwd }, updated);
  store.link(`session:${id}`, "in", `project:${cwd}`);
}
function job(store: Store, id: string, label: string, props: Record<string, unknown>, updated: string) {
  store.upsertNode(`job:${id}`, "job", label, props, updated);
}

test("실험 이름: -n, 스크립트+설정, tmux 세션 이름, 폴더+명령 순", () => {
  assert.equal(expName({ name: "baseline", cmd: "python train.py --cfg a.yaml" }), "baseline");
  assert.equal(expName({ name: "python train.py --config cfgs/exp7.yaml", cmd: "python train.py --config cfgs/exp7.yaml" }), "train.py · exp7");
  assert.equal(expName({ name: "python /w/train.py --run_name=r1 --lr 3", cmd: "python /w/train.py --run_name=r1 --lr 3" }), "train.py · r1");
  assert.equal(expName({ tmuxName: "ablation", cmd: "python", cwd: "s:/w/dp" }), "ablation");
  assert.equal(expName({ tmuxName: "0", cmd: "make all", cwd: "s:/w/dp" }), "dp make all");
  assert.equal(expName({ name: "make all", cmd: "make all", cwd: "/w/dp" }), "dp make all");
});

test("서버 job·tmux 가 서버 세션 폴더와 같은 키로 묶이고 후보·종류·합치기가 동작한다", async () => {
  const store = new Store(":memory:");
  session(store, "a", "srv:/work/dp", ago(3));
  job(store, "1", "python train.py --cfg c/e1.yaml", { host: "srv", cwd: "/work/dp/sub", cmd: "python train.py --cfg c/e1.yaml", code: 0, seconds: 5 }, ago(2));
  job(store, "2", "python train.py", { host: "srv", cwd: "/work/dp", cmd: "python train.py", running: true, start: 100 }, ago(1));
  job(store, "3", "x", { host: "srv", cwd: "/work/dp", cmd: "x", code: 1, seconds: 1 }, ago(5));
  job(store, "4", "y", { host: "srv", cwd: "/home/u", cmd: "y", code: 0, seconds: 1 }, ago(5)); // 서버 홈은 뺀다
  const tmux = { srv: { at: ago(0), sessions: [{ name: "sweep", created: 1, activity: 1_791_000_000, running: "python", path: "/work/dp" }, { name: "0", created: 1, activity: 1, running: null, path: "/work/dp" }] } };
  let d = await build(store, tmux);
  assert.equal(d.researchProjects.length, 1);
  const c = d.researchProjects[0];
  assert.equal(c.key, "srv:/work/dp");
  assert.equal(c.kind, null);
  assert.equal(c.name, "dp");
  assert.deepEqual(c.running.map((e) => [e.kind, e.name]).sort(), [["job", "train.py"], ["tmux", "sweep"]]);
  assert.deepEqual([c.recent.done, c.recent.failed, c.recent.lost], [1, 1, 0]);
  assert.equal(c.recent.items[0].name, "train.py · e1");
  assert.equal(c.sessions[0].tool, "claude");
  assert.equal(d.projects[0].hiddenByResearch, undefined);

  const r = researchSummary({ sshHosts: ["srv"], jobHosts: [], tineGraph: undefined } as any, store, now, tmux, d.researchProjects)!;
  assert.ok(r.jobs.filter((j) => j.cwd?.startsWith("/work")).every((j) => j.project === "srv:/work/dp"));
  assert.equal(r.tmux.srv.sessions[0].label, "sweep");
  assert.equal(r.tmux.srv.sessions[0].project, "srv:/work/dp");

  assert.deepEqual(putResearchProject(store, { key: "srv:/work/dp", kind: "research", name: "논문", subs: [{ venue: "ICML", stage: "review", deadline: "2026-12-01" }] }, now), { ok: true });
  assert.deepEqual(putResearchProject(store, { key: "srv:/work/other", mergeInto: "srv:/work/dp" }, now), { ok: true });
  d = await build(store, tmux);
  const p = d.researchProjects[0];
  assert.deepEqual([p.kind, p.name, p.subs[0].at], ["research", "논문", now.toISOString()]);
  assert.deepEqual(p.folders.map((f) => f.path), ["srv:/work/dp", "srv:/work/other"]);
  assert.equal(d.projects.find((x) => x.path === "srv:/work/dp")!.hiddenByResearch, true);

  putResearchProject(store, { key: "srv:/work/dp", kind: "none" });
  d = await build(store, tmux);
  assert.equal(d.researchProjects.length, 0);
  assert.equal(d.projects.find((x) => x.path === "srv:/work/dp")!.hiddenByResearch, undefined);
});

test("정한 프로젝트는 활동이 없어도 나오고, 순서는 마감 가까운 연구 → 프로젝트 → 후보", async () => {
  const store = new Store(":memory:");
  const sub = (deadline?: string) => [{ venue: "V", stage: "prep", ...(deadline ? { deadline } : {}) }];
  putResearchProject(store, { key: "/Users/x/p1", kind: "project" });
  putResearchProject(store, { key: "srv:/r/late", kind: "research", subs: sub("2027-01-01") });
  putResearchProject(store, { key: "srv:/r/soon", kind: "research", subs: sub("2026-11-01") });
  putResearchProject(store, { key: "srv:/r/none", kind: "research" });
  session(store, "a", "srv:/c/cand", ago(1));
  session(store, "b", "srv:/c/cand", ago(2));
  const d = await build(store);
  assert.deepEqual(d.researchProjects.map((p) => p.key), ["srv:/r/soon", "srv:/r/late", "srv:/r/none", "/Users/x/p1", "srv:/c/cand"]);
  assert.equal(d.researchProjects[0].lastActive, null);
});

test("PUT 본문을 엄격하게 검사한다", () => {
  const store = new Store(":memory:");
  const bad = [
    null, [], {}, { key: "a\nb" }, { key: "k", kind: "x" }, { key: "k", name: "" }, { key: "k", name: "x".repeat(81) },
    { key: "k", url: "ftp://a" }, { key: "k", url: "javascript:alert(1)" }, { key: "k", mergeInto: "k" },
    { key: "k", subs: Array(21).fill({ venue: "V", stage: "prep" }) }, { key: "k", subs: [{ venue: "V", stage: "nope" }] },
    { key: "k", subs: [{ venue: "", stage: "prep" }] }, { key: "k", subs: [{ venue: "V", stage: "prep", deadline: "2026-02-30" }] },
    { key: "k", subs: [{ venue: "V", stage: "prep", at: "x" }] },
  ];
  for (const b of bad) assert.ok("error" in putResearchProject(store, b as any), JSON.stringify(b));
  assert.equal(store.researchMeta().length, 0);
  assert.deepEqual(putResearchProject(store, { key: "k", url: "https://overleaf.com/p", name: "n" }), { ok: true });
  assert.deepEqual(putResearchProject(store, { key: "k", url: null, name: null, kind: "project" }), { ok: true });
  const m = store.researchMeta()[0];
  assert.deepEqual([m.url, m.name, m.kind], [null, null, "project"]);
  putResearchProject(store, { key: "m", mergeInto: "k" });
  assert.ok("error" in putResearchProject(store, { key: "z", mergeInto: "m" })); // 이미 합쳐진 폴더에는 못 합친다
  assert.ok("error" in putResearchProject(store, { key: "k", mergeInto: "z" })); // 합쳐 들어온 폴더가 있는 대표는 못 합친다
  assert.deepEqual(putResearchProject(store, { key: "m", mergeInto: null }), { ok: true });
});
