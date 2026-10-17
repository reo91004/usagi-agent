// ssh 실험 서버 둘러보기(config sshHosts): 물어볼 때만 접속해 폴더 목록·파일 일부·GPU 를 읽는다. 읽기 전용이고 로컬에 쌓지 않는다.
//   서버에 보내는 명령은 여기서 정해진 모양으로만 만든다(모델은 서버·경로·숫자·이름 조각만 고른다). 경로는 작은따옴표로 감싼다.
//   비밀 파일(키·토큰·.env 등)은 서버에서 readlink -f 로 실제 경로를 본 뒤 거절한다(심볼릭 링크로 돌아가지 못하게).
//   연결은 ControlMaster 로 2분 동안 다시 쓴다: 첫 호출만 ~1초, 이어지는 호출은 0.1초 안팎. 주기적으로는 접속하지 않는다.
//   서버는 리눅스라고 본다(GNU find -printf · stat -c · timeout).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, type Config } from "./config.ts";
import { SSH_OPTS, okJobHost } from "./jobs.ts";

export type RemoteRun = (host: string, script: string, timeoutMs: number) => Promise<string>;
export type RemoteResult = { ok: boolean; title: string; body: string };

const MAX_BYTES = 256 * 1024; // 서버가 너무 많이 보내면 끊는다(결과는 어차피 맥락 도구 상한으로 줄인다)
const CONTROL_DIR = join(HOME_DIR, "ssh");
// 유닉스 소켓 경로는 104바이트 미만이어야 한다(%C 는 40글자). 홈 폴더가 길면 연결을 다시 쓰지 않는다
const CONTROL = CONTROL_DIR.length + 41 < 100 ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${join(CONTROL_DIR, "%C")}`, "-o", "ControlPersist=120"] : [];

export const remoteRun: RemoteRun = (host, script, timeoutMs) => new Promise((resolve, reject) => {
  if (CONTROL.length) mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
  const p = spawn("ssh", [...SSH_OPTS, ...CONTROL, "--", host, script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", settled = false;
  const finish = (e?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (e) reject(e); else resolve(out);
  };
  const timer = setTimeout(() => { p.kill(); finish(new Error(`${Math.round(timeoutMs / 1000)}초 안에 답이 없어요`)); }, timeoutMs);
  p.stdout.on("data", (d) => { out += d; if (out.length > MAX_BYTES) { p.kill(); finish(); } });
  p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
  p.on("error", (e) => finish(e));
  p.on("close", (code) => (code === 0 ? finish() : finish(new Error(err.trim().split("\n").at(-1) || `ssh 가 ${code} 로 끝남`))));
});

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
// 경로 → 셸 낱말. ~ 와 ~/… 는 그 계정 홈, 상대 경로도 홈 기준. 다른 사람 홈(~user)·줄바꿈은 받지 않는다
export function remotePath(p: unknown): string | null {
  const s = typeof p === "string" ? p.trim() : "";
  if (!s || s.length > 1000 || /[\0\n\r]/.test(s)) return null;
  if (s === "~") return `"$HOME"`;
  if (s.startsWith("~/")) return `"$HOME"/${q(s.slice(2))}`;
  if (s.startsWith("~")) return null;
  return s.startsWith("/") ? q(s) : `"$HOME"/${q(s)}`;
}

// 열지 않는 것: 키·토큰·자격 증명·.env·셸 기록. 실제 경로(readlink -f)로 따진다
const DENY = [
  "*/.ssh", "*/.ssh/*", "*/.gnupg", "*/.gnupg/*", "*/.aws/*", "*/.azure/*", "*/.kube/*", "*/.docker/config.json",
  "*/.netrc", "*/.pgpass", "*/.git-credentials", "*/.npmrc", "*/.pypirc", "*/.env", "*/.env.*", "*/.envrc",
  "*.pem", "*.key", "*.p12", "*.pfx", "*/id_rsa*", "*/id_dsa*", "*/id_ecdsa*", "*/id_ed25519*",
  "*/.config/gh/*", "*/huggingface/token", "*/.huggingface/token", "*/.codex/auth.json", "*/.claude/.credentials.json",
  "*/.claude.json", "*/.cy-agent/*", "*/.gemini/*", "/etc/shadow*",
  "*/.*_history", "/proc/*", // 셸 기록·프로세스 환경 변수(/proc/<pid>/environ)에 토큰이 남는다
].join("|");
// 훑을 때 들어가지 않는 폴더: 기록·캐시·패키지(크고 실험 결과가 아님)와 비밀 폴더
const PRUNE = [".git", "__pycache__", "node_modules", ".ipynb_checkpoints", ".cache", ".ssh", ".gnupg", "anaconda3", "miniconda3", "miniforge3", ".conda", "site-packages", ".vscode-server", ".npm", ".cargo", ".rustup", "snap"];
const pruneExpr = `\\( ${PRUNE.map((n) => `-name ${q(n)}`).join(" -o ")} \\)`;

// 경로를 실제 경로로 풀고(없으면·비밀이면 멈춤) $r 에 둔다
const resolve = (path: string) => `export LC_ALL=C
deny() { case "$1" in ${DENY}) return 0;; esac; return 1; }
r=$(readlink -f -- ${path} 2>/dev/null)
[ -n "$r" ] && [ -e "$r" ] || { echo "ERR 없는 경로예요"; exit 0; }
deny "$r" && { echo "ERR 비밀 파일·폴더라 열지 않아요"; exit 0; }`;

// 최근 바뀐 순으로 줄 세우고 limit 개만, 끝에 TOTAL<TAB>전체 수<TAB>find 종료 코드(124 = 시간 초과)
const topN = (find: string, limit: number) =>
  `{ ${find} 2>/dev/null; printf 'RC\\t%s\\n' "$?"; } | sort -rn | awk -F'\\t' -v L=${limit} '$1=="RC"{rc=$2;next} {n++} n<=L{print} END{printf "TOTAL\\t%d\\t%s\\n", n, rc}'`;

export function lsScript(path: string, depth: number, limit: number): string {
  return `${resolve(path)}
