import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('호버 입력창 포커스(chat-focus on)가 데몬에 POST /chat/prewarm 을 보낸다', () => {
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('chat-focus'"));
  const onBranch = handler.slice(handler.indexOf('if (on) {'), handler.indexOf('} else {'));
  assert.match(onBranch, /prewarm\.schedule\(\)/);
  assert.match(main, /createDelayed\(\(\) => \{ post\('\/chat\/prewarm', \{\}, 3000\)[^\n]*\}, 280\)/); // 280ms 늦춰서
  assert.match(handler.slice(handler.indexOf('} else {'), handler.indexOf('return true;')), /prewarm\.cancel\(\)/); // 닫을 때는 기다리던 것을 취소
});
