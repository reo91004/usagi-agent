import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipcHandlers } from './helpers/main-calls.js';

// 보낸 창을 확인하지 않는 채널: 받는 값이 없고 오버레이 창 동작만 바꾼다
const NO_SENDER_CHECK = ['character-menu', 'drag-end', 'drag-start', 'set-interactive'];

test('모든 IPC 채널은 보낸 창(fromOurs/fromPanel/fromDebug 또는 e.sender 직접 비교)을 확인한다', () => {
  const h = ipcHandlers();
  assert.ok(h.size > 100, `채널 ${h.size}개`);
  const open = [...h].filter(([, src]) => !/\bfrom(Ours|Panel|Debug)\(|\be\.sender\b/.test(src)).map(([ch]) => ch);
  assert.deepEqual(open.sort(), NO_SENDER_CHECK);
});
