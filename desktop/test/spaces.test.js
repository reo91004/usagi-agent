import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandler, decl } from './helpers/main-calls.js';
import { showOnCurrentSpace } from '../src/spaces.js';

const fakes = () => {
  const calls = [];
  const win = {
    setVisibleOnAllWorkspaces: (on, opts) => calls.push(['all', on, opts]),
    show: () => calls.push(['show']),
    focus: () => calls.push(['focus']),
  };
  const app = { focus: (opts) => calls.push(['app.focus', opts]) };
  return { calls, win, app };
};

test('macOS: 모든 데스크탑에 보이게 → 앱 앞으로 → show·focus → 다시 끄기(Dock 은 그대로)', () => {
  const { calls, win, app } = fakes();
  showOnCurrentSpace(win, app, 'darwin');
  const keep = { skipTransformProcessType: true };
  assert.deepEqual(calls, [['all', true, keep], ['app.focus', { steal: true }], ['show'], ['focus'], ['all', false, keep]]);
});

test('macOS 밖: show·focus 만', () => {
  const { calls, win, app } = fakes();
  showOnCurrentSpace(win, app, 'win32');
  assert.deepEqual(calls, [['show'], ['focus']]);
});

test('패널·세션 창은 이 도우미로 연다', () => {
  const calls = [];
  const app = 'app', panel = 'panel', sessionWin = 'session';
  const common = { app, showOnCurrentSpace: (...a) => calls.push(a), refreshCaps() {}, sendPanel() {}, sendSession() {}, okRunId: () => false, okToolUseId: () => false };
  buildHandler(decl('showPanel'), { ...common, panel, panelReady: true })('settings');
  buildHandler(decl('showSession'), { ...common, sessionWin, sessionReady: true })();
  assert.deepEqual(calls, [[panel, app], [sessionWin, app]]);
});
