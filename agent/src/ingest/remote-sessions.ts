// ssh 서버(config sessionHosts)의 Claude Code·Codex 작업 기록을 이 맥에 받아 두고, 이 맥 기록과 같은 길
// (ingestSessions·지식그래프 scanSessions)로 읽는다. ~/.cy-agent/remote-sessions/<서버>/ 아래에 서버 홈과 같은 상대 경로로 둔다.
//   기록은 뒤에 덧붙기만 하는 JSONL 이라 받아 둔 크기 뒤부터(tail -c) 늘어난 만큼만 받는다. 서버 쪽이 더 작으면 처음부터.
//   바뀐 파일은 서버당 ssh 한 번으로 묶어 받는다(파일마다 「F<TAB>경로<TAB>시작<TAB>바이트 수」 줄 + 그만큼의 본문).
//   서버에서 최근 SINCE_DAYS 일 안에 바뀐 파일만 받고, 그 목록에서 빠진 파일은 받아 둔 쪽에서도 지운다.
// 서버 → 맥 포트는 열지 않는다(jobs.ts 와 같은 ssh BatchMode). 서버가 준 파일 이름은 믿지 않는 입력:
// 정해진 두 폴더 아래, 셸에 안전한 글자만 받는다(그래야 원격 명령에 따옴표만 씌워 넣을 수 있다).
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME_DIR, type Config } from "../config.ts";
import { okJobHost, runSsh, sshArgs, type RunSsh } from "../jobs.ts";

export const SINCE_DAYS = 14; // ingestSessions 기본 창과 같다
export const REMOTE_ROOT = join(HOME_DIR, "remote-sessions");
const FETCH_TIMEOUT_MS = 10 * 60e3;
const BATCH = 200; // 한 ssh 에 싣는 파일 수(원격 명령줄 길이 상한 안쪽)

export const remoteSessionDirs = (host: string, root = REMOTE_ROOT) =>
  ({ claude: join(root, host, ".claude", "projects"), codex: join(root, host, ".codex", "sessions") });

// 읽을 작업 기록 폴더: 이 맥 + 받아 둔 서버마다. host 가 있으면 세션 경로에 「서버:」를 붙인다
export const sessionDirs = (cfg: Pick<Config, "claudeProjectsDir" | "codexSessionsDir" | "sessionHosts">, root = REMOTE_ROOT) => [
  { claude: cfg.claudeProjectsDir, codex: cfg.codexSessionsDir, host: undefined as string | undefined },
  ...cfg.sessionHosts.map((host) => ({ ...remoteSessionDirs(host, root), host })),
];

// 「크기 상대경로」 한 줄씩(POSIX find·wc 만). 폴더가 없으면 빈 출력
const LIST_CMD = `cd && find .claude/projects .codex/sessions -type f -name '*.jsonl' -mtime -${SINCE_DAYS} -exec wc -c {} + 2>/dev/null; true`;
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

// 서버 파일들의 from 바이트 뒤를 각자 to 에 쓴다(from 0 이면 새로, 아니면 이어서). 한 번의 ssh.
// 서버 쪽 loop: 파일이 사라졌으면 「E<TAB>경로」, 목록 뒤 줄었으면 처음부터(시작 0), 지금 크기까지만 보낸다(그 사이 늘어난 건 다음 차례)
export type FetchItem = { rel: string; from: number; to: string };
export type FetchBatch = (host: string, items: FetchItem[]) => Promise<void>;
const fetchScript = (items: FetchItem[]) =>
  `for a in ${items.map((i) => `'${i.rel}:${i.from}'`).join(" ")}; do f=\${a%:*}; k=\${a##*:}; ` +
  `s=$(wc -c < "$f" 2>/dev/null) || { printf 'E\\t%s\\n' "$f"; continue; }; [ "$k" -le "$s" ] || k=0; n=$((s-k)); ` +
  `printf 'F\\t%s\\t%s\\t%s\\n' "$f" "$k" "$n"; tail -c +$((k+1)) "$f" | head -c "$n"; done`;
export const fetchBatch: FetchBatch = async (host, items) => {
  const p = spawn("ssh", [...sshArgs(), "--", host, fetchScript(items)], { stdio: ["ignore", "pipe", "pipe"], timeout: FETCH_TIMEOUT_MS });
  let err = "";
  p.stderr.on("data", (d) => { err = (err + d).slice(-500); });
  const closed = new Promise<number | null>((ok, bad) => { p.on("error", bad); p.on("close", ok); });
  const toOf = new Map(items.map((i) => [i.rel, i.to]));
  let head: Buffer = Buffer.alloc(0), fd = -1, left = 0;
  const consume = async () => {
    try {
      for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
        let buf = chunk;
        while (buf.length) {
          if (left > 0) {
            const k = Math.min(left, buf.length);
            writeSync(fd, buf, 0, k);
            left -= k; buf = buf.subarray(k);
            if (!left) { closeSync(fd); fd = -1; }
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
          const to = toOf.get(rel);
          if (tag !== "F" || !to) throw new Error("서버 응답 모양이 이상해요");
          left = Number(n);
          if (left) fd = openSync(to, Number(from) ? "a" : "w", 0o600);
          else if (!Number(from)) closeSync(openSync(to, "w", 0o600)); // 빈 파일도 만든다
        }
      }
    } catch (e) { p.kill(); throw e; } finally { if (fd >= 0) closeSync(fd); }
  };
  const [, code] = await Promise.all([consume(), closed]);
  if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || `ssh 가 ${code} 로 끝남`);
};

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
export async function syncRemoteSessions(host: string, deps: { run?: RunSsh; fetch?: FetchBatch; root?: string } = {}): Promise<number> {
  if (!okJobHost(host)) throw new Error(`sessionHosts 이름이 이상해요: ${host}`);
  const { run = runSsh, fetch = fetchBatch, root = REMOTE_ROOT } = deps;
  const base = join(root, host);
  const files = parseList(await run(["--", host, LIST_CMD], 30e3));
  const keep = new Set<string>();
  const todo: FetchItem[] = [];
  for (const f of files) {
    const to = join(base, f.rel);
    keep.add(to);
    const have = sizeOf(to);
    if (have === f.size) continue;
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    todo.push({ rel: f.rel, from: have < f.size ? have : 0, to });
  }
  for (let i = 0; i < todo.length; i += BATCH) await fetch(host, todo.slice(i, i + BATCH));
  for (const p of walk(base)) if (!keep.has(p)) unlinkSync(p);
  return todo.length;
}
