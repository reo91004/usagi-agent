// 데스크톱 패널용 스냅샷(GET /dashboard). 지식그래프 프로젝트 + git 커밋 + 할 일·제안·브리핑·할 일의 「오늘」.
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { HOME_DIR } from "./config.ts";
import type { Config } from "./config.ts";
import { IS_WIN, isFsRoot, pathWithin, realish, samePath, winNorm } from "./plat.ts";
import type { Store, Node, ProposalStatus, Todo, TodoDoneBy } from "./store.ts";
import { gitActivity, type Commit, type RepoActivity } from "./git.ts";
import { listRules, ruleSummary } from "./todo-rules.ts";
import { DailyPlanService, type DailyPlan } from "./daily-plan.ts";
import { gitAllowed, sessionsAllowed } from "./onboarding.ts";

export type DashProject = {
  name: string; path: string; lastActive: string; sessions24h: number;
  lastTitle: string | null; lastPrompt: string | null; branch: string | null;
  commitsToday: number; recentCommits: Commit[];
  onMac?: boolean; // 접두 없는 경로가 이 Mac 에 있나(VS Code 원격 세션 기록은 서버 경로가 접두 없이 온다). 접두 경로는 생략
  hidden: boolean; // 패널에서 숨김 — 목록 끝에 모아 보여주고 집계·프롬프트에선 뺀다
};
export type Dashboard = {
  generatedAt: string;
  briefing: { at: string; bubble: string; replyMd: string } | null;
  commitsToday: number;
  projects: DashProject[];
  todos: DashTodo[];
  recentDone: (DashTodo & { doneAt: string })[]; // 최근 3일 안에 끝난 것(최신순, 최대 10) — 패널 "최근 완료"
  proposals: { id: string; title: string; repo: string; status: ProposalStatus; result?: string; base?: string }[];
  today: DailyPlan;
  todoRules: DashRule[]; // 할 일 규칙(패널 '규칙 N' 칩)
  trash: DashTrash[]; // 휴지통(최근에 버린 것 먼저, 최대 50) — 패널 '휴지통 (N)'
  trashCount: number;
};
export type DashTrash = { id: string; title: string; priority: number; source: string; trashedAt: string };
export type DashRule = { id: string; text: string; summary: string; enabled: boolean; hits: number; created: string };
export type DashTodo = {
  id: string; title: string; source: string; link?: string; priority: number; note?: string; userEdited: boolean;
  skipped?: boolean; // 안 해도 돼서 닫은 일(끝난 칸에서 「안 함」 표시)
  doneBy?: TodoDoneBy; autoReason?: string; autoEvidence?: string; // 자동 완료일 때 이유·근거 메시지 링크
  description?: string; // 있으면(브리핑이 썼거나 한 번 만들어 둔 것) — 원본은 GET /todos/:id/detail
  appliedRule?: { id: string; text: string }; // 이 할 일에 적용된 할 일 규칙
  progress?: string; progressAt?: string; // 어디까지 됐는지(할 일 진행 확인 — todo-progress.ts)
  due?: string; // 마감(ISO) — 미리알림에서 옴
  doing?: boolean; today?: string; // doing: 사용자가 누른 (진행중) 토글(▶/⏸)
};
export type DashboardDeps = {
  git?: (cfg: Config) => Promise<RepoActivity[]>;
  now?: Date;
};

const DAY = 864e5;
const within = (path: string, root: string) => (IS_WIN ? pathWithin(path, root) : path === root || path.startsWith(root + sep));

// 프로젝트라고 보기 어려운 cwd: 루트·홈, 임시 폴더, 데몬 자신, 데스크톱 앱 스크래치 공간
// Windows: tmpdir() 이 8.3 짧은 이름(C:\Users\ABCDEF~1\…)일 수 있어 긴 이름(realish)도 넣는다
const NOISE_ROOTS = IS_WIN ? [tmpdir(), realish(tmpdir()), HOME_DIR] : ["/tmp", "/private/tmp", "/private/var/folders", "/var/folders", tmpdir(), HOME_DIR];
export function isNoisePath(path: string): boolean {
  if (IS_WIN ? isFsRoot(path) || samePath(path, homedir()) : path === "/" || path === homedir()) return true;
  if (path.includes("/.e2e/repos/")) return true; // 이 저장소 e2e 테스트가 만든 임시 레포
  if (path.includes(`${sep}scratch-workspaces${sep}`) || (IS_WIN && winNorm(path).includes("/scratch-workspaces/"))) return true;
  return NOISE_ROOTS.some((r) => within(path, r));
}

