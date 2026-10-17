// 뇌 우선순위·자동 전환(#91): 설정 파싱, 한도 오류 구분, ask() 전환 순서·쉬는 시간·알림. 진짜 API·CLI 는 부르지 않는다(가짜 응답·query·exec)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, fallbackOf, pickBrain } from "./config.ts";
import { ask, claudeFailure } from "./brain.ts";
import { BrainAuthError, BrainLimitError, anthropicJson, codexExec, agyExec, codexLimit, geminiJson, gensparkJson, limitKindOf, openaiJson, resetBrainAuth } from "./providers.ts";
import { COOLDOWN_MS, activeBrain, brainCooldowns, onBrainSwitch, resetBrainCooldowns, withFallback } from "./brain-fallback.ts";
import { cliStructured, featureBrain, usesCli } from "./feature-brain.ts";
import { validateBrain, Settings } from "./settings.ts";
import { statusOf } from "./status.ts";

beforeEach(() => { resetBrainCooldowns(); resetBrainAuth(); onBrainSwitch(undefined); });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const base = loadConfig({});
const cfgOf = (brain: Record<string, unknown>, models: Record<string, string> = {}) => ({ ...base, onboarded: true, brain: brain as any, models: { ...base.models, ...models } });

test("config: fallback 은 모르는 뇌·local·중복·첫 뇌와 같은 것을 버리고 note 를 남긴다", () => {
  const notes: string[] = [];
  const b = pickBrain({}, { brain: { provider: "claude-code", fallback: [{ provider: "codex", model: "gpt-x" }, { provider: "codex" }, { provider: "claude-code" }, { provider: "local" }, { provider: "nope" }, { provider: "gemini" }] } }, notes);
  assert.deepEqual(b.fallback, [{ provider: "codex", model: "gpt-x" }, { provider: "gemini" }]);
  assert.equal(notes.length, 4);
  assert.equal(pickBrain({}, { brain: { provider: "codex" } }).fallback, undefined);
  assert.deepEqual(fallbackOf("x", "codex", []), []);
});

test("settings: validateBrain fallback 검증 · PUT 왕복(파일·메모리·view) · 첫 뇌가 된 것은 순서에서 빠짐", () => {
  assert.throws(() => validateBrain({ fallback: [{ provider: "local" }] }), /distinct known/);
  assert.throws(() => validateBrain({ fallback: [{ provider: "codex" }, { provider: "codex" }] }), /distinct known/);
  assert.throws(() => validateBrain({ fallback: [{ provider: "codex", model: "bad model!" }] }), /model id/);
  const dir = mkdtempSync(join(tmpdir(), "cy-fb-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ brain: { provider: "claude-code" } }));
  const cfg = loadConfig({}, { brain: { provider: "claude-code" } });
  const s = new Settings(cfg, { path });
  const r = s.put({ brain: { fallback: [{ provider: "codex" }, { provider: "gemini", model: "gemini-3.8-flash" }], keys: { gemini: "AIzaX" } } });
  assert.ok(r.ok);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).brain.fallback, [{ provider: "codex" }, { provider: "gemini", model: "gemini-3.8-flash" }]);
  assert.deepEqual(cfg.brain.fallback, [{ provider: "codex" }, { provider: "gemini", model: "gemini-3.8-flash" }]);
  assert.deepEqual(r.ok && r.settings.brain.fallback.map((e) => e.provider), ["codex", "gemini"]);
  s.put({ brain: { provider: "codex" } }); // codex 가 첫 뇌가 되면 fallback 에서 빠진다
  assert.deepEqual(cfg.brain.fallback, [{ provider: "gemini", model: "gemini-3.8-flash" }]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).brain.fallback, [{ provider: "gemini", model: "gemini-3.8-flash" }]);
  s.put({ brain: { fallback: [] } });
  assert.equal(cfg.brain.fallback, undefined);
});

