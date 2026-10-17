import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoalescer, createDelayed } from '../src/coalesce.js';

test('coalescer: 진행 중 요청 공유 · ttl 안 재사용 · 만료/무효화 후 새 요청 · 실패는 담지 않음', async () => {
  let now = 0, calls = 0, fail = false;
  const c = createCoalescer(async () => { calls++; return fail ? { ok: false } : { ok: true, n: calls }; }, { ttlMs: 1000, now: () => now });
  const [a, b] = await Promise.all([c.get('t'), c.get('t')]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  now = 999; await c.get('t'); assert.equal(calls, 1);
  now = 1000; await c.get('t'); assert.equal(calls, 2);
  c.invalidate('t'); await c.get('t'); assert.equal(calls, 3);
  await c.get('u'); assert.equal(calls, 4, '키마다 따로');
  fail = true; c.invalidate('t'); await c.get('t'); await c.get('t'); assert.equal(calls, 6, '실패는 다시 시도');
});

test('coalescer: 무효화한 진행 중 요청의 늦은 결과가 새 요청의 자리를 덮지 않는다', async () => {
  let release; let n = 0;
  const c = createCoalescer(() => (++n === 1 ? new Promise((r) => { release = r; }) : Promise.resolve({ ok: true, n })), { ttlMs: 1000, now: () => 0 });
  const old = c.get('t');
  c.invalidate('t');
  assert.equal((await c.get('t')).n, 2);
  release({ ok: true, n: 1 }); await old;
  assert.equal((await c.get('t')).n, 2);
});

test('delayed: 더블클릭처럼 닫으면 실행 안 하고, 그대로 두면 한 번만', () => {
  let id = 0, ran = 0; const timers = new Map();
  const d = createDelayed(() => ran++, 280, { setTimeout: (f) => { timers.set(++id, f); return id; }, clearTimeout: (i) => timers.delete(i) });
  d.schedule(); d.schedule(); assert.equal(timers.size, 1);
  d.cancel(); assert.equal(timers.size, 0); assert.equal(ran, 0);
  d.schedule(); [...timers.values()][0](); assert.equal(ran, 1);
  d.schedule(); assert.equal(timers.size, 2); // 실행된 뒤에는 새로 예약된다(이전 id 는 쓰이지 않았으니 남아 있음)
});
