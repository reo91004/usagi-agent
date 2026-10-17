import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainSource as main, blocks } from './helpers/main-calls.js';

test('main.js 배선: 세션 맞춤법 검사기를 꺼서 첫 실행에 사전(bdic)을 받지 않는다', () => {
  assert.match(main, /^import \{[^}]*\bsession\b[^}]*\} from 'electron';/m);
  // 기본 세션: 준비되자마자, 창을 만들기 전에
  const ready = main.indexOf('app.whenReady().then(() => {');
  const off = main.indexOf('session.defaultSession.setSpellCheckerEnabled(false)');
  assert.ok(ready > 0 && off > ready, 'whenReady 안에서 끈다');
  assert.ok(off < main.indexOf('createWindow();', ready), '창보다 먼저');
  // 나중에 생기는 세션(fromPartition 등)도
  assert.match(main, /app\.on\('session-created', \(s\) => s\.setSpellCheckerEnabled\(false\)\);/);
  assert.ok(main.indexOf("app.on('session-created'") < ready);
});

test('모든 BrowserWindow 의 webPreferences 에 spellcheck:false, 격리 유지', () => {
  const wins = blocks('new BrowserWindow(');
  assert.ok(wins.length >= 4, `창 ${wins.length}개`);
  for (const opts of wins) {
    const [wp, ...more] = blocks('webPreferences: {', opts); // 창 옵션의 다른 키와 섞이지 않게 이 객체만 본다
    assert.equal(more.length, 0);
    assert.match(wp, /\bspellcheck: false\b/, opts.slice(0, 60));
    assert.doesNotMatch(wp, /nodeIntegration: true|contextIsolation: false|sandbox: false/);
  }
});
