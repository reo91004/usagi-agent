// 긴 작업(실험·학습·빌드)이 끝나면 캐릭터가 알린다. 결과 한 건은 ops/usagi-run 이 만든다.
//   이 맥: usagi-run 이 POST /jobs/done 으로 바로 보낸다
//   원격(ssh·tmux): 서버의 ~/.usagi-agent/jobs/*.json(공용 계정이면 config jobDirs 의 개인 폴더)에 남기고, 데몬이 config jobHosts·sshHosts 를 2분마다 ssh 로 가져와 지운다.
//   도는 동안은 <id>.running 표시가 있다(가져가기만 하고 지우지 않음). 표시는 있는데 usagi-run 프로세스가 없으면 끊긴 작업
//   같은 ssh 호출에 tmux 세션 목록도 실려 온다(T 줄) — 사용자가 tmux 로 직접 돌리는 실험은 usagi-run 기록이 없어서 지금 돌고 있는지만 본다
//   서버 → 맥으로 포트를 열지 않는다(데몬 포트를 넘기면 공용 서버의 다른 사용자도 할 일·대화에 닿는다)
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./config.ts";
import { phrase } from "./phrases.ts";
import { focusDuration } from "./focus.ts";
import type { Bubble } from "./bus.ts";

export type JobDone = { name: string; seconds: number; code: number | null; host?: string; id?: string; cwd?: string; cmd?: string; start?: number; files?: string[] };
export type TmuxSession = { name: string; created: number; activity: number; running: string | null; path: string };
// 서버별 마지막으로 읽은 tmux 세션(메모리만 — 작업 확인 때마다 다시 채워진다). 패널 연구 탭과 ctx 도구 jobs_recent 가 읽는다
export const tmuxSeen: Record<string, { at: string; sessions: TmuxSession[] }> = {};
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

export const REMOTE_DIR = "~/.usagi-agent/jobs";
// 서버의 결과 폴더(config jobDirs — 공용 계정이면 개인 폴더). 원격 셸에 그대로 들어가니 ~/ 나 / 로 시작하는 평범한 경로만
export const okJobDir = (d: unknown): d is string => typeof d === "string" && /^(~\/|\/)[A-Za-z0-9_.\/-]{1,200}$/.test(d) && !d.split("/").includes("..");
const FILE_RE = /^[A-Za-z0-9_.-]{1,80}\.(json|running)$/;
// 먼저 H<TAB>$HOME 과 tmux 창마다 T<TAB>세션<TAB>만든 시각<TAB>마지막 활동<TAB>창 프로그램<TAB>창 폴더(tmux 가 없거나 서버가 안 떠 있으면 없음).
// 끝난 것: D<TAB>파일<TAB>내용(한 줄). 도는 것: R<TAB>파일<TAB>살아 있나(1·0)<TAB>내용. 지우기는 따로 — 읽다가 끊기면 다음 차례에 다시 읽는다
// 살아 있나는 usagi-run 프로세스(표시 속 pid)로 본다. /proc 를 먼저 보는 건 다른 계정 프로세스면 kill -0 이 거절돼서
const listCmd = (dir: string) => `printf 'H\\t%s\\n' "$HOME"; t=$(printf '\\t'); tmux list-panes -a -F "T\${t}#{session_name}\${t}#{session_created}\${t}#{session_activity}\${t}#{pane_current_command}\${t}#{pane_current_path}" 2>/dev/null
cd ${dir} 2>/dev/null || exit 0
for f in *.json; do [ -f "$f" ] || continue; printf 'D\\t%s\\t' "$f"; tr -d '\\n' < "$f"; echo; done
for f in *.running; do [ -f "$f" ] || continue; p=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$f"); a=0; [ -n "$p" ] && { [ -d "/proc/$p" ] || kill -0 "$p" 2>/dev/null; } && a=1; printf 'R\\t%s\\t%s\\t' "$f" "$a"; tr -d '\\n' < "$f"; echo; done`;

export type RunSsh = (args: string[], timeoutMs: number) => Promise<string>;
export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"];
// 연결 재사용(ControlMaster): 2분 확인·10분 세션 수집·remote-fs 가 서버마다 한 연결을 나눠 쓴다. 유지 300초 > 2분 확인 간격.
// 유닉스 소켓 경로는 104바이트 미만이어야 한다(%C 는 40글자). 홈 폴더가 길면 재사용하지 않는다. 낡은 소켓은 ssh 가 알아서 새로 연다
export function sshArgs(): string[] {
  const dir = join(HOME_DIR, "ssh"); // HOME_DIR 는 config.ts 와 순환 import 라 호출 때 읽는다
  if (dir.length + 41 >= 100) return SSH_OPTS;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return [...SSH_OPTS, "-o", "ControlMaster=auto", "-o", `ControlPath=${join(dir, "%C")}`, "-o", "ControlPersist=300"];
}
export const runSsh: RunSsh = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile("ssh", [...sshArgs(), ...args], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim().split("\n").at(-1) || "ssh 실패"));
    else resolve(String(stdout));
  });
});

