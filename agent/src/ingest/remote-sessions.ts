// ssh 서버(config sessionHosts)의 Claude Code·Codex 작업 기록을 이 맥에 받아 두고, 이 맥 기록과 같은 길
// (ingestSessions·지식그래프 scanSessions)로 읽는다. ~/.cy-agent/remote-sessions/<서버>/ 아래에 서버 홈과 같은 상대 경로로 둔다.
//   기록은 뒤에 덧붙기만 하는 JSONL 이라 받아 둔 크기 뒤부터(tail -c) 늘어난 만큼만 받는다. 서버 쪽이 더 작으면 처음부터.
//   서버에서 최근 SINCE_DAYS 일 안에 바뀐 파일만 받고, 그 목록에서 빠진 파일은 받아 둔 쪽에서도 지운다.
// 서버 → 맥 포트는 열지 않는다(jobs.ts 와 같은 ssh BatchMode). 서버가 준 파일 이름은 믿지 않는 입력:
// 정해진 두 폴더 아래, 셸에 안전한 글자만 받는다(그래야 원격 명령에 따옴표만 씌워 넣을 수 있다).
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { HOME_DIR, type Config } from "../config.ts";
import { okJobHost, runSsh, SSH_OPTS, type RunSsh } from "../jobs.ts";

export const SINCE_DAYS = 14; // ingestSessions 기본 창과 같다
export const REMOTE_ROOT = join(HOME_DIR, "remote-sessions");
const FETCH_TIMEOUT_MS = 10 * 60e3;

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

// 서버 파일의 from 바이트 뒤를 to 에 쓴다(from 0 이면 새로, 아니면 이어서)
export type FetchTail = (host: string, rel: string, from: number, to: string) => Promise<void>;
export const fetchTail: FetchTail = async (host, rel, from, to) => {
  const p = spawn("ssh", [...SSH_OPTS, "--", host, `tail -c +${from + 1} '${rel}'`], { stdio: ["ignore", "pipe", "pipe"], timeout: FETCH_TIMEOUT_MS });
  let err = "";
  p.stderr.on("data", (d) => { err = (err + d).slice(-500); });
  const closed = new Promise<number | null>((ok, bad) => { p.on("error", bad); p.on("close", ok); });
  const [, code] = await Promise.all([pipeline(p.stdout, createWriteStream(to, { flags: from ? "a" : "w", mode: 0o600 })), closed]);
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
export async function syncRemoteSessions(host: string, deps: { run?: RunSsh; fetch?: FetchTail; root?: string } = {}): Promise<number> {
  if (!okJobHost(host)) throw new Error(`sessionHosts 이름이 이상해요: ${host}`);
  const { run = runSsh, fetch = fetchTail, root = REMOTE_ROOT } = deps;
  const base = join(root, host);
  const files = parseList(await run(["--", host, LIST_CMD], 30e3));
  const keep = new Set<string>();
  let n = 0;
  for (const f of files) {
    const to = join(base, f.rel);
    keep.add(to);
    const have = sizeOf(to);
    if (have === f.size) continue;
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    await fetch(host, f.rel, have < f.size ? have : 0, to);
    n++;
  }
  for (const p of walk(base)) if (!keep.has(p)) unlinkSync(p);
  return n;
}
