// ssh 서버(config sessionHosts)의 Claude Code·Codex 작업 기록을 이 맥에 받아 두고, 이 맥 기록과 같은 길
// (ingestSessions·지식그래프 scanSessions)로 읽는다. ~/.cy-agent/remote-sessions/<서버>/ 아래에 서버 홈과 같은 상대 경로로 둔다.
//   기록은 뒤에 덧붙기만 하는 JSONL 이라 받아 둔 서버 바이트 수(사이드카 srv) 뒤부터(tail -c) 늘어난 만큼만 받는다. 서버 쪽이 더 작으면 처음부터.
//   받으면서 소비자가 읽는 것만 남겨(slim.ts) 650MB → 수십 MB 로 줄인다. 그래서 맥 파일 크기 ≠ 서버 바이트 수이고, 둘의 짝을 사이드카(.slim.json)에 둔다.
//   바뀐 파일은 서버당 ssh 한 번으로 묶어 받는다(파일마다 「F<TAB>경로<TAB>시작<TAB>바이트 수」 줄 + 그만큼의 본문).
//   서버에서 최근 SINCE_DAYS 일 안에 바뀐 파일만 받고, 그 목록에서 빠진 파일은 받아 둔 쪽에서도 지운다(목록이 통째로 비면 지우지 않는다).
// 서버 → 맥 포트는 열지 않는다(jobs.ts 와 같은 ssh BatchMode). 서버가 준 파일 이름은 믿지 않는 입력:
// 정해진 두 폴더 아래, 셸에 안전한 글자만 받는다(그래야 원격 명령에 따옴표만 씌워 넣을 수 있다).
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME_DIR, type Config } from "../config.ts";
import { okJobDir, okJobHost, runSsh, sshArgs, type RunSsh } from "../jobs.ts";
import { SLIM_V, makeReceiver } from "./slim.ts";

export const SINCE_DAYS = 14; // ingestSessions 기본 창과 같다
export const REMOTE_ROOT = join(HOME_DIR, "remote-sessions");
const FETCH_TIMEOUT_MS = 10 * 60e3;
const JUDGED = ".judged.json"; // 서버 폴더 안, 받지 않기로 한 파일 → 그때 크기
const SIDECAR = ".slim.json"; // 서버 폴더 안, { v: SLIM_V, files: { 상대경로: { srv: 받아 처리한 서버 바이트 수, loc: 맥 파일 크기 } } }
const BATCH = 200; // 한 ssh 에 싣는 파일 수(원격 명령줄 길이 상한 안쪽)

export const remoteSessionDirs = (host: string, root = REMOTE_ROOT) =>
  ({ claude: join(root, host, ".claude", "projects"), codex: join(root, host, ".codex", "sessions") });

// 읽을 작업 기록 폴더: 이 맥 + 받아 둔 서버마다. host 가 있으면 세션 경로에 「서버:」를 붙인다
export const sessionDirs = (cfg: Pick<Config, "claudeProjectsDir" | "codexSessionsDir" | "sessionHosts">, root = REMOTE_ROOT) => [
  { claude: cfg.claudeProjectsDir, codex: cfg.codexSessionsDir, host: undefined as string | undefined },
  ...cfg.sessionHosts.map((host) => ({ ...remoteSessionDirs(host, root), host })),
];

