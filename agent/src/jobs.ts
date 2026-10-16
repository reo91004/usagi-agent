// 긴 작업(실험·학습·빌드)이 끝나면 캐릭터가 알린다. 결과 한 건은 ops/usagi-run 이 만든다.
//   이 맥: usagi-run 이 POST /jobs/done 으로 바로 보낸다
//   원격(ssh·tmux): 서버의 ~/.usagi-agent/jobs/*.json 에 남기고, 데몬이 config jobHosts·sshHosts 를 2분마다 ssh 로 가져와 지운다.
//   도는 동안은 <id>.running 표시가 있다(가져가기만 하고 지우지 않음). 표시는 있는데 usagi-run 프로세스가 없으면 끊긴 작업
//   서버 → 맥으로 포트를 열지 않는다(데몬 포트를 넘기면 공용 서버의 다른 사용자도 할 일·대화에 닿는다)
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { phrase } from "./phrases.ts";
import { focusDuration } from "./focus.ts";
import type { Bubble } from "./bus.ts";

export type JobDone = { name: string; seconds: number; code: number | null; host?: string; id?: string; cwd?: string; cmd?: string; start?: number; files?: string[] };
export type RunningJob = { id: string; name: string; host: string; start: number; alive: boolean; cwd?: string; cmd?: string };

const NAME_MAX = 120;
const one = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const okId = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,80}$/.test(v);
const okStart = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
// usagi-run 이 더 남기는 것(작업 폴더·명령·시작 시각·바뀐 파일). 없거나 이상하면 그 칸만 뺀다
function extras(o: Record<string, unknown>) {
  const cwd = one(o.cwd, 500), cmd = one(o.cmd, 300);
  const files = Array.isArray(o.files) ? o.files.map((f) => one(f, 300)).filter(Boolean).slice(0, 8) : [];
  return { ...(okId(o.id) ? { id: o.id } : {}), ...(cwd ? { cwd } : {}), ...(cmd ? { cmd } : {}), ...(okStart(o.start) ? { start: o.start } : {}), ...(files.length ? { files } : {}) };
}

// 원격 파일·HTTP 본문 모두 믿지 않는 입력: 이름은 한 줄로 줄이고, 시간·종료 코드는 숫자만
export function parseJobDone(b: unknown, host?: string): JobDone | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  const name = one(o.name, NAME_MAX);
  const seconds = typeof o.seconds === "number" && Number.isFinite(o.seconds) && o.seconds >= 0 ? o.seconds : NaN;
  const code = o.code === null || o.code === undefined ? null : Number.isInteger(o.code) ? (o.code as number) : NaN;
  if (!name || Number.isNaN(seconds) || Number.isNaN(code)) return null;
  return { name, seconds, code, ...(host ? { host } : {}), ...extras(o) };
}

export function parseRunning(b: unknown, host: string, alive: boolean): RunningJob | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  const name = one(o.name, NAME_MAX);
  if (!name || !okId(o.id) || !okStart(o.start)) return null;
  const { cwd, cmd } = extras(o);
  return { id: o.id, name, host, start: o.start, alive, ...(cwd ? { cwd } : {}), ...(cmd ? { cmd } : {}) };
}

// 노드 id: usagi-run 이 준 id 가 있으면 서버 이름과 묶어 하나로(도는 중 → 끝이 같은 노드). 예전 기록은 새 id
export const jobNodeId = (j: { id?: string; host?: string }) => `job:${j.id ? `${j.host ? `${j.host}:` : ""}${j.id}` : `job-${randomUUID()}`}`;
export function jobProps(j: JobDone | RunningJob, state?: "running" | "lost"): Record<string, unknown> {
  const base = { ...(j.host ? { host: j.host } : {}), ...(j.cwd ? { cwd: j.cwd } : {}), ...(j.cmd ? { cmd: j.cmd } : {}), ...(j.start ? { start: j.start } : {}) };
  if (state) return { ...base, [state]: true };
  const d = j as JobDone;
  return { ...base, seconds: d.seconds, code: d.code, ...(d.files?.length ? { files: d.files } : {}) };
}