// 셸·tmux 만 떠 있는 창은 쉬는 중. 그 밖의 프로그램(python·claude·vim …)이 있으면 도는 중
const IDLE_CMD = /^-?(bash|zsh|sh|fish|dash|ksh|tcsh|csh|login|tmux)$/;
// T 줄들 → 세션별 한 건(창이 여러 개면 도는 프로그램이 있는 창 우선). 이상한 줄은 건너뜀
export function parseTmux(lines: string[][]): TmuxSession[] {
  const by = new Map<string, TmuxSession>();
  for (const [name, created, activity, cmd = "", ...path] of lines) {
    if (!name || !/^\d+$/.test(created) || !/^\d+$/.test(activity)) continue;
    const running = cmd && !IDLE_CMD.test(cmd) ? cmd : null;
    const prev = by.get(name);
    if (!prev) by.set(name, { name, created: +created, activity: +activity, running, path: path.join("\t") });
    else if (running && !prev.running) { prev.running = running; prev.path = path.join("\t"); }
  }
  return [...by.values()].sort((a, b) => b.activity - a.activity);
}

// 공용 계정(jobDirs 가 <내 폴더>/.usagi-agent/jobs 모양)이면 내 폴더(jobDirs 에 적힌 모양 그대로, 예: ~/reo). 개인 계정(기본 폴더·따로 정한 폴더)이면 undefined
export const sharedMineDir = (dir: string | undefined): string | undefined =>
  dir && dir !== REMOTE_DIR && /\/\.usagi-agent\/jobs\/?$/.test(dir) ? dir.replace(/\/\.usagi-agent\/jobs\/?$/, "") : undefined;

// 공용 계정이면 내 폴더 아래에서 연 세션만 남긴다. 개인 계정이면 거르지 않는다
export function mineOnly(sessions: TmuxSession[], dir: string, home: string): TmuxSession[] {
  const m = sharedMineDir(dir);
  if (m === undefined) return sessions;
  if (!home && m.startsWith("~/")) return []; // 공용인데 내 폴더를 못 알아냄 → 남의 세션을 보이지 않는다
  const mine = m.startsWith("~/") ? home + m.slice(1) : m;
  return sessions.filter((s) => s.path === mine || s.path.startsWith(`${mine}/`));
}

// 읽은 끝난 파일·잘못된 파일·끊긴 표시의 지우기는 다음 목록 ssh 명령 앞에 합쳐 ssh 를 한 번 아낀다(서버·폴더별, 메모리만).
// 데몬이 그 사이 꺼지면 같은 파일을 다시 읽는다(id 가 있는 기록은 같은 노드로 합쳐진다)
const pendingDrop = new Map<string, string[]>();

// 한 서버에서 끝난 작업과 도는 작업을 가져온다. 읽은 끝난 파일·잘못된 파일·끊긴 작업 표시만 다음 호출에서 지운다
export async function pullJobs(host: string, run: RunSsh = runSsh, dir = REMOTE_DIR): Promise<{ done: JobDone[]; running: RunningJob[]; tmux: TmuxSession[] }> {
  if (!okJobHost(host)) throw new Error(`jobHosts 이름이 이상해요: ${host}`);
  if (!okJobDir(dir)) throw new Error(`jobDirs 경로가 이상해요: ${dir}`);
  const key = `${host}\0${dir}`;
  const prev = pendingDrop.get(key);
  const out = await run(["--", host, (prev?.length ? `(cd ${dir} && rm -f -- ${prev.map((f) => `'${f}'`).join(" ")}); ` : "") + listCmd(dir)], 20e3);
  pendingDrop.delete(key);
  const done: JobDone[] = [], running: RunningJob[] = [];
  const drop: string[] = [];
  const panes: string[][] = [];
  let home = "";
  for (const line of out.split("\n")) {
    const [tag, file, ...rest] = line.split("\t");
    if (tag === "H") home = file ?? "";
    if (tag === "T") panes.push([file, ...rest]);
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
  if (drop.length) pendingDrop.set(key, drop);
  return { done, running, tmux: mineOnly(parseTmux(panes), dir, home) };
}

// 서버별 연속 실패 백오프: 실패할 때마다 다음 시도까지 간격이 두 배(baseMs·2^실패 횟수, 상한 maxMs), 성공하면 처음으로.
// 호출 주기(baseMs)로 도는 타이머가 due() 로 건너뛸지 정한다(주기 어긋남을 baseMs/2 만큼 봐준다)
export function hostBackoff(baseMs: number, maxMs = 30 * 60e3, now = Date.now) {
  const st = new Map<string, { fails: number; next: number }>();
  return {
    due: (host: string) => now() >= (st.get(host)?.next ?? 0),
    ok: (host: string) => { st.delete(host); },
    fail: (host: string) => {
      const fails = (st.get(host)?.fails ?? 0) + 1;
      st.set(host, { fails, next: now() + Math.min(baseMs * 2 ** fails, maxMs) - baseMs / 2 });
    },
  };
}
