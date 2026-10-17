import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type Config } from "./config.ts";
import { Store } from "./store.ts";
import { ctxApiTools, CTX_TOOL_NAMES } from "./ctx-tools.ts";
import { remoteJson, TOOL_MAX_CALLS, TOOL_MAX_ROUNDS, type ApiToolRun, type FetchLike } from "./providers.ts";
import { apiCostUsd, cliStructured, featureBrain, usesCli } from "./feature-brain.ts";

const KEYS = { geminiApiKey: "k", openaiApiKey: "k", anthropicApiKey: "k" };
const cfgOf = (provider: string) => loadConfig({}, { brain: { provider, ...KEYS } } as any) as Config;
const SCHEMA = { type: "object", additionalProperties: false, required: ["done"], properties: { done: { type: "array", items: { type: "string" } } } };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });

// 공급자별 가짜 응답: 도구 호출 차례(call)와 최종 JSON(final) 모양
const shapes = {
  anthropic: {
    call: (n: number) => json({ stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "tool_use", id: `tu${n}`, name: "todos_list", input: { status: "open" } }] }),
    final: () => json({ stop_reason: "end_turn", usage: { input_tokens: 200, output_tokens: 20 }, content: [{ type: "text", text: '{"done":["a"]}' }] }),
  },
  openai: {
    call: (n: number) => json({ usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "todos_list", arguments: '{"status":"open"}' } }] } }] }),
    final: () => json({ usage: { prompt_tokens: 200, completion_tokens: 20 }, choices: [{ message: { content: '{"done":["a"]}' } }] }),
  },
  gemini: {
    call: (_n: number) => json({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 }, candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "todos_list", args: { status: "open" } } }] } }] }),
    final: () => json({ usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 20 }, candidates: [{ content: { parts: [{ text: '{"done":["a"]}' }] } }] }),
  },
} as const;
type P = keyof typeof shapes;

const NONE = /"tool_choice":("none"|\{"type":"none"\})|"mode":"NONE"/;
// toolRounds 번 도구를 부르게 한 뒤 최종 JSON. 요청 본문을 모은다
function fakeFetch(p: P, toolRounds: number) {
  const bodies: any[] = [];
  const fetch: FetchLike = async (_u, init) => {
    bodies.push(JSON.parse(init!.body!));
    const off = NONE.test(init!.body!); // 도구 선택을 끄면 모델은 도구를 부르지 못하고 최종 JSON
    return bodies.length <= toolRounds && !off ? shapes[p].call(bodies.length) : shapes[p].final();
  };
  return { fetch, bodies };
}
const counting = (): ApiToolRun & { ran: string[] } => {
  const ran: string[] = [];
  return { ran, tools: [{ name: "todos_list", description: "d", schema: { type: "object", properties: {} } }], call: async (name) => { ran.push(name); return "TOOL_RESULT_MARK"; } };
};

for (const p of ["anthropic", "openai", "gemini"] as const) {
  test(`${p}: 도구 호출 한 번 왕복 — 도구 정의를 보내고, 결과를 이어 붙여 다시 보내 최종 JSON`, async () => {
    const { fetch, bodies } = fakeFetch(p, 1);
    const tools = counting();
    const out = await remoteJson(p, cfgOf(p), "p", SCHEMA, { fetch, tools, env: {} });
    assert.deepEqual(out, { done: ["a"] });
    assert.deepEqual(tools.ran, ["todos_list"]);
    assert.equal(bodies.length, 2);
    const names = (b: any) => (b.tools ?? []).flatMap((t: any) => t.functionDeclarations ?? [t]).map((t: any) => t.name ?? t.function?.name);
    assert.deepEqual(names(bodies[0]), ["todos_list"]);
    assert.ok(!JSON.stringify(bodies[0]).includes("TOOL_RESULT_MARK"));
    assert.ok(JSON.stringify(bodies[1]).includes("TOOL_RESULT_MARK"), "둘째 요청에 도구 결과");
  });

  test(`${p}: 도구 없이 부르면 tools 필드가 없고 한 번만 보낸다`, async () => {
    const { fetch, bodies } = fakeFetch(p, 0);
    await remoteJson(p, cfgOf(p), "p", SCHEMA, { fetch, env: {} });
    assert.equal(bodies.length, 1);
    assert.ok(!("tools" in bodies[0]));
  });

  test(`${p}: 끝없이 도구를 불러도 ${TOOL_MAX_ROUNDS}차례 뒤엔 도구 선택을 끄고 마지막 요청`, async () => {
    const { fetch, bodies } = fakeFetch(p, 99);
    const tools = counting();
    await remoteJson(p, cfgOf(p), "p", SCHEMA, { fetch, tools, env: {} });
    assert.equal(bodies.length, TOOL_MAX_ROUNDS + 1);
    assert.equal(tools.ran.length, TOOL_MAX_ROUNDS);
    assert.match(JSON.stringify(bodies.at(-1)), NONE);
    assert.ok(!NONE.test(JSON.stringify(bodies[0])));
  });
}