// 목록: 「크기 상대경로」 한 줄씩(POSIX find·wc 만, 폴더가 없으면 빈 출력). 파일 안은 열지 않는다.
// 거르기(checkCmd)는 맥에 아직 없고 거른 기록(JUDGED)에도 없는 새 파일만 서버에서 검사한다.
// 프로그램이 돌린 세션(codex exec·Codex 하위 에이전트·claude -p)은 받지 않는다: 수집(sessions.ts)이 사람 대화로 세지 않아 받아도 버려진다.
//   그 표시는 앞쪽(Codex 첫 줄 session_meta, Claude 는 줄마다 entrypoint)에 있어 앞 64KB 만 본다.
// mine(공용 계정의 내 폴더, jobs.ts sharedMineDir): 기록 안에 cwd 가 내 폴더나 그 아래인 파일만 — 남의 세션은 이 맥으로 받지 않는다.
//   cwd 는 앞쪽에 없을 수 있어(긴 제목 줄, 홈에서 시작해 옮겨 간 세션) 파일 전체를 보되 grep -q 는 첫 일치에서 멈춘다. mine 은 okJobDir 를 지난 글자뿐이라 따옴표로 넣는다
const AUTO = `-e '"originator":"codex_exec"' -e '"source":"exec"' -e '"source":{"subagent"' -e '"entrypoint":"sdk-cli"'`;
export const listCmd = () => `cd && find .claude/projects .codex/sessions -type f -name '*.jsonl' -mtime -${SINCE_DAYS} -exec wc -c {} + 2>/dev/null; true`;
// rels 중 받을 것(사람 세션, mine 이면 내 폴더 것)의 경로만 한 줄씩
export const checkCmd = (rels: string[], mine?: string) => {
  const own = mine === undefined ? "" : `grep -qF -e "\\"cwd\\":\\"$M\\"" -e "\\"cwd\\":\\"$M/" "$f" && `;
  const m = mine === undefined ? "" : `M=${mine.startsWith("~/") ? `"$HOME"/'${mine.slice(2)}'` : `'${mine}'`}; `;
  return `cd && ${m}for f in ${rels.map((r) => `'${r}'`).join(" ")}; do ${own}! head -c 65536 "$f" | grep -qF ${AUTO} && echo "$f"; done; true`;
};
const SAFE_REL = /^\.(claude\/projects|codex\/sessions)\/[A-Za-z0-9_.\/-]+\.jsonl$/;

export type RemoteFile = { rel: string; size: number };
export function parseList(out: string): RemoteFile[] {
  const files: RemoteFile[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (m && SAFE_REL.test(m[2]) && !m[2].split("/").includes("..")) files.push({ rel: m[2], size: Number(m[1]) });
  }
  return files;
}

// 서버 파일들의 from 바이트 뒤를 받아 sink 에 넘긴다(한 번의 ssh). begin(rel, 시작) 뒤 data(rel, 조각)이 이어진다.
// 서버 쪽 loop: 파일이 사라졌으면 「E<TAB>경로」, 목록 뒤 줄었으면 처음부터(시작 0), 지금 크기까지만 보낸다(그 사이 늘어난 건 다음 차례)
export type FetchItem = { rel: string; from: number; to: string };
export type Sink = { begin(rel: string, from: number): void; data(rel: string, chunk: Buffer): void };
export type FetchBatch = (host: string, items: FetchItem[], sink: Sink) => Promise<void>;
const fetchScript = (items: FetchItem[]) =>
  `for a in ${items.map((i) => `'${i.rel}:${i.from}'`).join(" ")}; do f=\${a%:*}; k=\${a##*:}; ` +
  `s=$(wc -c < "$f" 2>/dev/null) || { printf 'E\\t%s\\n' "$f"; continue; }; [ "$k" -le "$s" ] || k=0; n=$((s-k)); ` +
  `printf 'F\\t%s\\t%s\\t%s\\n' "$f" "$k" "$n"; tail -c +$((k+1)) "$f" | head -c "$n"; done`;
