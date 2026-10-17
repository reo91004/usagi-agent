// 채팅 정지(#148): 신호가 HTTP 요청·자식 프로세스·예비 agy 까지 내려가는지 (가짜 fetch·가짜 spawn, 실제 호출 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadConfig } from "./config.ts";
import { createAgyWarm } from "./agy-warm.ts";
import { codexExec, defaultExecFile, geminiJson, anthropicJson, openaiJson, type FetchLike } from "./providers.ts";

const cfg = loadConfig({});
const SCHEMA = { type: "object", required: ["reply"], properties: { reply: { type: "string" } } };
// 신호가 abort 되면 AbortError 로 끝나는 가짜 fetch(signal 을 받지 않으면 영원히 대기)
const hangingFetch = (seen: { signal?: AbortSignal }): FetchLike => (_u, init) => new Promise((_res, rej) => {
  seen.signal = init?.signal;
  init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
});

for (const [name, call] of [
  ["gemini", (o: any) => geminiJson(cfg, "p", SCHEMA, { env: { GEMINI_API_KEY: "k" }, model: "gemini-3.8-flash", ...o })],
  ["openai", (o: any) => openaiJson(cfg, "p", SCHEMA, { env: { OPENAI_API_KEY: "k" }, ...o })],
  ["anthropic", (o: any) => anthropicJson(cfg, "p", SCHEMA, { env: { CY_AGENT_ANTHROPIC_API_KEY: "k" }, ...o })],
] as const) {
  test(`${name}: 정지하면 진행 중인 요청이 끊긴다`, async () => {
    const seen: { signal?: AbortSignal } = {};
    const ac = new AbortController();
    const p = call({ fetch: hangingFetch(seen), signal: ac.signal });
    setImmediate(() => ac.abort());
    await assert.rejects(p);
    assert.equal(seen.signal, ac.signal);
  });
}

test("codexExec: signal 이 execFile 까지 간다", async () => {
  let got: AbortSignal | undefined;
  const ac = new AbortController();
  await codexExec("p", SCHEMA, { commandExists: () => true, signal: ac.signal, execFile: async (_f, _a, o) => { got = o?.signal; return { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"reply\":\"x\"}" } }) }; } });
  assert.equal(got, ac.signal);
});

test("defaultExecFile: 정지하면 자식을 죽이고 멈췄어요로 끝난다", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const p = defaultExecFile(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { signal: ac.signal, timeout: 60_000 });
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(p, /멈췄어요/);
  assert.ok(Date.now() - t0 < 5000);
  await assert.rejects(defaultExecFile(process.execPath, ["-e", "1"], { signal: AbortSignal.abort() }), /멈췄어요/);
});

class Fake extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); stdin = Object.assign(new EventEmitter(), { write() { return true; }, end() {} });
  killed = false;
  kill() { this.killed = true; this.emit("exit"); }
}
test("agyWarm.runTurn: 정지하면 이 턴의 자식만 죽이고 다른 예비는 그대로", async () => {
  const kids: Fake[] = [];
  const warm = createAgyWarm({ spawn: () => { const c = new Fake(); kids.push(c); return c as any; }, setTimer: () => ({}), clearTimer: () => {} });
  warm.prewarm("a", [], "/d"); warm.prewarm("b", [], "/d");
  const s = warm.take("a")!;
  const ac = new AbortController();
  const p = warm.runTurn(s, "안녕", 1000, ac.signal);
  ac.abort();
  await assert.rejects(p, /멈췄어요/);
  assert.ok(kids[0].killed);
  assert.ok(!kids[1].killed);
  assert.equal(warm.count(), 1);
  warm.prewarm("a", [], "/d"); // 호출한 쪽의 finally 처럼 다시 띄울 수 있다
  assert.equal(kids.length, 3);
});
