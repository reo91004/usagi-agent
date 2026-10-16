// 연구 노트: 그날 한 일(작업 세션·끝난 긴 작업·집중 시간·끝낸 할 일·내 커밋)을 Tine(Logseq 형식) 그래프에 날마다 한 페이지로 남긴다.
//   config tineGraph = 그래프 폴더(logseq/config.edn 이 있어야). 페이지 「우사기 연구 노트/2026-10-17」 →
//   pages/우사기 연구 노트___2026-10-17.md(:file/name-format :triple-lowbar). AI 없이 목록만.
// 사용자 저널은 건드리지 않는다. 대신 페이지에 그날 저널 링크를 달아 저널의 「연결된 참조」에 뜨게 한다.
// 페이지는 우사기 것이라 다시 쓴다. 단 마지막으로 쓴 뒤 누가 고쳤으면(내용 해시가 다르면) 덮지 않는다.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { dayStart, focusDuration, localDay, nextDayStart, type Focus } from "./focus.ts";
import { isNoisePath } from "./dashboard.ts";
import { gitActivity, type RepoActivity } from "./git.ts";
import { modelWorkAllowed, sessionsAllowed } from "./onboarding.ts";
import type { Node, Store } from "./store.ts";

export const NOTE_NS = "우사기 연구 노트";

// 그래프의 저널 제목 형식(config.edn :journal/page-title-format, date-fns 꼴). 없으면 Logseq 기본
export function journalFormat(graph: string): string {
  try { return /:journal\/page-title-format\s+"([^"]+)"/.exec(readFileSync(join(graph, "logseq", "config.edn"), "utf8"))?.[1] ?? "MMM do, yyyy"; }
  catch { return "MMM do, yyyy"; }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const pad = (n: number) => String(n).padStart(2, "0");
// date-fns 토큰 중 Logseq 저널 형식에 쓰이는 것만. 모르는 글자는 그대로 둔다
export function formatDay(day: string, fmt: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  const tok: Record<string, string> = {
    yyyy: String(y), MMMM: MONTHS[m - 1], MMM: MONTHS[m - 1].slice(0, 3), MM: pad(m), M: String(m),
    do: ordinal(d), dd: pad(d), d: String(d), EEEE: WEEKDAYS[wd], EEE: WEEKDAYS[wd].slice(0, 3),
  };
  return fmt.replace(/yyyy|MMMM|MMM|MM|M|do|dd|d|EEEE|EEE/g, (t) => tok[t]);
}