test("분류: Anthropic 429 → rate(Retry-After 시각), 400 credit balance → exhausted, 그 밖은 일반 오류", async () => {
  const cfg = cfgOf({ provider: "anthropic", anthropicApiKey: "sk-ant-x" });
  const call = (res: Response) => anthropicJson(cfg, "p", {}, { fetch: async () => res, env: {} });
  await assert.rejects(call(json(429, {}, { "retry-after": "30" })), (e: any) => e instanceof BrainLimitError && e.kind === "rate" && e.provider === "anthropic" && e.resetsAt! > Date.now());
  await assert.rejects(call(json(400, { error: { message: "Your credit balance is too low to access the Anthropic API" } })), (e: any) => e instanceof BrainLimitError && e.kind === "exhausted");
  await assert.rejects(call(json(500, {})), (e: any) => !(e instanceof BrainLimitError));
  await assert.rejects(call(json(401, {})), (e: any) => e instanceof BrainAuthError);
});

test("분류: OpenAI insufficient_quota → exhausted, 429 → rate / Genspark 429 → rate", async () => {
  const cfg = cfgOf({ provider: "openai", openaiApiKey: "sk-x", gensparkApiKey: "gsk-x" });
  const sleep = async () => {};
  await assert.rejects(openaiJson(cfg, "p", {}, { fetch: async () => json(429, { error: { code: "insufficient_quota" } }), env: {}, sleep }), (e: any) => e instanceof BrainLimitError && e.kind === "exhausted" && e.provider === "openai");
  await assert.rejects(openaiJson(cfg, "p", {}, { fetch: async () => json(429, { error: { code: "rate_limit_exceeded" } }), env: {}, sleep }), (e: any) => e instanceof BrainLimitError && e.kind === "rate");
  const gf = async (url: any) => String(url).endsWith("/models") ? json(200, { data: [{ id: "claude-sonnet-5-5" }] }) : json(429, {});
  await assert.rejects(gensparkJson(cfg, "p", {}, { fetch: gf as any, env: {}, sleep }), (e: any) => e instanceof BrainLimitError && e.kind === "rate" && e.provider === "genspark");
});

test("분류: Gemini 하루 한도(모델 모두 소진) → exhausted + 풀리는 시각", async () => {
  const cfg = cfgOf({ provider: "gemini", geminiApiKey: "AIzaFB" }, { general: "gemini-fb-test" });
  const body = { error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] }, { retryDelay: "600s" }] } };
  const f = async (url: any) => String(url).includes("?pageSize") ? json(200, { models: [] }) : json(429, body);
  await assert.rejects(geminiJson(cfg, "p", {}, { fetch: f as any, env: {}, now: () => 1_000_000 }), (e: any) => e instanceof BrainLimitError && e.kind === "exhausted" && e.resetsAt === 1_000_000 + 600_000);
});

test("분류: Codex 실패 이벤트·stderr 의 한도 문구 → BrainLimitError, 답 글 속 우연한 말은 무시, 그냥 실패는 그대로", async () => {
  const has = () => true;
  const fail = (stdout: string, stderr = "") => async () => { throw Object.assign(new Error("x"), { stdout, stderr }); };
  const turnFailed = JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } }) + "\n";
  await assert.rejects(codexExec("p", {}, { execFile: fail(turnFailed), commandExists: has }), (e: any) => e instanceof BrainLimitError && e.kind === "exhausted" && e.provider === "codex");
  await assert.rejects(codexExec("p", {}, { execFile: fail("", "stream error: 429 Too Many Requests"), commandExists: has }), (e: any) => e instanceof BrainLimitError && e.kind === "rate");
  await assert.rejects(codexExec("p", {}, { execFile: fail(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "usage limit 얘기" } })), commandExists: has }), (e: any) => !(e instanceof BrainLimitError) && /실패/.test(e.message));
  assert.equal(codexLimit("", ""), undefined);
  assert.equal(limitKindOf("quota exceeded for model"), "exhausted");
  assert.equal(limitKindOf("rate limit reached"), "rate");
  assert.equal(limitKindOf("You've hit your usage limit"), "exhausted");
  assert.equal(limitKindOf("insufficient_quota"), "exhausted");
  for (const x of ["disk quota exceeded", "insufficient permissions for scope", "quota"]) assert.equal(limitKindOf(x), undefined, x); // 한도가 아닌 글
});

