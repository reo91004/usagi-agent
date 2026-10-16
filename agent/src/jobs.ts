// 긴 작업(실험·학습·빌드)이 끝나면 캐릭터가 알린다. 결과 한 건은 ops/usagi-run 이 만든다.
//   이 맥: usagi-run 이 POST /jobs/done 으로 바로 보낸다
//   원격(ssh·tmux): 서버의 ~/.usagi-agent/jobs/*.json 에 남기고, 데몬이 config jobHosts 를 2분마다 ssh 로 가져와 지운다.
//   서버 → 맥으로 포트를 열지 않는다(데몬 포트를 넘기면 공용 서버의 다른 사용자도 할 일·대화에 닿는다)
import { execFile } from "node:child_process";
import { phrase } from "./phrases.ts";
import { focusDuration } from "./focus.ts";
import type { Bubble } from "./bus.ts";

export type JobDone = { name: string; seconds: number; code: number | null; host?: string };

const NAME_MAX = 120;
// 원격 파일·HTTP 본문 모두 믿지 않는 입력: 이름은 한 줄로 줄이고, 시간·종료 코드는 숫자만
export function parseJobDone(b: unknown, host?: string): JobDone | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
  const seconds = typeof o.seconds === "number" && Number.isFinite(o.seconds) && o.seconds >= 0 ? o.seconds : NaN;
  const code = o.code === null || o.code === undefined ? null : Number.isInteger(o.code) ? (o.code as number) : NaN;
  if (!name || Number.isNaN(seconds) || Number.isNaN(code)) return null;
  return { name, seconds, code, ...(host ? { host } : {}) };
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
const FILE_RE = /^[A-Za-z0-9_.-]{1,80}\.json$/;
// 파일 이름<TAB>내용(한 줄) 씩. 지우기는 따로 — 읽다가 끊기면 다음 차례에 다시 읽는다
const LIST_CMD = `cd ${REMOTE_DIR} 2>/dev/null || exit 0; for f in *.json; do [ -f "$f" ] || continue; printf '%s\\t' "$f"; tr -d '\\n' < "$f"; echo; done`;

export type RunSsh = (args: string[], timeoutMs: number) => Promise<string>;
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"];
export const runSsh: RunSsh = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile("ssh", [...SSH_OPTS, ...args], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim().split("\n").at(-1) || "ssh 실패"));
    else resolve(String(stdout));
  });
});

// 한 서버에서 끝난 작업을 가져오고, 읽은 파일만 지운다. 잘못된 파일도 지운다(계속 남아 매번 읽지 않게)
export async function pullJobs(host: string, run: RunSsh = runSsh): Promise<JobDone[]> {
  if (!okJobHost(host)) throw new Error(`jobHosts 이름이 이상해요: ${host}`);
  const out = await run(["--", host, LIST_CMD], 20e3);
  const done: JobDone[] = [];
  const seen: string[] = [];
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const file = line.slice(0, tab);
    if (!FILE_RE.test(file)) continue;
    seen.push(file);
    let raw: unknown;
    try { raw = JSON.parse(line.slice(tab + 1)); } catch { continue; }
    const j = parseJobDone(raw, host);
    if (j) done.push(j);
  }
  if (seen.length) await run(["--", host, `cd ${REMOTE_DIR} && rm -f -- ${seen.map((f) => `'${f}'`).join(" ")}`], 20e3);
  return done;
}
