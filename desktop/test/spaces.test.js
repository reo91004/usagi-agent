import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandler, decl } from './helpers/main-calls.js';
import { showOnCurrentSpace, SETTLE_MS } from '../src/spaces.js';
import { panelClickAction } from '../src/dock.js';

const fakes = () => {
  const calls = [];
  const win = {
    setVisibleOnAllWorkspaces: (on, opts) => calls.push(['all', on, opts]),
    show: () => calls.push(['show']),
    focus: () => calls.push(['focus']),
    isDestroyed: () => false,
  };
  const app = { focus: (opts) => calls.push(['app.focus', opts]) };
  return { calls, win, app };
};

test('macOS: 모든 데스크탑에 보이게 → 앱 앞으로 → show·focus → 활성화가 끝난 뒤에 끄기(Dock 은 그대로)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { calls, win, app } = fakes();
    const keep = { skipTransformProcessType: true };
    showOnCurrentSpace(win, app, 'darwin');
    assert.deepEqual(calls, [['all', true, keep], ['app.focus', { steal: true }], ['show'], ['focus']], '바로 끄면 macOS 가 옛 데스크탑으로 넘어간다');
    mock.timers.tick(SETTLE_MS / 2);
    showOnCurrentSpace(win, app, 'darwin'); // 그사이 다시 열면 앞 타이머는 버린다
    mock.timers.tick(SETTLE_MS - 1);
    assert.equal(calls.filter((c) => c[0] === 'all' && !c[1]).length, 0);
    mock.timers.tick(1);
    assert.deepEqual(calls.at(-1), ['all', false, keep]);
    assert.equal(calls.filter((c) => c[0] === 'all' && !c[1]).length, 1);
  } finally { mock.timers.reset(); }
});

test('macOS 밖: show·focus 만', () => {
  const { calls, win, app } = fakes();
  showOnCurrentSpace(win, app, 'win32');
  assert.deepEqual(calls, [['show'], ['focus']]);
});

test('패널·세션 창은 이 도우미로 연다', () => {
  const calls = [];
  const app = 'app', panel = 'panel', sessionWin = 'session';
  const common = { app, spaceMoved: false, showOnCurrentSpace: (...a) => calls.push(a), refreshCaps() {}, sendPanel() {}, sendSession() {}, okRunId: () => false, okToolUseId: () => false };
  buildHandler(decl('showPanel'), { ...common, panel, panelReady: true })('settings');
  buildHandler(decl('showSession'), { ...common, sessionWin, sessionReady: true })();
  assert.deepEqual(calls, [[panel, app], [sessionWin, app]]);
});

test('다른 데스크탑으로 옮긴 뒤 캐릭터 클릭은 옛 데스크탑에서 포커스를 가진 패널을 숨기지 않고 가져온다', () => {
  const run = (spaceMoved) => {
    const calls = [];
    const panel = { isVisible: () => true, isFocused: () => true, hide: () => calls.push('hide') };
    buildHandler(decl('togglePanel'), { panel, spaceMoved, panelClickAction, showPanel: () => calls.push('show') })();
    return calls;
  };
  assert.deepEqual(run(false), ['hide']);
  assert.deepEqual(run(true), ['show']);
});