[ -d "$r" ] || { echo "ERR 폴더가 아니에요(파일이면 remote_read)"; exit 0; }
echo "OK $r"
${topN(`timeout 10 find "$r" -mindepth 1 -maxdepth ${depth} ${pruneExpr} -printf '%T@\\t%y\\t%s\\t%P/\\n' -prune -o -printf '%T@\\t%y\\t%s\\t%P\\n'`, limit)}`;
}

export function findScript(path: string, opts: { name?: string; hours?: number; limit: number }): string {
  const name = opts.name ? ` -iname ${q(`*${opts.name}*`)}` : "";
  const mmin = opts.hours ? ` -mmin -${Math.round(opts.hours * 60)}` : "";
  return `${resolve(path)}
[ -d "$r" ] || { echo "ERR 폴더가 아니에요"; exit 0; }
echo "OK $r"
${topN(`timeout 15 find "$r" -maxdepth 6 ${pruneExpr} -prune -o -type f${name}${mmin} -printf '%T@\\tf\\t%s\\t%P\\n'`, opts.limit)}`;
}

export type ReadMode = { mode: "head" | "tail"; bytes: number } | { mode: "match"; text: string };
export function readScript(path: string, m: ReadMode): string {
  const body = m.mode === "match"
    ? `grep -n -i -F -e ${q(m.text)} -- "$r" | tail -n 60 | cut -c1-300`
    : `${m.mode} -c ${m.bytes} -- "$r"`;
  return `${resolve(path)}
[ -f "$r" ] || { echo "ERR 파일이 아니에요(폴더면 remote_ls)"; exit 0; }
echo "OK $(stat -c '%s %Y' -- "$r") $r"
if [ -s "$r" ] && ! head -c 4096 -- "$r" | grep -qI . ; then echo "BIN"; exit 0; fi
${body}`;
}

export const GPU_SCRIPT = `command -v nvidia-smi >/dev/null 2>&1 || { echo "ERR nvidia-smi 가 없어요"; exit 0; }
echo OK
timeout 10 nvidia-smi --query-gpu=index,pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits | sed 's/^/G\\t/'
timeout 10 nvidia-smi --query-compute-apps=gpu_bus_id,pid,used_memory --format=csv,noheader,nounits | while IFS=', ' read -r b p m; do printf 'P\\t%s\\t%s\\t%s\\t%s\\n' "$b" "$p" "$m" "$(ps -o user=,etime=,args= -p "$p" 2>/dev/null | cut -c1-160)"; done`;

// ── 결과 다듬기 ───────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");
// 서버 시각(유닉스 초) → 이 맥 시간대 「10-17 01:23」
export function when(sec: number): string {
  const d = new Date(sec * 1000);
  return Number.isFinite(d.getTime()) ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : "?";
}
export function size(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${u[i]}`;
}

// OK/ERR 머리줄과 나머지
function head(out: string): { err?: string; first: string; rest: string[] } {
  const lines = out.replace(/\n$/, "").split("\n");
  const first = lines[0] ?? "";
  if (first.startsWith("ERR ")) return { err: first.slice(4), first, rest: [] };
  if (!first.startsWith("OK")) return { err: `서버가 알 수 없는 답을 했어요: ${first.slice(0, 120)}`, first, rest: [] };
  return { first, rest: lines.slice(1) };
}