export const fetchBatch: FetchBatch = async (host, items, sink) => {
  const p = spawn("ssh", [...sshArgs(), "--", host, fetchScript(items)], { stdio: ["ignore", "pipe", "pipe"], timeout: FETCH_TIMEOUT_MS });
  let err = "";
  p.stderr.on("data", (d) => { err = (err + d).slice(-500); });
  const closed = new Promise<number | null>((ok, bad) => { p.on("error", bad); p.on("close", ok); });
  const known = new Set(items.map((i) => i.rel));
  let head: Buffer = Buffer.alloc(0), left = 0, cur = "";
  const consume = async () => {
    try {
      for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
        let buf = chunk;
        while (buf.length) {
          if (left > 0) {
            const k = Math.min(left, buf.length);
            sink.data(cur, buf.subarray(0, k));
            left -= k; buf = buf.subarray(k);
            continue;
          }
          const nl = buf.indexOf(10);
          if (nl < 0) {
            head = Buffer.concat([head, buf]);
            if (head.length > 1024) throw new Error("서버 응답 모양이 이상해요");
            break;
          }
          const [tag, rel, from, n] = Buffer.concat([head, buf.subarray(0, nl)]).toString().split("\t");
          head = Buffer.alloc(0); buf = buf.subarray(nl + 1);
          if (tag === "E") continue;
          if (tag !== "F" || !known.has(rel)) throw new Error("서버 응답 모양이 이상해요");
          left = Number(n); cur = rel;
          sink.begin(rel, Number(from)); // 본문이 비어도 불러서 빈 파일을 만든다
        }
      }
    } catch (e) { p.kill(); throw e; }
  };
  const [, code] = await Promise.all([consume(), closed]);
  if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || `ssh 가 ${code} 로 끝남`);
};

type Side = { v: number; files: Record<string, { srv: number; loc: number }> };
const toolOf = (rel: string) => (rel.startsWith(".codex") ? "codex" : "claude");
// 받은 바이트를 슬림으로 바꿔 쓰는 sink. from 0 은 .tmp 에 새로 쓰고 finish 에서 이름을 바꿔(inode 가 바뀐다) 소비자가 새 파일로 읽게 한다.
// finish 는 fetch 가 도중에 끊겨도 부를 수 있다: 줄바꿈까지 처리한 만큼이 side 에 기록된다
function openSink(items: FetchItem[], side: Side) {
  const byRel = new Map(items.map((i) => [i.rel, i]));
  const open = new Map<string, { fd: number; rx: ReturnType<typeof makeReceiver>; from: number; item: FetchItem }>();
  return {
    begin(rel: string, from: number) {
      const item = byRel.get(rel)!;
      if (from && !existsSync(item.to)) throw new Error(`받는 중 맥 파일이 사라졌어요: ${rel}`);
      open.set(rel, { fd: openSync(from ? item.to : item.to + ".tmp", from ? "a" : "w", 0o600), rx: makeReceiver(toolOf(rel)), from, item });
    },
    data(rel: string, chunk: Buffer) {
      const o = open.get(rel)!;
      writeSync(o.fd, o.rx.feed(chunk));
    },
    finish() {
      try {
        for (const [rel, o] of open) {
          let loc: number;
          try { writeSync(o.fd, o.rx.end()); loc = fstatSync(o.fd).size; } finally { closeSync(o.fd); open.delete(rel); }
          if (!o.from) renameSync(o.item.to + ".tmp", o.item.to);
          side.files[rel] = { srv: o.from + o.rx.off, loc };
        }
      } finally { for (const o of open.values()) closeSync(o.fd); open.clear(); }
    },
  };
}

