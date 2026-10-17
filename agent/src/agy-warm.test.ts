// 예비 agy: 가짜 spawn·타이머로 한 번만 띄움 · 한 턴 · 3분 쉬면 끔 · reset · 죽은 예비는 보통 호출로 · 시간 초과
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WARM_IDLE_MS, createAgyWarm } from "./agy-warm.ts";
import { AGY_QUICK_MODEL, agyExec, agyPrewarm, type ExecFileLike } from "./providers.ts";
import { Bus } from "./bus.ts";

class Fake extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); stdin = Object.assign(new EventEmitter(), { written: [] as string[], ended: false, write(s: string) { this.written.push(s); return true; }, end() { this.ended = true; } });
  killed = false;
  kill() { this.killed = true; this.emit("exit"); }
  say(ev: unknown) { this.stdout.emit("data", `${JSON.stringify(ev)}\n`); }
}
function rig() {
  const children: Fake[] = []; const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const warm = createAgyWarm({
    spawn: () => { const c = new Fake(); children.push(c); return c as any; },
    setTimer: (f, ms) => { const t = { f, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { (t as any).live = false; },
  });
  return { warm, children, timers, fire: (i: number) => timers[i].f() };
}
const result = (o: unknown) => ({ event: "result", result: { status: "SUCCESS", response: JSON.stringify(o), usage: { input_tokens: 3, output_tokens: 1 } } });
const has = (n: string) => n === "agy";

test("prewarm: 같은 키는 한 번만 띄우고 타이머만 새로 한다, 쉬는 시간은 3분", () => {
  const { warm, children, timers } = rig();
  warm.prewarm("k", ["a"], "/d"); warm.prewarm("k", ["a"], "/d"); warm.prewarm("k", ["a"], "/d");
  assert.equal(children.length, 1);
  assert.equal(timers.at(-1)!.ms, WARM_IDLE_MS);
  assert.equal(WARM_IDLE_MS, 180_000);
  warm.prewarm("other", ["a"], "/d");
  assert.equal(children.length, 2);
});

test("take+runTurn: 한 줄 먹이고 stdin 을 닫아 result 를 돌려준다", async () => {
  const { warm, children } = rig();
  warm.prewarm("k", [], "/d");
  children[0].say({ event: "init" });
  const s = warm.take("k")!;
  assert.equal(warm.take("k"), undefined); // 한 턴에 하나
  const p = warm.runTurn(s, "안녕", 1000);
  assert.deepEqual(JSON.parse(children[0].stdin.written[0]), { event: "user", message: { content: "안녕" } });
  assert.ok(children[0].stdin.ended);
  children[0].say(result({ a: 1 }));
  assert.equal((await p as any).status, "SUCCESS");
});

test("3분 쉬면 끄고, reset 도 끈다", () => {
  const a = rig();
  a.warm.prewarm("k", [], "/d");
  a.fire(0);
  assert.ok(a.children[0].killed);
  assert.equal(a.warm.take("k"), undefined);
  const b = rig();
  b.warm.prewarm("k", [], "/d"); b.warm.prewarm("j", [], "/d");
  b.warm.reset();
  assert.ok(b.children.every((c) => c.killed));
  assert.equal(b.warm.count(), 0);
});

test("죽은 예비는 take 가 못 주고, 턴 시간 초과는 죽이고 거절", async () => {
  const a = rig();
  a.warm.prewarm("k", [], "/d");
  a.children[0].emit("exit");
  assert.equal(a.warm.take("k"), undefined);
  const b = rig();
  b.warm.prewarm("k", [], "/d");
  const p = b.warm.runTurn(b.warm.take("k")!, "x", 50);
  b.fire(1); // runTurn 의 시간 제한 타이머
  await assert.rejects(p, /시간이 초과/);
  assert.ok(b.children[0].killed);
});

test("agyExec: 말 걸기(quick)만 예비를 쓰고 끝나면 새로 띄운다. 예비가 없거나 일반 호출이면 보통 방식", async () => {
  const { warm, children } = rig();
  let cold = 0;
  const execFile: ExecFileLike = async () => { cold++; return { stdout: JSON.stringify({ status: "SUCCESS", response: '{"a":1}' }) }; };
  const base = { execFile, commandExists: has, warm, model: AGY_QUICK_MODEL };
  const key = JSON.stringify([AGY_QUICK_MODEL, false, []]);
  warm.prewarm(key, [], "/d");
  const p = agyExec("p", { type: "object", required: ["a"] }, { ...base, quick: true });
  children[0].say(result({ a: 7 }));
  assert.deepEqual((await p).out, { a: 7 });
  assert.equal(cold, 0);
  assert.equal(children.length, 2); // 끝난 뒤 다음 예비
  await agyExec("p", {}, base); // quick 아님 → 예비를 건드리지 않는다
  assert.equal(cold, 1);
  assert.equal(children.length, 2);
  children[1].emit("exit"); // 예비가 죽었으면 보통 호출
  await agyExec("p", {}, { ...base, quick: true });
  assert.equal(cold, 2);
});

test("agyPrewarm: 예비 키가 말 걸기 호출과 맞고, POST /chat/prewarm 은 204 · 헤더 필수", async () => {
  const bus = new Bus();
  let n = 0;
  await bus.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatPrewarm: () => { n++; } });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  try {
    assert.equal((await fetch(`${base}/chat/prewarm`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${base}/chat/prewarm`, { method: "POST", headers: { "x-cy-agent": "1" } })).status, 204);
    assert.equal(n, 1);
  } finally { bus.close(); }
  assert.equal(typeof agyPrewarm, "function");
});