test("분류: agy AGY_ERROR 의 quota → BrainLimitError, 다른 AGY_ERROR 는 일반 오류", async () => {
  const has = () => true;
  const fail = (line: string) => async () => { throw Object.assign(new Error("x"), { code: 3, stderr: `x\nAGY_ERROR: ${line}\n` }); };
  await assert.rejects(agyExec("p", {}, { execFile: fail("RESOURCE_EXHAUSTED: quota exceeded"), commandExists: has }), (e: any) => e instanceof BrainLimitError && e.provider === "agy");
  await assert.rejects(agyExec("p", {}, { execFile: fail("bad request"), commandExists: has }), (e: any) => !(e instanceof BrainLimitError));
});

test("분류: Claude SDK 결과 — 사용량 문구·거절 이벤트·429 → 한도, 로그인 → 인증, 그 밖 → 일반", () => {
  const lim = claudeFailure("You've hit your limit · resets 5pm", null, undefined, { resetsAt: 1_800_000_000 }) as BrainLimitError;
  assert.ok(lim instanceof BrainLimitError && lim.kind === "exhausted" && lim.resetsAt === 1_800_000_000_000);
  assert.ok(claudeFailure("You're out of usage credits", null) instanceof BrainLimitError);
  assert.equal((claudeFailure("slow down", 429) as BrainLimitError).kind, "rate");
  assert.ok(claudeFailure("x", null, "billing_error") instanceof BrainLimitError);
  assert.ok(claudeFailure("Not logged in", null, "authentication_failed") instanceof BrainAuthError);
  const other = claudeFailure("boom", 500);
  assert.ok(!(other instanceof BrainLimitError) && /brain 실패/.test(other.message));
  // 거절 알림만 있고 결과가 다른 오류면 한도가 아니다(며칠 쉬게 하지 않게)
  assert.ok(!(claudeFailure("Prompt is too long", 500, undefined, { resetsAt: 1_800_000_000 }) instanceof BrainLimitError));
});

test("ask(): 초과 사용으로 이어 간 거절 알림 뒤의 다른 오류는 한도로 치지 않고 넘어가지도 않는다", async () => {
  const cfg = cfgOf({ provider: "claude-code", anthropicApiKey: "sk-ant-x", fallback: [{ provider: "anthropic" }] });
  const q: any = () => (async function* () {
    yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 4_000_000_000, isUsingOverage: true, overageStatus: "allowed" } };
    yield { type: "result", subtype: "success", is_error: true, result: "Prompt is too long", api_error_status: 400 };
  })();
  let calls = 0;
  const fake = async () => { calls++; return json(200, { content: [{ type: "text", text: '{"reply":"x"}' }] }); };
  resetBrainCooldowns();
  await assert.rejects(ask<string>(cfg, "안녕", null, undefined, { query: q, deps: { fetch: fake as any, env: {} } }), (e: Error) => !(e instanceof BrainLimitError) && /Prompt is too long/.test(e.message));
  assert.equal(calls, 0);
  assert.deepEqual(brainCooldowns(Date.now()), {});
});

