// 뒤에서 혼자 도는 모델 기능(끝난 할 일 판정·할 일 진행 확인·지식그래프 추출/다듬기·프로필 학습)을 누가 돌리나.
//   claude-code → 지금처럼 Claude Agent SDK(도구 없음, 구조화 출력)
//   codex       → codex exec 한 번(도구·사용자 MCP 없이 JSON 만 — providers.ts codexExec) + 모양 검사
//   agy         → agy -p 한 번(도구 없이 JSON 만 — providers.ts agyExec) + 모양 검사
//   gemini·openai·anthropic·genspark → API 한 번(providers.ts remoteJson 구조화 출력, 도구 없음) + 모양 검사. 금액은 API 가 알려 준 토큰으로 계산(apiCostUsd)
//   local, 또는 키·codex·agy 명령이 없으면 → 조용히 건너뛴다(기능마다 로그 한 줄, 한 번만)
// 워크트리·백그라운드 에이전트는 여기 없다 — Claude Code 전용 그대로. 코드 고치기는 codex 도 된다(fixer.ts driveCodex).
// 사용자 MCP 연결(메일·이슈·캘린더)은 Codex·agy 뇌도 채팅과 브리핑에서 읽는다(cli-mcp.ts, 읽기 도구만). 캘린더 MCP 동기화는 Claude Code·Codex 뇌만(calendar-sync.ts)
import type { Config } from "./config.ts";
import { BRAIN_LABEL, brainOrder, activeBrain, isCooled, withFallback } from "./brain-fallback.ts";
import { DEFAULT_GENERAL_MODEL } from "./config.ts";
import type { FetchLike } from "./providers.ts";
import { agyRun, brainKeyReady, codexExec, commandOnPath, remoteJson, resolveAnthropicModel, resolveHttpModel, type ApiUsage, type ExecFileLike } from "./providers.ts";

export type FeatureBrain = "claude-code" | "codex" | "agy" | "api";
const API_BRAINS = ["gemini", "openai", "anthropic", "genspark"];
export type CodexDeps = { execFile?: ExecFileLike; commandExists?: (name: string) => boolean; fetch?: FetchLike };
export type CodexStat = { costUsd: number; inTokens: number; outTokens: number; ms: number };

export const NEEDS_CODER = "이 기능은 Claude Code·Codex·Antigravity 또는 API 키(Gemini·OpenAI·Claude API·Genspark)가 있어야 돌아요";
export const NEEDS_CLAUDE_MCP = "MCP 연결(메일·이슈·캘린더·Slack)은 Claude Code·Codex·Antigravity 뇌일 때만 읽어요";
export const MCP_CHAT_ONLY = "Codex·Antigravity 뇌도 MCP 연결을 읽기 전용으로 읽어요(채팅·브리핑)";
export const MCP_CLI_UNUSABLE = "Codex·Antigravity 로 읽으려면 connectors 의 tools 에 읽기 도구 이름이 있고, Claude Code 에 stdio 서버나 헤더(토큰)로 붙는 http 서버로 등록돼 있어야 해요. Claude Code 안에서 로그인한 서버(Slack 공식·Jira 등)는 넘기지 못해요";
// 캘린더 MCP 동기화(일정 알림·오늘 일정)는 Claude Code·Codex 뇌로만 돈다(calendar-sync.ts mcpCalendarSource). Antigravity 는 실행마다 부름을 확인할 수 없어 안 한다
export const CAL_MCP_CLAUDE_ONLY = "캘린더 MCP 는 Claude Code·Codex 뇌일 때만 일정을 가져와요(Antigravity 는 안 돼요). 이 Mac 캘린더나 ICS 주소는 어떤 뇌든 돼요";
export const MCP_CAL_CODEX = "Codex 뇌도 캘린더 MCP 를 읽기 전용으로 읽어요(30분마다 동기화)";
// 뇌가 Claude Code 가 아닐 때 MCP 연결 줄에 붙일 말
export const mcpBrainNote = (provider?: string) => (provider === "codex" || provider === "agy" ? MCP_CHAT_ONLY : NEEDS_CLAUDE_MCP);

// 이 기능들을 돌릴 뇌. 없으면 null. 설치 마법사를 마치기 전(onboarded false)에도 null: 아무 모델 작업도 하지 않는다(onboarding.ts)
export function featureBrain(cfg: Pick<Config, "brain" | "onboarded">, exists: (name: string) => boolean = (n) => commandOnPath(n)): FeatureBrain | null {
  if (cfg.onboarded === false) return null;
  // 첫 뇌부터 차례로: 한도로 쉬는 뇌는 건너뛰고, 명령이 없는 CLI 도 건너뛴다. 쉬지 않는데 뒤에서 못 도는 뇌(API 키 방식)를 만나면 거기서 멈춘다
  for (const { provider: p } of brainOrder(cfg)) {
    if (isCooled(p)) continue;
    if (p === "claude-code") return "claude-code";
    if ((p === "codex" || p === "agy") && exists(p)) return p;
    if (API_BRAINS.includes(p)) { if (brainKeyReady({ brain: { ...cfg.brain, provider: p } })) return "api"; continue; }
    if (p !== "codex" && p !== "agy") return null;
  }
  return null;
}