const sizeOf = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
function* walk(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

// 한 서버의 기록을 맞춘다. 반환: 새로 받거나 늘어난 파일 수. 연결이 끊기면 던진다(다음 차례에 이어서 받는다)
// mine: 공용 계정이면 내 폴더(listCmd)
export async function syncRemoteSessions(host: string, deps: { run?: RunSsh; fetch?: FetchBatch; root?: string; mine?: string } = {}): Promise<number> {
  if (!okJobHost(host)) throw new Error(`sessionHosts 이름이 이상해요: ${host}`);
  const { run = runSsh, fetch = fetchBatch, root = REMOTE_ROOT, mine } = deps;
  if (mine !== undefined && !okJobDir(mine)) throw new Error(`jobDirs 경로가 이상해요: ${mine}`);
  const base = join(root, host);
  const all = parseList(await run(["--", host, listCmd()], 30e3));
  // 판정: 맥에 이미 있으면 받기로 한 파일, JUDGED 에 있으면 거른 파일(그때 크기의 2배 넘게 자라면 다시 본다 — 공용 계정에서 홈에서 시작해 내 폴더로 옮겨 오는 세션)
  const judgedPath = join(base, JUDGED);
  // 없거나 깨졌거나 공용 계정 내 폴더(mine)가 바뀌었으면 처음부터 다시 판정한다
  let judged: Record<string, number> = {};
  try {
    const j = JSON.parse(readFileSync(judgedPath, "utf8"));
    if (j?.mine === (mine ?? null) && j.files && typeof j.files === "object") judged = j.files;
  } catch { /* 없거나 깨짐 */ }
  const fresh = all.filter((f) => !existsSync(join(base, f.rel)) && !(f.rel in judged && f.size <= 2 * judged[f.rel]));
  const wanted = new Set<string>();
  for (let i = 0; i < fresh.length; i += BATCH) {
    const out = await run(["--", host, checkCmd(fresh.slice(i, i + BATCH).map((f) => f.rel), mine)], 60e3);
    for (const l of out.split("\n")) if (SAFE_REL.test(l)) wanted.add(l);
  }
  const nextJudged: Record<string, number> = {};
  for (const f of all) if (!wanted.has(f.rel) && f.rel in judged) nextJudged[f.rel] = judged[f.rel];
  for (const f of fresh) if (!wanted.has(f.rel)) nextJudged[f.rel] = f.size;
  if (fresh.length || Object.keys(judged).length !== Object.keys(nextJudged).length || !existsSync(judgedPath)) {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    writeFileSync(judgedPath, JSON.stringify({ mine: mine ?? null, files: nextJudged }));
  }
  const files = all.filter((f) => !(f.rel in nextJudged));
  // 사이드카가 없거나 깨졌거나 SLIM_V 가 다르면 entry 가 없는 셈 쳐 서버에서 0부터 다시 받는다.
  // 맥에 있는 파일이 원본인지 슬림인지는 사이드카로만 알 수 있어, 슬림 이전 미러도 그 자리에서 바꾸지 않고 한 번 다시 받는다
  const sidePath = join(base, SIDECAR);
  let side: Side = { v: SLIM_V, files: {} };
  const saveSide = () => {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    writeFileSync(sidePath + ".tmp", JSON.stringify(side));
    renameSync(sidePath + ".tmp", sidePath);
  };
  try {
    const j = JSON.parse(readFileSync(sidePath, "utf8"));
    if (j?.v === SLIM_V && j.files && typeof j.files === "object") side = j;
  } catch { /* 없거나 깨짐 */ }
  const keep = new Set<string>();
  const todo: FetchItem[] = [];
  let dropped = false;
  for (const f of files) {
    const to = join(base, f.rel);
    keep.add(to);
    const e = side.files[f.rel];
    const have = sizeOf(to);
    if (e && have > e.loc) truncateSync(to, e.loc); // 덧붙인 뒤 사이드카를 쓰기 전에 멈춘 흔적
    const ok = e && have >= e.loc; // 파일이 없거나 짧으면 처음부터
    if (ok && f.size === e.srv) continue;
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    const from = ok && f.size > e.srv ? e.srv : 0; // 서버가 줄었으면 처음부터
    if (e && !from) { delete side.files[f.rel]; dropped = true; }
    todo.push({ rel: f.rel, from, to });
  }
  if (dropped) saveSide();
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const sink = openSink(batch, side);
    try { await fetch(host, batch, sink); } finally { try { sink.finish(); } finally { saveSide(); } }
  }
  // 서버 목록이 통째로 비면(find 실패·일시 오류일 수 있다) 받아 둔 것을 지우지 않고 로그만. 서버가 정말 다 지웠으면 다음 정상 목록에서 정리된다
  if (!all.length) {
    const n = [...walk(base)].length;
    if (n) console.warn(`[sessions] ${host} 목록이 비었어요 — 받아 둔 ${n}개는 그대로 둬요`);
    return todo.length;
  }
  for (const p of walk(base)) if (!keep.has(p)) unlinkSync(p);
  const stale = Object.keys(side.files).filter((rel) => !keep.has(join(base, rel)));
  if (stale.length) { for (const rel of stale) delete side.files[rel]; saveSide(); }
  return todo.length;
}
