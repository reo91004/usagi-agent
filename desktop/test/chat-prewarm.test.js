import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocks, ipcHandlers, buildHandler } from './helpers/main-calls.js';

test('호버 입력창 포커스(chat-focus on)가 prewarm 을 예약하고, 닫으면 취소한다', () => {
  const calls = [];
  const win = { webContents: 'overlay', setFocusable: (v) => calls.push(['focusable', v]), focus: () => calls.push(['focus']), blur: () => calls.push(['blur']) };
  const prewarm = { schedule: () => calls.push(['schedule']), cancel: () => calls.push(['cancel']) };
  const chatFocus = buildHandler(ipcHandlers().get('chat-focus'), { win, prewarm, keepOverlayPos: (f) => f(), quietActivation() {} });
  assert.equal(chatFocus({ sender: 'evil' }, true), false);
  assert.deepEqual(calls, []);
  chatFocus({ sender: 'overlay' }, true);
  assert.deepEqual(calls, [['schedule'], ['focusable', true], ['focus']]);
  calls.length = 0;
  chatFocus({ sender: 'overlay' }, false);
  assert.deepEqual(calls, [['cancel'], ['blur'], ['focusable', false]]);
});

test('prewarm 은 280ms 늦춰 데몬에 POST /chat/prewarm 을 보낸다', () => {
  const [args] = blocks('createDelayed(').filter((a) => a.includes('/chat/prewarm'));
  const posts = [];
  const [fire, delay] = buildHandler(`[${args}]`, { post: (...a) => { posts.push(a); return Promise.resolve(); } });
  assert.equal(delay, 280);
  fire();
  assert.deepEqual(posts, [['/chat/prewarm', {}, 3000]]);
});

test('맥은 창 애니메이션을 꺼 둔다 — 입력창을 닫는 win.blur() 의 orderOut→orderBack 페이드가 캐릭터를 지우지 않게', () => {
  const [args] = blocks('app.whenReady().then(');
  const calls = [];
  const run = buildHandler(args, {
    process: { platform: 'darwin' },
    systemPreferences: { setUserDefault: (...a) => calls.push(a) },
    session: { defaultSession: { setSpellCheckerEnabled() { throw new Error('stop'); } } },
  });
  assert.throws(run, /stop/);
  assert.deepEqual(calls, [['NSAutomaticWindowAnimationsEnabled', 'boolean', false]]);
});