test("한 차례에 도구를 9번 부르면 8번만 실행하고 나머지는 상한 안내", async () => {
  const many = json({ stop_reason: "tool_use", content: Array.from({ length: 9 }, (_, i) => ({ type: "tool_use", id: `t${i}`, name: "todos_list", input: {} })) });
  const bodies: any[] = [];
  const fetch: FetchLike = async (_u, init) => { bodies.push(JSON.parse(init!.body!)); return bodies.length === 1 ? many : shapes.anthropic.final(); };
  const tools = counting();
  await remoteJson("anthropic", cfgOf("anthropic"), "p", SCHEMA, { fetch, tools, env: {} });
  assert.equal(tools.ran.length, TOOL_MAX_CALLS);
  assert.match(JSON.stringify(bodies[1]), /도구 호출 상한/);
});

test("ctxApiTools: 읽기 전용 CTX_TOOL_NAMES 만, 인자는 스키마로 검사하고 결과는 글", async () => {
  const store = new Store(":memory:");
  store.addTodo({ title: "API_TODO_MARK", priority: 1, source: "manual" });
  const t = ctxApiTools(cfgOf("openai"), store);
  assert.deepEqual(t.tools.map((x) => x.name).sort(), [...CTX_TOOL_NAMES].sort());
  assert.ok(t.tools.every((x) => x.schema.type === "object" && !("$schema" in x.schema)));
  assert.ok(!t.tools.some((x) => /todo_ops|merge|send|post|edit|write/i.test(x.name)));
  assert.match(await t.call("todos_list", { status: "open" }), /API_TODO_MARK/);
  assert.match(await t.call("todos_list", { status: "bogus" }), /인자가 맞지 않음/);
  assert.match(await t.call("Bash", {}), /알 수 없는 도구/);
});

// ── 뒤에서 도는 기능의 API 경로 ──
test("featureBrain·usesCli: 키 있는 API 뇌는 api, 키 없으면 다음 뇌로 넘어가고 없으면 null", () => {
  assert.equal(featureBrain(cfgOf("gemini"), () => false), "api");
  assert.equal(usesCli(cfgOf("gemini")), true);
  const nokey = loadConfig({}, { brain: { provider: "openai" } } as any) as Config;
  assert.equal(featureBrain(nokey, () => false), null);
  assert.equal(featureBrain({ ...nokey, brain: { ...nokey.brain, fallback: [{ provider: "codex" }] } }, () => true), "codex");
});

for (const p of ["anthropic", "openai", "gemini"] as const) {
  test(`cliStructured(${p}): 구조화 JSON 한 번 + 모양 검사 + API 토큰으로 금액 계산`, async () => {
    const { fetch, bodies } = fakeFetch(p, 0);
    const r = await cliStructured<{ done: string[] }>(cfgOf(p), { system: "s", prompt: "p", schema: SCHEMA }, { fetch });
    assert.deepEqual(r.out, { done: ["a"] });
    assert.equal(bodies.length, 1);
    assert.equal(r.stat.inTokens, 200);
    assert.equal(r.stat.outTokens, 20);
    assert.ok(r.stat.costUsd > 0 && r.stat.costUsd < 0.01, String(r.stat.costUsd));
    const bad: FetchLike = async () => (p === "anthropic" ? json({ content: [{ type: "text", text: '{"x":1}' }] }) : p === "openai" ? json({ choices: [{ message: { content: '{"x":1}' } }] }) : json({ candidates: [{ content: { parts: [{ text: '{"x":1}' }] } }] }));
    await assert.rejects(cliStructured(cfgOf(p), { system: "s", prompt: "p", schema: SCHEMA }, { fetch: bad }), /형식에 맞지 않아요/);
  });
}

test("apiCostUsd: 모델별 단가(100만 토큰당), 모르는 모델은 비싼 쪽, Genspark 는 0", () => {
  assert.equal(apiCostUsd("openai", "gpt-4.1-mini", { inTokens: 1e6, outTokens: 1e6 }), 2);
  assert.equal(apiCostUsd("anthropic", "claude-sonnet-5-5", { inTokens: 1e6, outTokens: 0 }), 3);
  assert.equal(apiCostUsd("gemini", "unknown-x", { inTokens: 1e6, outTokens: 1e6 }), 18);
  assert.equal(apiCostUsd("genspark", "x", { inTokens: 1e6, outTokens: 1e6 }), 0);
});