export async function buildDashboard(cfg: Config, store: Store, deps: DashboardDeps = {}): Promise<Dashboard> {
  const now = deps.now ?? new Date();
  // git 커밋은 사용자가 고른 레포 폴더에서만, 작업 기록(세션)은 켰을 때만(onboarding.ts)
  const repos = gitAllowed(cfg) ? await (deps.git ?? ((c) => gitActivity(c)))(cfg).catch(() => [] as RepoActivity[]) : [];
  return {
    generatedAt: now.toISOString(),
    briefing: store.latestBriefing(),
    commitsToday: repos.reduce((n, r) => n + r.commitsToday.length, 0),
    projects: projects(store, repos, now, sessionsAllowed(cfg)),
    todos: store.openTodos().map(dashTodo),
    recentDone: store.recentlyDone(new Date(now.getTime() - 3 * DAY).toISOString(), 10)
      .map((t) => ({ ...dashTodo(t), doneAt: t.updated ?? t.created })),
    proposals: store.recentProposals(new Date(now.getTime() - 7 * DAY).toISOString())
      .map((p) => ({ id: p.id, title: p.title, repo: p.repo, status: p.status, ...(p.result ? { result: p.result } : {}), ...(p.base ? { base: p.base } : {}) })),
    today: new DailyPlanService(store, { now: () => now }).state(),
    trash: store.trashedTodos(50).map((t) => ({ id: t.id, title: t.title, priority: t.priority, source: t.source, trashedAt: t.trashedAt })),
    trashCount: store.trashCount(),
    todoRules: listRules(store).map((r) => ({ id: r.id, text: r.text, summary: ruleSummary(r), enabled: r.enabled, hits: r.hits, created: r.created })),
  };
}

function dashTodo(t: Todo): DashTodo {
  return {
    id: t.id, title: t.title, source: t.source, ...(t.link ? { link: t.link } : {}), priority: t.priority,
    ...(t.note ? { note: t.note } : {}), userEdited: !!t.userEdited?.some((f) => f !== "status"), // 상태만 바꾼 건 표시 안 함
    ...(t.doneBy ? { doneBy: t.doneBy } : {}),
    ...(t.skipped ? { skipped: true } : {}),
    ...(t.description ? { description: t.description } : {}),
    ...(t.appliedRule ? { appliedRule: t.appliedRule } : {}),
    ...(t.progress ? { progress: t.progress, ...(t.progressAt ? { progressAt: t.progressAt } : {}) } : {}),
    ...(t.doneBy === "auto" && t.autoReason ? { autoReason: t.autoReason } : {}),
    ...(t.doneBy === "auto" && t.autoEvidence?.permalink ? { autoEvidence: t.autoEvidence.permalink } : {}),
    ...(t.doing !== undefined ? { doing: t.doing } : {}),
    ...(t.due ? { due: t.due } : {}),
    ...(t.today ? { today: t.today } : {}), // 오늘 할 일로 고른 날(KST). 그날이면 '오늘 할 일' 탭에도 보인다
  };
}

const HOST_PATH = /^([^\s:/\\]{2,}):(\/.*)$/; // 「서버:/경로」 (한 글자 접두 C:\ 는 드라이브)
const splitHost = (path: string) => { const m = HOST_PATH.exec(path); return m ? { host: m[1], dir: m[2] } : { host: "", dir: path }; };

// 숨은 폴더(.plans · .claude/worktrees · .x …)가 처음 나오는 곳에서 자른다 → 그 위 폴더. 원격은 「host:」 접두가 그대로 붙는다
const cutHidden = (path: string) => path.replace(/[\\/]\.[^\\/]+(?:[\\/].*)?$/, "") || path;

// 이 Mac 폴더가 든 가장 가까운 git 레포 루트(홈 아래까지, 최대 12단계). 없으면 그대로.
// 프로세스 동안 기억한다 — 패널이 새로고침할 때마다 existsSync 를 되풀이하지 않게(레포를 새로 만들어도 다음 실행 때 반영)
const gitRootMemo = new Map<string, string>();
export function gitRootOf(dir: string): string {
  const hit = gitRootMemo.get(dir);
  if (hit !== undefined) return hit;
  let found = dir;
  for (let p = dir, i = 0; i < 12; i++) {
    if (existsSync(join(p, ".git"))) { found = p; break; }
    const up = dirname(p);
    if (up === p || samePath(up, homedir())) break;
    p = up;
  }
  gitRootMemo.set(dir, found);
  return found;
}

// path 가 root 폴더 안인가 — 같은 서버끼리만. 서버의 홈·루트(/home/<user>, /root)는 바깥 폴더로 치지 않는다
function insideOf(path: string, root: string): boolean {
  const a = splitHost(path), b = splitHost(root);
  if (a.host !== b.host || path === root) return false;
  if (b.host) return !/^\/(?:home\/[^/]+|root)?\/?$/.test(b.dir) && a.dir.startsWith(b.dir + "/");
  return within(a.dir, b.dir);
}

