import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const m = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(m, /function showPanel\([^)]*\) \{[\s\S]*?showOnCurrentSpace\(panel, app\);[\s\S]*?\n\}/);
  assert.match(m, /function showSession\([^)]*\) \{[\s\S]*?showOnCurrentSpace\(sessionWin, app\);\n\}/);
});