// 구조화 호출을 어느 길로 보낼지(호출 직전). 건너뛸지는 featureBrain 이 앞에서 정한다 — 여기선 provider 만 본다
// codex·agy·API 키 뇌: 도구 없이 한 번으로 구조화 답을 받는 뇌(cliStructured). 호출부의 호출 수 상한(CLI_MAX_CALLS 등)도 이 뇌들에 같이 걸린다
export const usesCli = (cfg: Pick<Config, "brain">) => { const p = activeBrain(cfg); return p === "codex" || p === "agy" || API_BRAINS.includes(p); };

// 100만 토큰당 USD [입력, 출력] 추정(공개 가격표 기준 어림값 — 모델을 못 알아보면 비싼 쪽 Sonnet 급으로 잡아 예산이 일찍 멈추게). Genspark 는 크레딧제라 USD 를 모른다(0 — 호출 수 상한만)
const PRICE: [RegExp, [number, number]][] = [
  [/haiku/, [1, 5]], [/opus/, [5, 25]], [/sonnet|claude/, [3, 15]],
  [/gpt-4\.1-mini|gpt-5\S*-mini/, [0.4, 1.6]], [/gpt-4\.1-nano|nano/, [0.1, 0.4]], [/gpt/, [2, 8]],
  [/flash-lite|lite/, [0.1, 0.4]], [/flash/, [0.3, 2.5]], [/gemini/, [1.25, 10]],
];
export function apiCostUsd(provider: string, model: string, u: ApiUsage): number {
  if (provider === "genspark") return 0;
  const [pi, po] = PRICE.find(([re]) => re.test(model))?.[1] ?? [3, 15];
  return (u.inTokens * pi + u.outTokens * po) / 1e6;
}

const noted = new Set<string>();
// 기능마다 한 번만 알린다(뇌를 바꾸면 다시 한 번)
export function skipQuietly(feature: string, cfg: Pick<Config, "brain">, log: (s: string) => void = console.log, why = NEEDS_CODER): void {
  const key = `${feature}:${cfg.brain?.provider ?? "claude-code"}`;
  if (noted.has(key)) return;
  noted.add(key);
  log(`[${feature}] ${why} — 건너뜀`);
}
export function resetSkipNotes() { noted.clear(); }

// 패널·상태용 커넥터 목록(대시보드·GET /status 가 같이 쓴다): Codex·agy 뇌면 넘길 수 있는 서버(usable — cli-mcp.ts cliMcpServers 의 이름, 그 뇌일 때만 부른다)만 준비됨 + 「채팅에서만」(캘린더는 Codex 만 동기화가 돌고 agy 는 준비 안 됨),
// 그 밖의 뇌면 MCP 연결은 준비 안 됨 + 이유(등록돼 있어도 읽지 않으니까)
export function withMcpBrain<T extends { cap?: string; mode: string; ready: boolean; detail?: string; server?: string }>(cfg: Pick<Config, "brain">, list: T[], usable: () => readonly string[] = () => []): T[] {
  const p = cfg.brain?.provider ?? "claude-code";
  if (p === "claude-code") return list;
  const cli = p === "codex" || p === "agy";
  const ok = cli ? usable() : [];
  return list.map((c) => {
    if (c.mode !== "mcp") return c;
    if (!cli) return { ...c, ready: false, detail: NEEDS_CLAUDE_MCP };
    if (!c.ready) return c; // 등록 안 됨 같은 원래 이유
    if (c.cap === "calendar") return p === "codex" && ok.includes(c.server ?? "") ? { ...c, detail: `${c.detail} · ${MCP_CAL_CODEX}` } : { ...c, ready: false, detail: ok.includes(c.server ?? "") || p === "agy" ? CAL_MCP_CLAUDE_ONLY : MCP_CLI_UNUSABLE };
    return ok.includes(c.server ?? "") ? { ...c, detail: `${c.detail} · ${MCP_CHAT_ONLY}` } : { ...c, ready: false, detail: MCP_CLI_UNUSABLE };
  });
}

