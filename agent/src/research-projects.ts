// 연구 탭의 연구 프로젝트(GET /dashboard 의 researchProjects, PUT /research/projects). 새 수집 없이 이미 쌓인 작업 폴더·세션·job 노드·tmux 메모리만 묶는다.
// 세션·job 은 30일 창이다. 작업 폴더(dashboard.ts projects)의 7일 창보다 길어 일주일 넘게 쉰 연구도 작업 기록이 남는다
// 폴더 키는 작업 폴더 path 와 같은 모양: 이 Mac 은 레포 루트 절대 경로, 서버는 「서버:/경로」
import { existsSync } from "node:fs";
import { cutHidden, gitRootOf, insideOf, isNoisePath, splitHost, type DashProject } from "./dashboard.ts";
import { okJobHost, tmuxSeen } from "./jobs.ts";
import type { Node, ResearchMetaRow, Store } from "./store.ts";

export const STAGES = ["prep", "submitted", "rebuttal", "accepted", "rejected"] as const;
export type Stage = (typeof STAGES)[number];
export type Submission = { venue: string; stage: Stage; deadline?: string; at: string };
export type Experiment = {
  name: string; host: string; kind: "job" | "tmux"; cwd?: string; cmd?: string; start?: number;
  seconds?: number; code?: number | null; lost?: boolean; running: boolean;
  ai?: string; // tmux 에서 도는 AI CLI(claude 등)면 도구 이름. 실험이 아니라 AI 작업이다
  id?: string; // usagi-run 기록(job 노드 id) — 패널 「지우기」(POST /research/jobs/forget)
};
export type ResearchProject = {
  key: string; kind: "research" | "project" | null; name: string; folders: { path: string; onMac?: boolean }[];
  subs: Submission[]; url?: string; lastActive: string | null; running: Experiment[];
  recent: { done: number; failed: number; lost: number; items: Experiment[] };
  sessions: { title: string; tool: string; at: string }[];
};

const WINDOW = 30 * 864e5, MAX_CAND = 8;
const LOST_AFTER = 14 * 864e5; // main.ts jobsRunning 이 표시 없는 job 을 lost 로 바꾸는 창과 같다
const TMUX_FRESH = 15 * 60e3; // 이보다 오래 응답이 없던 서버의 tmux 메모리는 믿지 않는다
const AI_TOOLS = new Set(["claude", "codex", "agy", "gemini", "aider", "cursor-agent", "opencode"]);
// tmux 에서 도는 명령의 첫 단어(basename)가 AI CLI 면 그 이름
export const aiTool = (running: string | null | undefined): string | undefined => { const w = baseName((running ?? "").trim().split(/\s+/)[0] ?? "").toLowerCase(); return AI_TOOLS.has(w) ? w : undefined; };
const LIVE = new Set<string>(["prep", "submitted", "rebuttal"]);