test("ask(): 슬래시 명령(project)·백그라운드 에이전트는 다른 뇌로 넘기지 않는다", async () => {
  const cfg = cfgOf({ provider: "claude-code", anthropicApiKey: "sk-ant-x", fallback: [{ provider: "anthropic" }] });
  const q: any = () => (async function* () { yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 5pm", api_error_status: null }; })();
  let calls = 0;
  const fake = async () => { calls++; return json(200, { content: [{ type: "text", text: '{"reply":"한 척"}' }] }); };
  for (const extra of [{ project: true }, { background: { onRun() {} } as any }]) {
    resetBrainCooldowns();
    await assert.rejects(ask<string>(cfg, "/cmd", null, undefined, { query: q, deps: { fetch: fake as any, env: {} }, ...extra }), (e: any) => e instanceof BrainLimitError);
  }
  assert.equal(calls, 0);
});

const limit = (p: string, kind: "exhausted" | "rate" = "exhausted", resetsAt?: number) => new BrainLimitError(`${p} 한도`, p, kind, resetsAt);

test("withFallback: 순서대로 · 쉬는 뇌는 건너뜀 · resetsAt/기본 시간 · 전역 cfg 불변 · 알림은 전환마다 한 번", async () => {
  const cfg = cfgOf({ provider: "claude-code", fallback: [{ provider: "codex", model: "codex-m" }, { provider: "gemini" }] }, { general: "claude-opus-5-5" });
  const before = JSON.stringify(cfg);
  const seen: string[] = [], switches: string[] = [], models: string[] = [];
  onBrainSwitch((s) => switches.push(`${s.from}>${s.to}`));
  const run = (fails: Record<string, Error>, now: number) => withFallback(cfg, async (c) => {
    seen.push(c.brain.provider); models.push(c.models.general);
    if (fails[c.brain.provider]) throw fails[c.brain.provider];
    return c.brain.provider;
  }, { now: () => now, ready: () => true });
  assert.equal(await run({ "claude-code": limit("claude-code", "exhausted", 10_000_000) }, 1_000_000), "codex");
  assert.deepEqual(seen, ["claude-code", "codex"]);
  assert.deepEqual(models, ["claude-opus-5-5", "codex-m"]); // 첫 뇌는 models.general, 이어 받는 뇌는 자기 모델
  assert.equal(JSON.stringify(cfg), before);
  assert.deepEqual(switches, ["claude-code>codex"]);
  assert.equal(brainCooldowns(1_000_000)["claude-code"], 10_000_000);
  // 쉬는 중이면 claude 는 시도하지 않고 알림도 다시 안 낸다
  seen.length = 0; models.length = 0;
  assert.equal(await run({}, 2_000_000), "codex");
  assert.deepEqual(seen, ["codex"]);
  assert.equal(switches.length, 1);
  assert.equal(activeBrain(cfg, 2_000_000), "codex");
  // codex 도 인증 실패 → gemini(기본 모델), 로그인 문제는 10분 쉼
  assert.equal(await run({ codex: new BrainAuthError("로그인") }, 3_000_000), "gemini");
  assert.equal(models.at(-1), "claude-sonnet-5-5");
  assert.equal(brainCooldowns(3_000_000).codex, 3_000_000 + COOLDOWN_MS.auth); // 로그인은 10분만
  // resetsAt 이 지나면 다시 첫 뇌
  assert.equal(await run({}, 10_000_001), "claude-code");
  // 한도가 아닌 오류는 그대로 올리고 쉬지 않는다
  resetBrainCooldowns();
  await assert.rejects(run({ "claude-code": new Error("boom") }, 1), /boom/);
  assert.deepEqual(brainCooldowns(1), {});
});

test("withFallback: 모두 실패하면 첫 뇌의 오류에 시도한 AI 를 덧붙이고, rate 는 2분만 쉼 · 준비 안 된 뇌는 건너뜀", async () => {
  const cfg = cfgOf({ provider: "openai", fallback: [{ provider: "anthropic" }, { provider: "codex" }] });
  const tried: string[] = [];
  await assert.rejects(withFallback(cfg, async (c) => { tried.push(c.brain.provider); throw limit(c.brain.provider, "rate"); }, { now: () => 5, ready: (c) => c.brain.provider !== "anthropic" }),
    (e: Error) => /openai 한도/.test(e.message) && /Codex: codex 한도/.test(e.message));
  assert.deepEqual(tried, ["openai", "codex"]);
  assert.equal(brainCooldowns(5).openai, 5 + COOLDOWN_MS.rate);
  // 쉬는 뇌는 건너뛰고 남은 anthropic 만 시도
  tried.length = 0;
  await assert.rejects(withFallback(cfg, async (c) => { tried.push(c.brain.provider); throw limit(c.brain.provider, "rate"); }, { now: () => 6, ready: () => true }), /openai 한도/);
  assert.deepEqual(tried, ["anthropic"]);
});

test("ask(): Claude SDK 가 한도 결과를 주면 그 글을 답으로 내지 않고 다음 뇌(가짜 응답)가 이어 받는다", async () => {
  const cfg = cfgOf({ provider: "claude-code", anthropicApiKey: "sk-ant-x", fallback: [{ provider: "anthropic", model: "claude-haiku-5-5" }] });
  const before = JSON.stringify(cfg);
  const q: any = () => (async function* () {
    yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 4_000_000_000 } };
    yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 5pm", api_error_status: null };
  })();
  let model = "";
  const fake = async (_u: any, init: any) => { model = JSON.parse(init.body).model; return json(200, { content: [{ type: "text", text: '{"reply":"이어서 답해요"}' }] }); };
  const sw: string[] = [];
  onBrainSwitch((s) => sw.push(`${s.from}>${s.to}`));
  const out = await ask<string>(cfg, "안녕", null, undefined, { query: q, deps: { fetch: fake as any, env: {} }, model: "claude-opus-5-5" });
  assert.equal(out, "이어서 답해요");
  assert.equal(model, "claude-haiku-5-5"); // 첫 뇌에 고른 모델이 아니라 이 뇌의 모델
  assert.deepEqual(sw, ["claude-code>anthropic"]);
  assert.equal(brainCooldowns(Date.now())["claude-code"], 4_000_000_000_000);
  assert.equal(JSON.stringify(cfg), before);
});

