// 뇌 우선순위와 자동 전환(#91). 첫 뇌(brain.provider) 다음에 brain.fallback 순서로 이어 쓴다.
// 앞의 뇌가 사용량·크레딧·한도(BrainLimitError)를 다 썼거나 인증이 안 되면(BrainAuthError·BrainCreditError) 그 뇌를 풀리는 시각까지(모르면 정해진 시간)
// 건너뛰고 다음 뇌로 이어 간다. 그 밖의 오류는 그대로 올린다. 소진 기록은 메모리에만 둔다(데몬을 다시 켜면 처음부터).
// 전역 cfg 는 바꾸지 않고, 호출마다 뇌·모델만 바꾼 사본으로 부른다.
import { DEFAULT_GENERAL_MODEL, type BrainProvider, type Config } from "./config.ts";
import { BrainAuthError, BrainCreditError, BrainLimitError, brainKeyReady } from "./providers.ts";

export const BRAIN_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", agy: "Antigravity", anthropic: "Claude API", gemini: "Gemini", openai: "OpenAI", genspark: "Genspark", local: "로컬(모델 없음)" };
export const COOLDOWN_MS = { exhausted: 60 * 60_000, rate: 2 * 60_000, auth: 10 * 60_000 }; // 로그인은 터미널에서 고치면 설정을 안 거치니 짧게

type Cfg = Pick<Config, "brain" | "models">;
export type BrainEntry = { provider: BrainProvider; model?: string };
const cooled = new Map<string, { until: number; err: Error }>();
let onSwitch: ((s: { from: BrainProvider; to: BrainProvider; reason: Error }) => void) | undefined;
// 넘어갈 때(호출당 한 번) 부른다. main 이 말풍선·상태 알림으로 잇는다
export const onBrainSwitch = (fn: typeof onSwitch) => { onSwitch = fn; };
export const resetBrainCooldowns = () => cooled.clear();

const unusable = (e: unknown): e is BrainLimitError | BrainAuthError | BrainCreditError => e instanceof BrainLimitError || e instanceof BrainAuthError || e instanceof BrainCreditError;

function markCooldown(provider: string, err: Error, now: number) {
  const until = err instanceof BrainLimitError ? err.resetsAt ?? now + COOLDOWN_MS[err.kind] : err instanceof BrainAuthError ? now + COOLDOWN_MS.auth : now + COOLDOWN_MS.exhausted; // 크레딧은 사용자가 채워야 풀린다 — 설정을 바꾸면 resetBrainCooldowns
  cooled.set(provider, { until: Math.max(until, now + 1000), err });
}
export const isCooled = (provider: string, now = Date.now()) => !!coolUntil(provider, now);
const coolUntil = (provider: string, now: number) => { const c = cooled.get(provider); return c && c.until > now ? c.until : undefined; };

// 첫 뇌 + fallback. model 이 없는 첫 뇌는 models.general 그대로
export const brainOrder = (cfg: Pick<Config, "brain">): BrainEntry[] => [{ provider: cfg.brain?.provider ?? "claude-code" }, ...(cfg.brain?.fallback ?? [])];

// 이 호출에만 쓰는 사본. 첫 뇌는 원래 설정 그대로, 이어 받는 뇌는 자기 모델(없으면 기본 모델 — 다른 뇌의 모델 이름이 가지 않게)
export function attemptCfg<C extends Cfg>(cfg: C, e: BrainEntry, first: boolean): C {
  const brain = { ...cfg.brain, provider: e.provider };
  return first ? { ...cfg, brain } : { ...cfg, brain, models: { ...cfg.models, general: e.model ?? DEFAULT_GENERAL_MODEL } };
}

// 지금 실제로 쓰는 뇌(건너뛰지 않는 첫 뇌). 다 쉬는 중이면 첫 뇌
export function activeBrain(cfg: Pick<Config, "brain">, now = Date.now()): BrainProvider {
  const order = brainOrder(cfg);
  return (order.find((e) => !coolUntil(e.provider, now)) ?? order[0]).provider;
}
// GET /status: 쉬는 중인 뇌와 다시 쓸 수 있는 시각(ms)
export const brainCooldowns = (now = Date.now()): Record<string, number> =>
  Object.fromEntries([...cooled].filter(([, c]) => c.until > now).map(([p, c]) => [p, c.until]));

// call 을 순서대로 시도한다. attempt = 이번 시도의 뇌·사본(first = 첫 뇌인가)
export async function withFallback<C extends Cfg, T>(
  cfg: C, call: (c: C, a: { entry: BrainEntry; first: boolean }) => Promise<T>,
  { now = Date.now, ready = (c: Cfg) => brainKeyReady(c) }: { now?: () => number; ready?: (c: Cfg) => boolean | undefined } = {},
): Promise<T> {
  const order = brainOrder(cfg);
  if (order.length === 1) return call(cfg, { entry: order[0], first: true }); // 이어 쓸 뇌가 없으면 예전 그대로
  const errors: [BrainProvider, Error][] = [];
  let from: [BrainProvider, Error] | undefined;
  for (const [i, entry] of order.entries()) {
    const c = cooled.get(entry.provider);
    if (coolUntil(entry.provider, now())) { errors.push([entry.provider, c!.err]); continue; }
    const acfg = attemptCfg(cfg, entry, i === 0);
    if (i > 0 && ready(acfg) === false) continue; // 키·명령이 없는 뇌는 건너뛴다(처음 뇌는 그대로 시도해 알맞은 안내가 나가게)
    if (from) { try { onSwitch?.({ from: from[0], to: entry.provider, reason: from[1] }); } catch { /* 알림 실패는 무시 */ } from = undefined; }
    try {
      return await call(acfg, { entry, first: i === 0 });
    } catch (e) {
      if (!unusable(e)) throw e;
      markCooldown(entry.provider, e, now());
      errors.push([entry.provider, e]);
      from = [entry.provider, e];
    }
  }
  const [, e0] = errors[0] ?? [order[0].provider, new Error("쓸 수 있는 AI 가 없어요")];
  const rest = errors.slice(1).map(([p, e]) => `${BRAIN_LABEL[p] ?? p}: ${e.message}`);
  throw rest.length ? new Error(`${e0.message} (이어서 시도한 AI 도 안 됐어요 — ${rest.join(" / ")})`, { cause: e0 }) : e0;
}