// ---- 실험 이름: 보여 줄 때 계산하고 저장하지 않는다 ----
const NAME_FLAG = /^(?:--(?:config|cfg|name|exp|exp_name|run_name|run-name|output)|-c)$/;
const baseName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir;
const stem = (v: string) => baseName(v.replace(/^['"]|['"]$/g, "")).replace(/\.[^.]+$/, "");
function scriptName(cmd: string): string | null {
  const t = cmd.split(/\s+/);
  const at = t.findIndex((x) => /\.(?:py|sh|jl|r|js|ts|m)$/i.test(x));
  if (at < 0) return null;
  const script = t[at];
  for (let i = at + 1; i < t.length; i++) { // 스크립트 뒤의 옵션만 (bash -c '…' 같은 앞쪽 옵션은 제외)
    const m = /^(--[\w-]+)=(.+)$/.exec(t[i]);
    const flag = m ? m[1] : t[i], v = m ? m[2] : t[i + 1];
    if (NAME_FLAG.test(flag) && v && !v.startsWith("-") && stem(v)) return `${baseName(script)} · ${stem(v)}`;
  }
  return baseName(script);
}
export function expName(e: { name?: string; cmd?: string; cwd?: string; tmuxName?: string }): string {
  // usagi-run -n: -n 이 없으면 이름이 명령 앞 120자 그대로다(jobs.ts NAME_MAX)
  if (!e.tmuxName && e.name && e.name !== (e.cmd ?? "").slice(0, 120)) return e.name;
  const s = e.cmd ? scriptName(e.cmd) : null;
  if (s) return s;
  if (e.tmuxName && !/^(?:\d+|main|sh|bash|zsh|fish)$/.test(e.tmuxName)) return e.tmuxName;
  return `${e.cwd ? baseName(splitHost(e.cwd).dir) : ""} ${(e.cmd ?? e.name ?? "").slice(0, 40)}`.trim();
}

// job·tmux 의 (서버, cwd) → 작업 폴더 키. 서버는 세션 cwd 와 같은 「서버:/경로」, 이 Mac 은 gitRootOf
export const folderKey = (host: string, cwd: string) => (host ? `${host}:${cutHidden(cwd)}` : gitRootOf(cutHidden(cwd)));
const serverHome = (path: string) => { const { host, dir } = splitHost(path); return !!host && /^\/(?:home\/[^/]+|root)?\/?$/.test(dir); };

// 알려진 폴더로 맞춘다: 정확히 같은 것, 아니면 가장 가까운 바깥 폴더. 없으면 그 키 자체
function resolver(known: Iterable<string>) {
  const list = [...known].sort((a, b) => b.length - a.length);
  return (k: string) => list.find((o) => o === k) ?? list.find((o) => insideOf(k, o)) ?? k;
}

type Item = { exp: Experiment; at: string; state: "running" | "done" | "failed" | "lost" };
type Acc = { folders: string[]; items: Item[]; sessions: Node[]; dashActive: string[] };

export function buildResearchProjects(store: Store, dash: DashProject[], now: Date, withSessions: boolean, tmux: typeof tmuxSeen = tmuxSeen): ResearchProject[] {
  const meta = new Map(store.researchMeta().map((m) => [m.path, m]));
  const known = new Set([...dash.map((p) => p.path), ...meta.keys(), ...[...meta.values()].flatMap((m) => (m.mergedInto ? [m.mergedInto] : []))]);
  const resolve = resolver(known);
  const accs = new Map<string, Acc>();
  const acc = (folder: string) => {
    const rep = meta.get(folder)?.mergedInto ?? folder;
    if (!accs.has(rep)) accs.set(rep, { folders: [rep], items: [], sessions: [], dashActive: [] });
    const a = accs.get(rep)!;
    if (!a.folders.includes(folder)) a.folders.push(folder);
    return a;
  };
  const noise = (k: string) => isNoisePath(k) || serverHome(k);

  for (const m of meta.values()) if (m.kind === "research" || m.kind === "project" || m.mergedInto) acc(m.path);
  const hidden = store.hiddenProjects();
  for (const p of dash) {
    if (p.hidden && !meta.has(p.path)) continue;
    acc(p.path).dashActive.push(p.lastActive);
  }
  const since = new Date(now.getTime() - WINDOW).toISOString();
  // 세션 노드는 자기 cwd 의 project 노드에 이어진다(ingest/sessions.ts). cwd 로 묶으면 질의 한 번이고, 서버 이름을 나중에 알게 돼 옛 project 노드에도 남은 간선은 저절로 빠진다
  for (const s of withSessions ? store.nodesSince("session", since, 1000) : []) {
    const cwd = s.props.cwd;
    if (typeof cwd !== "string" || !cwd) continue;
    const { host, dir } = splitHost(cwd), key = resolve(folderKey(host, dir));
    if (!noise(key)) acc(key).sessions.push(s);
  }
  for (const j of store.nodesSince("job", since, 5000)) { // 최근 순. 집계가 잘리지 않게 넉넉히
    const p = j.props as Record<string, any>;
    if (!p.cwd) continue;
    const host = String(p.host ?? ""), key = resolve(folderKey(host, String(p.cwd)));
    if (noise(key)) continue;
    const state = p.running && now.getTime() - Date.parse(j.updated) > LOST_AFTER ? "lost" : p.running ? "running" : p.lost ? "lost" : p.code !== null && p.code !== undefined && p.code !== 0 ? "failed" : "done";
    const exp: Experiment = {
      id: j.id, name: expName({ name: j.label, cmd: p.cmd, cwd: p.cwd }), host, kind: "job", cwd: String(p.cwd), ...(p.cmd ? { cmd: String(p.cmd) } : {}),
      ...(Number(p.start) > 0 ? { start: Number(p.start) } : {}),
      ...(state === "done" || state === "failed" ? { seconds: Number(p.seconds) || 0, code: Number.isInteger(p.code) ? p.code : null } : {}),
      ...(state === "lost" ? { lost: true } : {}), running: state === "running",
    };
    acc(key).items.push({ exp, at: j.updated, state });
  }
  for (const [host, t] of Object.entries(tmux)) {
    if (now.getTime() - Date.parse(t.at) > TMUX_FRESH) continue;
    for (const s of t.sessions) {
      if (!s.running || !s.path) continue; // 돌고 있는 명령이 있는 세션만 실험으로 본다
      const key = resolve(folderKey(host, s.path));
      if (noise(key)) continue;
      const exp: Experiment = { name: expName({ tmuxName: s.name, cmd: s.running, cwd: s.path }), host, kind: "tmux", cwd: s.path, cmd: s.running, ...(aiTool(s.running) ? { ai: aiTool(s.running) } : {}), ...(s.created > 0 ? { start: s.created } : {}), running: true };
      acc(key).items.push({ exp, at: new Date((s.activity > 0 ? s.activity : s.created) * 1000).toISOString(), state: "running" });
    }
  }

  const out: (ResearchProject & { dl?: string })[] = [];
  for (const [rep, a] of accs) {
    const m = meta.get(rep);
    if (m?.kind === "none") continue;
    if (!m?.kind && (noise(rep) || store.isHiddenPath(rep, hidden) || !(a.items.some((i) => !i.exp.ai) || a.sessions.length >= 2))) continue;
    const sessions = a.sessions.sort((x, y) => y.updated.localeCompare(x.updated));
    const done = a.items.filter((i) => i.state !== "running");
    const last = [...a.dashActive, ...a.sessions.map((s) => s.updated), ...a.items.map((i) => i.at)].sort().at(-1);
    const subs = (m?.subs ?? []) as Submission[];
    const cur = subs.at(-1);
    out.push({
      key: rep, kind: m?.kind === "research" || m?.kind === "project" ? m.kind : null, name: m?.name || baseName(splitHost(rep).dir), subs,
      folders: a.folders.map((path) => ({ path, ...(splitHost(path).host ? {} : { onMac: existsSync(path) }) })),
      ...(m?.url ? { url: m.url } : {}), lastActive: last ? new Date(last).toISOString() : null,
      running: a.items.filter((i) => i.state === "running").map((i) => i.exp),
      recent: { done: done.filter((i) => i.state === "done").length, failed: done.filter((i) => i.state === "failed").length, lost: done.filter((i) => i.state === "lost").length, items: done.slice(0, 5).map((i) => i.exp) },
      sessions: sessions.slice(0, 5).map((s) => ({ title: s.label, tool: String(s.props.tool ?? ""), at: s.updated })),
      ...(m?.kind === "research" && cur && LIVE.has(cur.stage) && cur.deadline ? { dl: cur.deadline } : {}),
    });
  }
  const byActive = (x: ResearchProject, y: ResearchProject) => (y.lastActive ?? "").localeCompare(x.lastActive ?? "");
  const research = out.filter((p) => p.kind === "research").sort((x, y) => (x.dl && y.dl ? x.dl.localeCompare(y.dl) : x.dl ? -1 : y.dl ? 1 : 0) || byActive(x, y));
  const rest = (k: ResearchProject["kind"]) => out.filter((p) => p.kind === k).sort(byActive);
  return [...research, ...rest("project"), ...rest(null).slice(0, MAX_CAND)].map(({ dl: _dl, ...p }) => p);
}

// job·tmux 항목이 속한 연구 프로젝트 key. 알려진 폴더 안쪽이면 가장 가까운 바깥 폴더로
export function projectOf(projects: ResearchProject[], host: string | undefined, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const k = folderKey(host ?? "", cwd);
  const flat = projects.flatMap((p) => p.folders.map((f) => ({ path: f.path, key: p.key })));
  return (flat.find((f) => f.path === k) ?? flat.filter((f) => insideOf(k, f.path)).sort((a, b) => b.path.length - a.path.length)[0])?.key;
}

// ---- PUT /research/projects: 데몬이 신뢰 경계 ----
const line = (v: unknown, max: number): v is string => typeof v === "string" && v.length >= 1 && v.length <= max && v === v.trim() && !/[\r\n]/.test(v);
// 작업 폴더 키 모양: 절대 경로 또는 「서버:/경로」(서버는 ssh 별칭 규칙)
const okKey = (v: unknown): v is string => line(v, 500) && (v.startsWith("/") || (/^[^:]+:\//.test(v) && okJobHost(v.slice(0, v.indexOf(":")))));
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v);

export function putResearchProject(store: Store, body: any, now = new Date()): { ok: true } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be an object" };
  const { key, kind, name, subs, url, mergeInto } = body;
  if (!okKey(key)) return { error: "key must be an absolute path or host:/path, one line up to 500 chars" };
  if (kind !== undefined && kind !== "research" && kind !== "project" && kind !== "none") return { error: "kind must be research|project|none" };
  if (name !== undefined && name !== null && !line(name, 80)) return { error: "name must be a one-line string up to 80 chars or null" };
  if (url !== undefined && url !== null) {
    if (!line(url, 500) || !/^https?:\/\/[^\s]+$/i.test(url) || !URL.canParse(url)) return { error: "url must be http(s) up to 500 chars or null" };
  }
  let newSubs: Submission[] | undefined;
  if (subs !== undefined) {
    if (!Array.isArray(subs) || subs.length > 20) return { error: "subs must be an array of up to 20" };
    newSubs = [];
    for (const s of subs) {
      if (!s || typeof s !== "object" || !line(s.venue, 60) || !STAGES.includes(s.stage)) return { error: `bad submission: venue 1-60 one line, stage ${STAGES.join("|")}` };
      if (s.deadline !== undefined && s.deadline !== null && !isDay(s.deadline)) return { error: "deadline must be YYYY-MM-DD" };
      if (s.at !== undefined && (typeof s.at !== "string" || Number.isNaN(Date.parse(s.at)))) return { error: "at must be an ISO time" };
      newSubs.push({ venue: s.venue, stage: s.stage, ...(s.deadline ? { deadline: s.deadline } : {}), at: new Date(s.at ?? now).toISOString() });
    }
  }
  const metas = new Map(store.researchMeta().map((m) => [m.path, m]));
  if (mergeInto !== undefined && mergeInto !== null) {
    if (!okKey(mergeInto) || mergeInto === key) return { error: "mergeInto must be another key" };
    if (metas.get(mergeInto)?.mergedInto) return { error: "mergeInto is itself merged" };
    if ([...metas.values()].some((m) => m.mergedInto === key)) return { error: "key has folders merged into it" };
    const was = metas.get(key)?.mergedInto;
    if (was && was !== mergeInto) return { error: "key is already merged into another project; unmerge first" };
  }
  const old = metas.get(key);
  store.putResearchMeta({
    path: key, kind: kind ?? old?.kind ?? null, name: name === undefined ? old?.name ?? null : name,
    subs: newSubs ?? old?.subs ?? [], url: url === undefined ? old?.url ?? null : url,
    mergedInto: mergeInto === undefined ? old?.mergedInto ?? null : mergeInto,
  });
  return { ok: true };
}