export function formatList(out: string, label: string, limit: number): RemoteResult {
  const h = head(out);
  if (h.err) return { ok: false, title: label, body: h.err };
  const root = h.first.slice(3);
  let total = 0, rc = "0";
  const rows: string[] = [];
  for (const l of h.rest) {
    const f = l.split("\t");
    if (f[0] === "TOTAL") { total = Number(f[1]) || 0; rc = f[2] ?? "0"; continue; }
    if (f.length < 4) continue;
    const [t, type, sz, rel] = [Number(f[0]), f[1], Number(f[2]), f.slice(3).join("\t")];
    rows.push(type === "d" || rel.endsWith("/") ? `- ${when(t)}  ${rel.endsWith("/") ? rel : `${rel}/`}` : `- ${when(t)}  ${rel}  (${size(sz)})`);
  }
  const more = total > rows.length ? ` · 전체 ${total}개 중 최근 ${rows.length}개` : "";
  const slow = rc === "124" ? "\n(시간 안에 다 훑지 못했어요. 폴더를 좁혀서 다시 물어보세요)" : "";
  return { ok: true, title: `${label} ${root}${more}`, body: (rows.join("\n") || "(비어 있음)") + slow };
}

export function formatRead(out: string, label: string, m: ReadMode): RemoteResult {
  const h = head(out);
  if (h.err) return { ok: false, title: label, body: h.err };
  const [, sz, mt, ...p] = h.first.split(" ");
  const meta = `${p.join(" ")} (${size(Number(sz))}, ${when(Number(mt))} 수정)`;
  if (h.rest[0] === "BIN") return { ok: true, title: `${label} ${meta}`, body: "(바이너리 파일이라 내용은 보여 주지 않아요)" };
  const what = m.mode === "match" ? `「${m.text}」 들어간 줄(끝에서 60줄까지)` : m.mode === "head" ? `앞 ${m.bytes}바이트` : `끝 ${m.bytes}바이트`;
  return { ok: true, title: `${label} ${meta} · ${what}`, body: h.rest.join("\n") || "(없음)" };
}

export type GpuProc = { gpu: string; pid: string; mem: number; who: string };
export type Gpu = { idx: string; name: string; util: number; memUsed: number; memTotal: number; temp: number };
export type GpuHost = { host: string; ok: boolean; error?: string; gpus: Gpu[]; procs: GpuProc[] };
const n0 = (s: string | undefined) => (Number.isFinite(Number(s)) ? Number(s) : 0);
// nvidia-smi 출력 → GPU·프로세스(패널 카드는 이걸 그대로 그리고, 맥락 도구는 formatGpu 글로)
export function parseGpu(out: string, host: string): GpuHost {
  const h = head(out);
  if (h.err) return { host, ok: false, error: h.err, gpus: [], procs: [] };
  const gpus: Gpu[] = [], bus = new Map<string, string>(), procs: GpuProc[] = [];
  for (const l of h.rest) {
    const f = l.split("\t");
    if (f[0] === "G") {
      const [idx, b, name, util, used, total, temp] = (f[1] ?? "").split(",").map((x) => x.trim());
      bus.set((b ?? "").toLowerCase(), idx);
      gpus.push({ idx, name, util: n0(util), memUsed: n0(used), memTotal: n0(total), temp: n0(temp) });
    } else if (f[0] === "P") {
      procs.push({ gpu: bus.get((f[1] ?? "").toLowerCase()) ?? "?", pid: f[2] ?? "", mem: n0(f[3]), who: (f[4] ?? "").replace(/\s+/g, " ").trim() });
    }
  }
  return { host, ok: true, gpus, procs };
}
export function formatGpu(out: string, host: string): RemoteResult {
  const g = parseGpu(out, host);
  if (!g.ok) return { ok: false, title: `GPU ${host}`, body: g.error ?? "" };
  const gpus = g.gpus.map((x) => `- GPU${x.idx} ${x.name}: 사용률 ${x.util}% · 메모리 ${x.memUsed}/${x.memTotal} MiB · ${x.temp}°C`);
  const procs = g.procs.map((p) => `  - GPU${p.gpu} pid ${p.pid} · ${p.mem} MiB · ${p.who}`);
  return { ok: true, title: `GPU ${host}`, body: [...gpus, ...(procs.length ? ["- 돌고 있는 프로세스:", ...procs] : ["- 돌고 있는 GPU 프로세스 없음"])].join("\n") };
}

// ── 도구 본체 ────────────────────────────────────────
const clampInt = (v: unknown, lo: number, hi: number, def: number) => (Number.isFinite(Number(v)) ? Math.min(Math.max(Math.round(Number(v)), lo), hi) : def);
export const remoteHosts = (cfg: Pick<Config, "sshHosts" | "jobHosts">) => [...new Set([...cfg.sshHosts, ...cfg.jobHosts])];

