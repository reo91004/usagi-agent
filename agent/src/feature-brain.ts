// 뒤에서 혼자 도는 모델 기능(끝난 할 일 판정·할 일 진행 확인·지식그래프 추출/다듬기·프로필 학습)을 누가 돌리나.
//   claude-code → 지금처럼 Claude Agent SDK(도구 없음, 구조화 출력)
//   codex       → codex exec 한 번(도구·사용자 MCP 없이 JSON 만 — providers.ts codexExec) + 모양 검사
//   agy         → agy -p 한 번(도구 없이 JSON 만 — providers.ts agyExec) + 모양 검사
//   그 밖(gemini·openai·anthropic·local) 또는 codex·agy 명령이 없으면 → 조용히 건너뛴다(기능마다 로그 한 줄, 한 번만)
// 워크트리·백그라운드 에이전트는 여기 없다 — Claude Code 전용 그대로. 코드 고치기는 codex 도 된다(fixer.ts driveCodex).
// 메일·이슈 MCP 연결은 Codex·agy 뇌면 채팅에서만 읽는다(cli-mcp.ts) — 뒤에서 하는 정리·브리핑·캘린더 동기화는 Claude Code 뇌일 때만
import type { Config } from "./config.ts";
import { brainOrder, activeBrain, isCooled, withFallback } from "./brain-fallback.ts";
import { DEFAULT_GENERAL_MODEL } from "./config.ts";
import { agyExec, agyModel, codexExec, commandOnPath, type ExecFileLike } from "./providers.ts";

export type FeatureBrain = "claude-code" | "codex" | "agy";
export type CodexDeps = { execFile?: ExecFileLike; commandExists?: (name: string) => boolean };
export type CodexStat = { costUsd: number; inTokens: number; outTokens: number; ms: number };

export const NEEDS_CODER = "이 기능은 Claude Code·Codex·Antigravity 가 있어야 돌아요";
export const NEEDS_CLAUDE_MCP = "MCP 연결(메일·이슈·캘린더·Slack)은 Claude Code·Codex·Antigravity 뇌일 때만 읽어요";
export const MCP_CHAT_ONLY = "Codex·Antigravity 뇌는 MCP 연결을 채팅에서만 읽어요(브리핑·캘린더 동기화는 Claude Code 뇌일 때)";
export const MCP_CLI_UNUSABLE = "Codex·Antigravity 로 읽으려면 connectors 의 tools 에 읽기 도구 이름이 있고, Claude Code 에 stdio 서버나 헤더(토큰)로 붙는 http 서버로 등록돼 있어야 해요. Claude Code 안에서 로그인한 서버(Slack 공식·Jira 등)는 넘기지 못해요";
// 캘린더 MCP 동기화(일정 알림·오늘 일정)는 Claude Code 뇌로만 돈다(calendar-sync.ts mcpCalendarSource)
export const CAL_MCP_CLAUDE_ONLY = "캘린더 MCP 는 Claude Code 뇌일 때만 일정을 가져와요. 이 Mac 캘린더나 ICS 주소는 어떤 뇌든 돼요";
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
    if (p !== "codex" && p !== "agy") return null;
  }
  return null;
}

// 구조화 호출을 어느 길로 보낼지(호출 직전). 건너뛸지는 featureBrain 이 앞에서 정한다 — 여기선 provider 만 본다
// codex·agy: 도구 없이 CLI 한 번으로 구조화 답을 받는 뇌(cliStructured)
export const usesCli = (cfg: Pick<Config, "brain">) => { const p = activeBrain(cfg); return p === "codex" || p === "agy"; };

const noted = new Set<string>();
// 기능마다 한 번만 알린다(뇌를 바꾸면 다시 한 번)
export function skipQuietly(feature: string, cfg: Pick<Config, "brain">, log: (s: string) => void = console.log, why = NEEDS_CODER): void {
  const key = `${feature}:${cfg.brain?.provider ?? "claude-code"}`;
  if (noted.has(key)) return;
  noted.add(key);
  log(`[${feature}] ${why} — 건너뜀`);
}
export function resetSkipNotes() { noted.clear(); }

// 패널·상태용 커넥터 목록(대시보드·GET /status 가 같이 쓴다): Codex·agy 뇌면 넘길 수 있는 서버(usable — cli-mcp.ts cliMcpServers 의 이름, 그 뇌일 때만 부른다)만 준비됨 + 「채팅에서만」(캘린더는 동기화가 안 돌아 준비 안 됨),
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
    if (c.cap === "calendar") return { ...c, ready: false, detail: CAL_MCP_CLAUDE_ONLY };
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
  const order = brainOrder(cfg), cli = order.filter((e) => e.provider === "codex" || e.provider === "agy");
  const [head, ...rest] = cli;
  const c0 = { ...cfg, brain: { ...cfg.brain, provider: head.provider, fallback: rest }, models: head === order[0] ? cfg.models : { ...cfg.models, general: head.model ?? DEFAULT_GENERAL_MODEL } };
  return withFallback(c0, (c) => c.brain.provider !== "agy" ? codexStructured<T>(spec, deps)
    : cliCall<T>("Antigravity", (s) => agyExec(s.prompt, s.schema, { system: s.system, execFile: deps.execFile, commandExists: deps.commandExists, timeoutMs: s.timeoutMs, model: agyModel(c) }), spec));
}

async function cliCall<T>(who: string, run: (s: { system: string; prompt: string; schema: unknown; timeoutMs?: number }) => Promise<{ out: unknown; usage: { inTokens: number; outTokens: number } }>, spec: { system: string; prompt: string; schema: unknown; timeoutMs?: number }): Promise<{ out: T; stat: CodexStat }> {
  const t0 = Date.now();
  const { out, usage } = await run(spec);
  const bad = shapeError(out, spec.schema);
  if (bad) throw new Error(`${who} 답이 형식에 맞지 않아요(${bad})`);
  return { out: out as T, stat: { costUsd: 0, inTokens: usage.inTokens, outTokens: usage.outTokens, ms: Date.now() - t0 } };
}
