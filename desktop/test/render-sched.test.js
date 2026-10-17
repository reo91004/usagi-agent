import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeCache, pendingShape, planRender, createPoller } from '../src/render-sched.js';

test('노드 캐시: 같은 key·글이면 재사용, 글이 바뀌거나 안 쓰면 버린다', () => {
  const c = createNodeCache();
  let built = 0;
  const mk = () => ({ n: ++built });
  const a = c.get('1', 'hi', mk);
  c.end();
  assert.equal(c.get('1', 'hi', mk), a);
  const b = c.get('2', 'x', mk);
  c.end();
  assert.notEqual(c.get('1', 'hi!', mk), a); // 글이 바뀜
  c.end(); // 2 는 이번 판에 안 썼다
  assert.notEqual(c.get('2', 'x', mk), b);
  assert.equal(built, 4);
});

test('노드 캐시: 같은 key 가 한 판에 두 번 오면 노드를 나눠 쓰지 않는다', () => {
  const c = createNodeCache();
  const a = c.get('k', 't', () => ({}));
  c.end();
  assert.equal(c.get('k', 't', () => ({})), a);
  assert.notEqual(c.get('k', 't', () => ({})), a);
});

test('pendingShape: step 만 바뀌면 같고 대기→진행이면 다르다', () => {
  const base = { pending: { c1: { threadId: 't', running: true, step: null } } };
  assert.equal(pendingShape(base), pendingShape({ pending: { c1: { threadId: 't', running: true, step: 'code.x' } } }));
  assert.notEqual(pendingShape(base), pendingShape({ pending: { c1: { threadId: 't', queued: true, step: null } } }));
});

test('planRender: 보이는 구역만 지금, 숨겨졌으면 전부 나중', () => {
  const all = ['overview', 'todos', 'projects'];
  assert.deepEqual(planRender(all, 'todos', false), { now: ['todos'], dirty: ['overview', 'projects'] });
  assert.deepEqual(planRender(all, 'todos', true), { now: [], dirty: all });
  assert.deepEqual(planRender(all, 'chat', false), { now: [], dirty: all });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('poller: 겹쳐 돌지 않고, null 이면 멈춘다', async () => {
  let running = 0, maxRunning = 0, calls = 0;
  const p = createPoller(async () => { running++; maxRunning = Math.max(maxRunning, running); await wait(15); running--; return ++calls; }, (n) => (n >= 3 ? null : 1));
  p.start(); p.start(); // 두 번째는 무시
  await wait(150);
  assert.equal(calls, 3);
  assert.equal(maxRunning, 1);
  assert.equal(p.active, false);
});

test('poller: stop 은 진행 중 확인의 결과도 버리고, 다시 start 하면 이어 간다', async () => {
  let n = 0, seen = 0;
  const q = createPoller(async () => { await wait(10); return ++n; }, () => { seen++; return 1; });
  q.start();
  await wait(3);
  q.stop(); // 첫 확인이 도는 중에 멈춤
  await wait(60);
  assert.equal(n, 1);
  assert.equal(seen, 0);
  q.start();
  await wait(40);
  q.stop();
  assert.ok(n >= 2 && seen >= 1);
});