// 기록에서 온 글은 데이터: 한 줄로, 링크·임베드·매크로·태그 문법이 살아나지 않게
export function plain(s: unknown, max = 120): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
    .replace(/\[\[|\]\]|\(\(|\)\)|\{\{|\}\}/g, (p) => `${p[0]} ${p[1]}`)
    .replace(/#(?=\S)/g, "＃");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export type NoteJob = { name: string; seconds: number; code: number | null; host?: string };
export type DayNote = {
  day: string;
  focus: { seconds: number; longest: number };
  sessions: { project: string; items: { title: string; tool: string; turns: number; lastPrompt?: string }[] }[];
  jobs: NoteJob[];
  done: string[];
  commits: { repo: string; sha: string; subject: string }[];
};

const inDay = (iso: string, day: string) => localDay(Date.parse(iso)) === day;

export async function collectDay(
  cfg: Pick<Config, "repoRoots" | "gitAuthor" | "onboarded" | "readSessions">, store: Store, day: string,
  deps: { focus?: Pick<Focus, "stats">; git?: (now: Date) => Promise<RepoActivity[]> } = {},
): Promise<DayNote> {
  const from = new Date(dayStart(day)).toISOString(), to = new Date(nextDayStart(dayStart(day))).toISOString();
  const nodes = (kind: string) => (store.db.prepare("SELECT * FROM nodes WHERE kind = ? AND updated >= ? AND updated < ? ORDER BY updated")
    .all(kind, from, to) as any[]).map((r): Node => ({ ...r, props: JSON.parse(r.props) }));

  const hidden = store.hiddenProjects();
  const byProject = new Map<string, DayNote["sessions"][number]["items"]>();
  for (const s of sessionsAllowed(cfg) ? nodes("session") : []) {
    const cwd = String(s.props.cwd ?? "");
    if (cwd && (store.isHiddenPath(cwd, hidden) || isNoisePath(cwd))) continue; // 임시·스크래치 폴더·홈 자체는 대시보드처럼 뺀다
    const items = byProject.get(cwd || "(폴더 모름)") ?? [];
    items.push({ title: s.label, tool: s.props.tool === "codex" ? "Codex" : "Claude Code", turns: Number(s.props.turns) || 0, ...(s.props.lastPrompt ? { lastPrompt: String(s.props.lastPrompt) } : {}) });
    byProject.set(cwd || "(폴더 모름)", items);
  }

  const done = new Map<string, string>();
  for (const e of store.ledger({ day, limit: 500 }).reverse()) { // 일지는 최신 먼저 — 오래된 것부터 따라가 그날 마지막 상태로
    if (e.action === "done") done.set(e.todoId, e.title);
    else if (e.action === "reopened") done.delete(e.todoId);
  }

  const f = deps.focus?.stats(day, day)?.days[0];
  // 커밋은 사용자가 고른 레포 폴더에서만(대시보드와 같다). 그날 낮을 기준 시각으로 주고 그날 것만 남긴다
  const repos = modelWorkAllowed(cfg) ? await (deps.git ?? ((now) => gitActivity(cfg, { now })))(new Date(dayStart(day) + 12 * 3600e3)) : [];
  return {
    day,
    focus: { seconds: f?.seconds ?? 0, longest: f?.longest ?? 0 },
    sessions: [...byProject].map(([project, items]) => ({ project, items })),
    jobs: nodes("job").map((j) => ({ name: j.label, seconds: Number(j.props.seconds) || 0, code: Number.isInteger(j.props.code) ? Number(j.props.code) : null, ...(j.props.host ? { host: String(j.props.host) } : {}) })),
    done: [...done.values()],
    commits: repos.flatMap((r) => r.commitsToday.filter((c) => inDay(c.time, day)).map((c) => ({ repo: r.name, sha: c.sha, subject: c.subject }))),
  };
}

export const isEmpty = (n: DayNote) => !n.focus.seconds && !n.sessions.length && !n.jobs.length && !n.done.length && !n.commits.length;

// Logseq 마크다운(탭 들여쓰기 블록). 첫 줄들은 페이지 속성
export function noteMarkdown(n: DayNote, journalTitle: string): string {
  const out = [`tags:: ${NOTE_NS}`, `date:: [[${journalTitle}]]`, ""];
  if (n.focus.seconds) out.push(`- 집중 ${focusDuration(n.focus.seconds)}${n.focus.longest ? ` (가장 길게 이어서 ${focusDuration(n.focus.longest)})` : ""}`);
  if (n.sessions.length) {
    out.push("- ## 작업 세션");
    for (const p of n.sessions) {
      out.push(`\t- \`${p.project.replace(/`/g, "'")}\``);
      for (const s of p.items) out.push(`\t\t- ${plain(s.title, 80)} (${s.tool}, ${s.turns}턴)${s.lastPrompt ? ` · 마지막 요청: ${plain(s.lastPrompt, 140)}` : ""}`);
    }
  }
  if (n.jobs.length) {
    out.push("- ## 끝난 긴 작업");
    for (const j of n.jobs) out.push(`\t- ${plain(j.name, 80)}${j.host ? ` @${plain(j.host, 40)}` : ""} · ${focusDuration(j.seconds)} · ${j.code === null || j.code === 0 ? "끝" : `실패(종료 코드 ${j.code})`}`);
  }
  if (n.done.length) {
    out.push("- ## 끝낸 할 일");
    for (const t of n.done) out.push(`\t- ${plain(t, 100)}`);
  }
  if (n.commits.length) {
    out.push("- ## 커밋");
    for (const c of n.commits) out.push(`\t- ${plain(c.repo, 40)} \`${c.sha}\` ${plain(c.subject, 100)}`);
  }
  return out.join("\n") + "\n";
}

export const notePath = (graph: string, day: string) => join(graph, "pages", `${NOTE_NS}___${day}.md`);
const hashMark = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 13), 16); // 52비트: ingest_marks(REAL)에 정확히 들어간다
const markKey = (path: string) => `tine-note:${path}`;

export type WriteResult = "written" | "same" | "empty" | "edited";
// 쓰기: 같으면 그대로, 마지막으로 쓴 뒤 누가 고쳤으면 덮지 않는다. 임시 파일 → rename 으로 Tine 이 반쯤 쓴 파일을 읽지 않게
export function writeNote(store: Store, graph: string, n: DayNote): WriteResult {
  const path = notePath(graph, n.day);
  const exists = existsSync(path);
  if (isEmpty(n) && !exists) return "empty";
  const md = noteMarkdown(n, formatDay(n.day, journalFormat(graph)));
  if (exists) {
    const cur = readFileSync(path, "utf8");
    if (cur === md) return "same";
    if (hashMark(cur) !== store.markOf(markKey(path))) return "edited";
  }
  const tmp = `${path}.usagi-tmp`;
  writeFileSync(tmp, md);
  renameSync(tmp, path);
  store.setMark(markKey(path), hashMark(md));
  return "written";
}

export async function writeDay(cfg: Config, store: Store, day: string, deps: Parameters<typeof collectDay>[3] = {}): Promise<{ path: string; result: WriteResult }> {
  if (!cfg.tineGraph) throw new Error("tineGraph 가 없어요");
  return { path: notePath(cfg.tineGraph, day), result: writeNote(store, cfg.tineGraph, await collectDay(cfg, store, day, deps)) };
}