function checkHost(cfg: Pick<Config, "sshHosts" | "jobHosts">, host: unknown): string | null {
  const hosts = remoteHosts(cfg);
  if (!hosts.length) return "둘러볼 서버가 없어요. config.json 의 sshHosts 에 ~/.ssh/config 별칭을 적어 주세요";
  if (typeof host !== "string" || !okJobHost(host) || !hosts.includes(host)) return `설정한 서버(${hosts.join(", ")}) 중에서 골라 주세요`;
  return null;
}

async function call(cfg: Pick<Config, "sshHosts" | "jobHosts">, host: unknown, label: string, script: () => string | null, fmt: (out: string) => RemoteResult, run: RemoteRun, timeoutMs = 25e3): Promise<RemoteResult> {
  const bad = checkHost(cfg, host);
  if (bad) return { ok: false, title: label, body: bad };
  const s = script();
  if (!s) return { ok: false, title: label, body: "경로가 이상해요(줄바꿈 없이, ~/… 나 /… 꼴로)" };
  try { return fmt(await run(host as string, s, timeoutMs)); }
  catch (e: any) { return { ok: false, title: label, body: `${host} 에 접속하지 못했어요: ${String(e?.message ?? e).slice(0, 200)}` }; }
}

export type LsArgs = { host: string; path?: string; depth?: number; limit?: number };
export function remoteLs(cfg: Pick<Config, "sshHosts" | "jobHosts">, a: LsArgs, run: RemoteRun = remoteRun) {
  const depth = clampInt(a.depth, 1, 4, 1), limit = clampInt(a.limit, 1, 200, 60);
  const p = remotePath(a.path ?? "~");
  return call(cfg, a.host, `폴더 ${a.host}:`, () => p && lsScript(p, depth, limit), (o) => formatList(o, `폴더 ${a.host}:`, limit), run);
}

export type FindArgs = { host: string; path?: string; name?: string; hours?: number; limit?: number };
export function remoteFind(cfg: Pick<Config, "sshHosts" | "jobHosts">, a: FindArgs, run: RemoteRun = remoteRun) {
  const limit = clampInt(a.limit, 1, 100, 40);
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (name && (name.length > 100 || /[\0\n\r/]/.test(name))) return Promise.resolve({ ok: false, title: "파일 찾기", body: "이름 조각에는 / 나 줄바꿈을 넣지 마세요" });
  const hours = a.hours === undefined ? undefined : clampInt(a.hours, 1, 24 * 60, 24);
  const p = remotePath(a.path ?? "~");
  return call(cfg, a.host, `파일 찾기 ${a.host}:`, () => p && findScript(p, { ...(name ? { name } : {}), ...(hours ? { hours } : {}), limit }), (o) => formatList(o, `파일 찾기 ${a.host}:`, limit), run, 30e3);
}

export type ReadArgs = { host: string; path: string; from?: "head" | "tail"; bytes?: number; match?: string };
export function remoteRead(cfg: Pick<Config, "sshHosts" | "jobHosts">, a: ReadArgs, run: RemoteRun = remoteRun) {
  const match = typeof a.match === "string" ? a.match.trim() : "";
  if (match.length > 200 || /[\0\n\r]/.test(match)) return Promise.resolve({ ok: false, title: "파일 읽기", body: "찾을 글은 한 줄, 200자까지예요" });
  const m: ReadMode = match ? { mode: "match", text: match } : { mode: a.from === "head" ? "head" : "tail", bytes: clampInt(a.bytes, 200, 5000, 3000) };
  const p = remotePath(a.path);
  return call(cfg, a.host, `파일 ${a.host}:`, () => p && readScript(p, m), (o) => formatRead(o, `파일 ${a.host}:`, m), run);
}

// 패널 카드용: 서버마다 구조화된 GPU(접속 실패는 그 서버만 ok:false)
export async function remoteGpuData(cfg: Pick<Config, "sshHosts" | "jobHosts">, run: RemoteRun = remoteRun): Promise<GpuHost[]> {
  return Promise.all(remoteHosts(cfg).map(async (host) => {
    try { return parseGpu(await run(host, GPU_SCRIPT, 20e3), host); }
    catch (e: any) { return { host, ok: false, error: `접속하지 못했어요: ${String(e?.message ?? e).slice(0, 160)}`, gpus: [], procs: [] }; }
  }));
}

export async function remoteGpu(cfg: Pick<Config, "sshHosts" | "jobHosts">, a: { host?: string }, run: RemoteRun = remoteRun): Promise<RemoteResult[]> {
  const hosts = a.host ? [a.host] : remoteHosts(cfg);
  if (!hosts.length) return [{ ok: false, title: "GPU", body: checkHost(cfg, undefined)! }];
  return Promise.all(hosts.map((h) => call(cfg, h, `GPU ${h}`, () => GPU_SCRIPT, (o) => formatGpu(o, h), run, 20e3)));
}