// 세션 cwd 를 레포 단위로 묶는다: 숨은 폴더 아래는 그 위로(.plans · .claude/worktrees), 레포 하위 폴더는 레포로(레포 목록 밖이면 가장 가까운 .git 루트로),
// 같은 서버에서 다른 프로젝트 안에 든 프로젝트는 그 바깥 프로젝트로 합친다. 합친 줄은 세션·커밋을 더하고 가장 최근 세션의 제목·요청을 보인다
type Group = { repos: RepoActivity[]; sessions: Node[] };
function projects(store: Store, repos: RepoActivity[], now: Date, withSessions = true): DashProject[] {
  const since = now.getTime() - 7 * DAY;
  const byLen = [...repos].sort((a, b) => b.path.length - a.path.length);
  const groups = new Map<string, Group>();
  const group = (cwd: string) => {
    const path = cutHidden(cwd);
    const repo = byLen.find((r) => within(path, r.path));
    const { host, dir } = splitHost(path);
    const key = repo?.path ?? (host ? path : gitRootOf(dir));
    if (!groups.has(key)) groups.set(key, { repos: [], sessions: [] });
    const g = groups.get(key)!;
    if (repo && !g.repos.includes(repo)) g.repos.push(repo);
    return g;
  };
  for (const p of withSessions ? store.nodesSince("project", new Date(since).toISOString(), 200) : []) {
    const path = (p.props.path as string) ?? p.id.replace(/^project:/, "");
    if (isNoisePath(path)) continue;
    // 서버 이름을 나중에 알게 돼 경로가 바뀐 세션은 옛 프로젝트 노드에도 이어져 있다 — 세션 자신의 cwd 와 같은 쪽에만 센다
    group(path).sessions.push(...store.inbound(p.id, "in").filter((s) => Date.parse(s.updated) >= since && (typeof s.props.cwd !== "string" || s.props.cwd === path)));
  }
  for (const r of repos) {
    if (r.recentCommits.some((c) => Date.parse(c.time) >= since)) group(r.path);
  }
  // 다른 프로젝트 안에 든 줄은 가장 가까운 바깥 줄로 합친다(바깥이 또 합쳐지면 끝까지 따라간다)
  const keys = [...groups.keys()];
  const rootOf = (k: string): string => {
    const up = keys.filter((o) => insideOf(k, o)).sort((a, b) => b.length - a.length)[0];
    return up ? rootOf(up) : k;
  };
  const merged = new Map<string, Group>();
  for (const k of keys) {
    const root = rootOf(k), g = groups.get(k)!;
    const m = merged.get(root) ?? merged.set(root, { repos: [], sessions: [] }).get(root)!;
    m.repos.push(...g.repos.filter((r) => !m.repos.includes(r)));
    m.sessions.push(...g.sessions);
  }

  const out: DashProject[] = [];
  for (const [path, g] of merged) {
    const sessions = g.sessions.sort((a, b) => b.updated.localeCompare(a.updated));
    const last = sessions[0];
    const rootRepo = g.repos.find((r) => r.path === path);
    const commits = [...new Map(g.repos.flatMap((r) => r.recentCommits).map((c) => [c.sha, c])).values()]
      .sort((a, b) => b.time.localeCompare(a.time)).slice(0, 5);
    const lastActive = [last?.updated, ...g.repos.map((r) => r.recentCommits[0]?.time)].filter((x): x is string => !!x && Date.parse(x) >= since)
      .map((x) => new Date(x).toISOString()).sort().at(-1);
    if (!lastActive) continue;
    out.push({
      name: rootRepo?.name ?? path.split(sep).filter(Boolean).at(-1) ?? path,
      path,
      lastActive,
      sessions24h: sessions.filter((s) => Date.parse(s.updated) >= now.getTime() - DAY).length,
      lastTitle: last?.label ?? null,
      lastPrompt: (last?.props.lastPrompt as string) ?? null,
      branch: (last?.props.branch as string) ?? rootRepo?.branch ?? null,
      commitsToday: g.repos.reduce((n, r) => n + r.commitsToday.length, 0),
      recentCommits: commits,
      hidden: false,
      ...(HOST_PATH.test(path) ? {} : { onMac: existsSync(path) }),
    });
  }
  const hidden = store.hiddenProjects();
  for (const p of out) p.hidden = store.isHiddenPath(p.path, hidden);
  return out.sort((a, b) => Number(a.hidden) - Number(b.hidden) || b.lastActive.localeCompare(a.lastActive));
}

// 채팅 프롬프트용 한 줄 요약들
export function dashboardSummary(d: Dashboard): string {
  const lines = [`## 대시보드 요약`, `오늘 내 커밋: ${d.commitsToday}개`, `### 최근 7일 프로젝트`];
  if (!d.projects.length) lines.push("(없음)");
  const shown = d.projects.filter((p) => !p.hidden);
  if (!shown.length && d.projects.length) lines.push("(없음)");
  for (const p of shown.slice(0, 12)) {
    lines.push(`- ${p.name} (${p.path}) — 마지막 활동 ${p.lastActive}, 24h 세션 ${p.sessions24h}, 오늘 커밋 ${p.commitsToday}${p.branch ? `, ${p.branch}` : ""}`);
  }
  const live = d.proposals.filter((p) => ["pending", "held", "approved", "running"].includes(p.status));
  if (live.length) lines.push("### 진행 중인 제안", ...live.map((p) => `- [${p.status}] ${p.title} (${p.repo})`));
  if (d.today.items.length) lines.push(`### 오늘 할 일 ${d.today.date}: ${d.today.items.filter((x) => !x.done).length}/${d.today.items.length}`);
  return lines.join("\n");
}