// JSON 스키마의 겉모양만 본다: 맨 위 객체·필수 키·맨 위 속성의 타입(배열은 배열, 글은 글).
// 항목 하나하나는 기능마다 이미 걸러 내므로(알 수 없는 id·근거 없는 것 버림) 여기선 통째로 어긋난 답만 막는다.
export function shapeError(out: unknown, schema: unknown): string | undefined {
  const sc = schema as { type?: string; required?: string[]; properties?: Record<string, { type?: string | string[] }> } | undefined;
  if (!sc || sc.type !== "object") return undefined;
  if (out === null || typeof out !== "object" || Array.isArray(out)) return "객체가 아님";
  const o = out as Record<string, unknown>;
  for (const k of sc.required ?? []) if (!(k in o)) return `${k} 없음`;
  for (const [k, p] of Object.entries(sc.properties ?? {})) {
    if (!(k in o) || o[k] === null || !p?.type) continue;
    const types = Array.isArray(p.type) ? p.type : [p.type];
    const v = o[k];
    const ok = types.some((t) => t === "array" ? Array.isArray(v)
      : t === "object" ? typeof v === "object" && !Array.isArray(v)
      : t === "integer" ? Number.isInteger(v)
      : t === "null" ? v === null
      : typeof v === t);
    if (!ok) return `${k} 타입`;
  }
  return undefined;
}

// codex 로 구조화 호출 한 번. 실패는 짧은 한국어 Error(재시도는 하지 않는다 — 기능마다 이미 있는 실패 처리에 맡긴다)
export async function codexStructured<T>(
  spec: { system: string; prompt: string; schema: unknown; timeoutMs?: number },
  deps: CodexDeps = {},
): Promise<{ out: T; stat: CodexStat }> {
  return cliCall<T>("Codex", (s) => codexExec(s.prompt, s.schema, { system: s.system, execFile: deps.execFile, commandExists: deps.commandExists, timeoutMs: s.timeoutMs }), spec);
}

// 뇌가 codex 면 codex exec, agy 면 agy -p 한 번(models.general 이 고른 모델이면 --model). 호출부는 usesCli(cfg) 일 때 이걸 부른다
export async function cliStructured<T>(
  cfg: Pick<Config, "brain" | "models">,
  spec: { system: string; prompt: string; schema: unknown; timeoutMs?: number },
  deps: CodexDeps = {},
): Promise<{ out: T; stat: CodexStat }> {
  // CLI 뇌만 순서대로(첫 뇌 → fallback): 한도·인증 오류면 다음 CLI 뇌로(brain-fallback.ts)
  const order = brainOrder(cfg), cli = order.filter((e) => e.provider === "codex" || e.provider === "agy" || API_BRAINS.includes(e.provider));
  const [head, ...rest] = cli;
  const c0 = { ...cfg, brain: { ...cfg.brain, provider: head.provider, fallback: rest }, models: head === order[0] ? cfg.models : { ...cfg.models, general: head.model ?? DEFAULT_GENERAL_MODEL } };
  return withFallback(c0, (c) => API_BRAINS.includes(c.brain.provider) ? apiStructured<T>(c, spec, deps)
    : c.brain.provider !== "agy" ? codexStructured<T>(spec, deps)
    : cliCall<T>("Antigravity", (s) => agyRun(c, s.prompt, s.schema, { system: s.system, execFile: deps.execFile, commandExists: deps.commandExists, timeoutMs: s.timeoutMs }), spec));
}

// API 뇌로 구조화 호출 한 번(도구 없음). 토큰은 응답마다 모아 apiCostUsd 로 금액 계산
async function apiStructured<T>(c: Pick<Config, "brain" | "models">, spec: { system: string; prompt: string; schema: unknown; timeoutMs?: number }, deps: CodexDeps & { fetch?: FetchLike } = {}): Promise<{ out: T; stat: CodexStat }> {
  const p = c.brain.provider as "gemini" | "openai" | "anthropic" | "genspark";
  const used = { inTokens: 0, outTokens: 0 };
  const run = (s: typeof spec) => remoteJson(p, c, s.prompt, s.schema, { system: s.system, fetch: deps.fetch, signal: AbortSignal.timeout(s.timeoutMs ?? 120_000), onUsage: (u) => { used.inTokens += u.inTokens; used.outTokens += u.outTokens; } })
    .then((out) => ({ out, usage: used }));
  const r = await cliCall<T>(BRAIN_LABEL[p] ?? p, run, spec);
  const model = p === "anthropic" ? resolveAnthropicModel(c.models?.general) : p === "genspark" ? "genspark" : resolveHttpModel(p, c.models?.general);
  return { out: r.out, stat: { ...r.stat, costUsd: apiCostUsd(p, model, used) } };
}

async function cliCall<T>(who: string, run: (s: { system: string; prompt: string; schema: unknown; timeoutMs?: number }) => Promise<{ out: unknown; usage: { inTokens: number; outTokens: number } }>, spec: { system: string; prompt: string; schema: unknown; timeoutMs?: number }): Promise<{ out: T; stat: CodexStat }> {
  const t0 = Date.now();
  const { out, usage } = await run(spec);
  const bad = shapeError(out, spec.schema);
  if (bad) throw new Error(`${who} 답이 형식에 맞지 않아요(${bad})`);
  return { out: out as T, stat: { costUsd: 0, inTokens: usage.inTokens, outTokens: usage.outTokens, ms: Date.now() - t0 } };
}