// 종료 코드 0 이거나 모름(--pid 로 지켜봄) → 끝, 그 밖 → 실패. 자리를 비웠다 와도 보이게 30분
export function jobBubble(j: JobDone, id: string): Bubble {
  const name = j.host ? `${j.name} @${j.host}` : j.name;
  const duration = focusDuration(j.seconds);
  const failed = j.code !== null && j.code !== 0;
  return {
    id,
    kind: failed ? "error" : "done",
    ttlMs: 30 * 60e3,
    text: failed ? phrase("job_failed", { name, duration, code: j.code as number }) : phrase("job_done", { name, duration }),
  };
}

// ssh 별칭·user@host 만. 「-」로 시작(옵션으로 읽힘)·공백·셸 문자는 거절
export const okJobHost = (h: unknown): h is string => typeof h === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$/.test(h);

const REMOTE_DIR = "~/.usagi-agent/jobs";
const FILE_RE = /^[A-Za-z0-9_.-]{1,80}\.(json|running)$/;
// 끝난 것: D<TAB>파일<TAB>내용(한 줄). 도는 것: R<TAB>파일<TAB>살아 있나(1·0)<TAB>내용. 지우기는 따로 — 읽다가 끊기면 다음 차례에 다시 읽는다
// 살아 있나는 usagi-run 프로세스(표시 속 pid)로 본다. /proc 를 먼저 보는 건 다른 계정 프로세스면 kill -0 이 거절돼서
const LIST_CMD = `cd ${REMOTE_DIR} 2>/dev/null || exit 0
for f in *.json; do [ -f "$f" ] || continue; printf 'D\\t%s\\t' "$f"; tr -d '\\n' < "$f"; echo; done
for f in *.running; do [ -f "$f" ] || continue; p=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$f"); a=0; [ -n "$p" ] && { [ -d "/proc/$p" ] || kill -0 "$p" 2>/dev/null; } && a=1; printf 'R\\t%s\\t%s\\t' "$f" "$a"; tr -d '\\n' < "$f"; echo; done`;

export type RunSsh = (args: string[], timeoutMs: number) => Promise<string>;
export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"];
export const runSsh: RunSsh = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile("ssh", [...SSH_OPTS, ...args], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim().split("\n").at(-1) || "ssh 실패"));
    else resolve(String(stdout));
  });
});

// 한 서버에서 끝난 작업과 도는 작업을 가져온다. 읽은 끝난 파일·잘못된 파일·끊긴 작업 표시만 지운다
export async function pullJobs(host: string, run: RunSsh = runSsh): Promise<{ done: JobDone[]; running: RunningJob[] }> {
  if (!okJobHost(host)) throw new Error(`jobHosts 이름이 이상해요: ${host}`);
  const out = await run(["--", host, LIST_CMD], 20e3);
  const done: JobDone[] = [], running: RunningJob[] = [];
  const drop: string[] = [];
  for (const line of out.split("\n")) {
    const [tag, file, ...rest] = line.split("\t");
    if ((tag !== "D" && tag !== "R") || !file || !FILE_RE.test(file)) continue;
    const alive = tag === "R" && rest[0] === "1";
    let raw: unknown;
    try { raw = JSON.parse((tag === "R" ? rest.slice(1) : rest).join("\t")); } catch { raw = undefined; }
    if (tag === "D") {
      drop.push(file);
      const j = parseJobDone(raw, host);
      if (j) done.push(j);
    } else {
      const r = parseRunning(raw, host, alive);
      if (r) running.push(r);
      if (!r || !alive) drop.push(file);
    }
  }
  if (drop.length) await run(["--", host, `cd ${REMOTE_DIR} && rm -f -- ${drop.map((f) => `'${f}'`).join(" ")}`], 20e3);
  return { done, running };
}