test("ask(): fallback 이 없으면 한도 오류가 그대로 올라온다", async () => {
  const cfg = cfgOf({ provider: "claude-code" });
  const q: any = () => (async function* () { yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit", api_error_status: null }; })();
  await assert.rejects(ask(cfg, "p", null, undefined, { query: q }), (e: any) => e instanceof BrainLimitError);
});

test("뒤 작업: Claude 가 쉬는 중이면 featureBrain·usesCli 가 다음 CLI 뇌를 고르고, cliStructured 는 한도면 다음 CLI 로", async () => {
  const cfg = cfgOf({ provider: "claude-code", fallback: [{ provider: "codex" }, { provider: "agy" }] });
  const exists = () => true;
  assert.equal(featureBrain(cfg, exists), "claude-code");
  assert.equal(usesCli(cfg), false);
  await assert.rejects(withFallback(cfg, async () => { throw limit("claude-code"); }, { ready: () => false }));
  assert.equal(featureBrain(cfg, exists), "codex");
  assert.equal(usesCli(cfg), true);
  const calls: string[] = [];
  const execFile = (async (file: string) => {
    calls.push(file);
    if (file === "codex") throw Object.assign(new Error("x"), { stdout: "", stderr: "You've hit your usage limit" });
    return { stdout: JSON.stringify({ status: "SUCCESS", structured_output: { ok: true } }), stderr: "" };
  }) as any;
  const r = await cliStructured<{ ok: boolean }>(cfg, { system: "s", prompt: "p", schema: { type: "object" } }, { execFile, commandExists: exists });
  assert.deepEqual(r.out, { ok: true });
  assert.deepEqual(calls, ["codex", "agy"]);
  assert.equal(featureBrain(cfg, exists), "agy"); // codex 도 쉬는 중
});

test("status: fallback 이 있으면 지금 쓰는 뇌와 쉬는 뇌(until)를 보인다, 없으면 필드 없음", async () => {
  const cfg = cfgOf({ provider: "claude-code", fallback: [{ provider: "codex" }] });
  assert.equal(statusOf(cfg, { claude: () => true }).brain.active, "claude-code");
  await assert.rejects(withFallback(cfg, async () => { throw limit("claude-code", "exhausted", Date.now() + 9e6); }, { ready: () => false }));
  const b = statusOf(cfg, { claude: () => true }).brain;
  assert.equal(b.active, "codex");
  assert.deepEqual(b.cooling?.map((c) => c.provider), ["claude-code"]);
  resetBrainCooldowns();
  assert.equal("active" in statusOf(cfgOf({ provider: "claude-code" }), { claude: () => true }).brain, false);
});
