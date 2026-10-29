import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHORTCUTS, fromEvent, problem, resolveShortcuts, applyShortcut, label } from '../src/shortcuts.js';

const ev = (code, mods = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('fromEvent: 자판 자리(code)로 읽어 한글 입력 중에도 같은 키, 수식 키만이면 null', () => {
  assert.equal(fromEvent(ev('KeyD', { metaKey: true, shiftKey: true, key: 'ㅇ' })), 'CmdOrCtrl+Shift+D');
  assert.equal(fromEvent(ev('Digit0', { metaKey: true })), 'CmdOrCtrl+0');
  assert.equal(fromEvent(ev('Comma', { metaKey: true, ctrlKey: true, altKey: true })), 'CmdOrCtrl+Ctrl+Alt+,');
  assert.equal(fromEvent(ev('ArrowUp', { altKey: true })), 'Alt+Up');
  assert.equal(fromEvent(ev('F5')), 'F5');
  assert.equal(fromEvent(ev('MetaLeft', { metaKey: true })), null);
  assert.equal(fromEvent(ev('Tab', { metaKey: true })), null);
  // 윈도우: Ctrl 이 CmdOrCtrl, 윈도우 키는 안 씀
  assert.equal(fromEvent(ev('KeyN', { ctrlKey: true }), true), 'CmdOrCtrl+N');
  assert.equal(fromEvent(ev('KeyN', { metaKey: true }), true), 'N');
});

test('problem: 수식 키 없는 글자·늘 쓰는 키·틀린 모양은 못 쓴다', () => {
  assert.equal(problem('CmdOrCtrl+Shift+D'), null);
  assert.equal(problem('Alt+K'), null);
  assert.equal(problem('F7'), null);
  assert.match(problem('Shift+D'), /같이 눌러/);
  assert.match(problem('D'), /같이 눌러/);
  assert.match(problem('CmdOrCtrl+W'), /⌘W 키는 늘 쓰는/);
  assert.match(problem('CmdOrCtrl+3'), /늘 쓰는/);
  assert.match(problem('CmdOrCtrl+W', true), /Ctrl\+W 키는/);
  for (const bad of ['', 'Cmd+D', 'CmdOrCtrl+', 'CmdOrCtrl+CmdOrCtrl+D', 'CmdOrCtrl+Tab', 'x'.repeat(50)]) assert.ok(problem(bad), bad);
});

test('resolveShortcuts: 바꾼 것만 덮고, 틀린 값은 기본값, 겹치면 뒤 명령을 끈다', () => {
  const def = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.def]));
  assert.deepEqual(resolveShortcuts(undefined), def);
  assert.equal(def.help, 'CmdOrCtrl+Shift+D');
  assert.deepEqual(resolveShortcuts({ help: '', newChat: 'Alt+Shift+N' }), { ...def, help: '', newChat: 'Alt+Shift+N' });
  assert.equal(resolveShortcuts({ help: 'CmdOrCtrl+W' }).help, def.help);
  assert.equal(resolveShortcuts({ help: 'Shift+CmdOrCtrl+K' }).help, 'CmdOrCtrl+Shift+K'); // 순서는 정해진 대로
  assert.equal(resolveShortcuts({ settings: 'CmdOrCtrl+0' }).settings, ''); // 대시보드가 먼저 씀
});

test('applyShortcut: 바꾸기·끄기·기본값, 겹치거나 못 쓰는 키는 까닭과 함께 거절', () => {
  let r = applyShortcut({}, 'help', 'CmdOrCtrl+Alt+H');
  assert.equal(r.ok, false); // ⌘⌥H 는 기타 가리기
  r = applyShortcut({}, 'help', 'CmdOrCtrl+Shift+H');
  assert.deepEqual(r, { ok: true, saved: { help: 'CmdOrCtrl+Shift+H' } });
  r = applyShortcut(r.saved, 'help', null);
  assert.deepEqual(r, { ok: true, saved: {} }); // 기본값이면 저장에서 뺀다
  assert.deepEqual(applyShortcut({}, 'dashboard', ''), { ok: true, saved: { dashboard: '' } });
  assert.deepEqual(applyShortcut({}, 'newChat', 'CmdOrCtrl+0'), { ok: false, error: '⌘0 키는 「대시보드 열기」가 쓰고 있어요' });
  // 끈 명령의 키는 다른 명령이 가져갈 수 있고, 그 뒤 기본값으로 되돌리면 겹친다고 알린다
  r = applyShortcut({ dashboard: '' }, 'newChat', 'CmdOrCtrl+0');
  assert.equal(r.ok, true);
  assert.match(applyShortcut(r.saved, 'dashboard', null).error, /「새 대화」가 쓰고/);
  assert.equal(applyShortcut({}, 'session', 'CmdOrCtrl+Shift+S').ok, true); // 지금 키 그대로
  assert.equal(applyShortcut({}, 'nope', 'F5').ok, false);
  assert.equal(applyShortcut({}, 'help', 3).ok, false);
  assert.match(applyShortcut({}, 'help', 'Shift+K').error, /같이 눌러/);
});

test('label: 맥은 ⌃⌥⇧⌘ 순서 기호, 윈도우는 Ctrl+…, 없으면 없음', () => {
  assert.equal(label('CmdOrCtrl+Shift+D'), '⇧⌘D');
  assert.equal(label('CmdOrCtrl+Ctrl+Alt+Up'), '⌃⌥⌘↑');
  assert.equal(label('CmdOrCtrl+,'), '⌘,');
  assert.equal(label('CmdOrCtrl+Shift+D', true), 'Ctrl+Shift+D');
  assert.equal(label(''), '없음');
});

test('main: ⌘⇧D 는 전역 단축키가 아니고, 메뉴 단축키는 설정값을 쓴다', () => {
  const m = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(m, /globalShortcut/);
  for (const id of SHORTCUTS.map((s) => s.id)) assert.match(m, new RegExp(`\\.\\.\\.key\\('${id}'\\)`), id);
  assert.match(m, /label: '새 대화', \.\.\.key\('newChat'\), click: \(\) => showPanel\('chat', NEW_CHAT\)/);
  // 새 키를 받는 동안은 메뉴를 비운다(맥 메뉴 단축키가 창보다 먼저 키를 가져감) · 패널을 벗어나면 되돌린다
  assert.match(m, /function createAppMenu\(\) \{\n[^\n]*\n  if \(shortcutRecording\) \{ Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(\[\{ label: app\.name, submenu: \[\{ label: '새 단축키를 받는 중…', enabled: false \}\] \}\]\)\); return; \}/);
  assert.match(m, /panel\.on\('blur', \(\) => appPrefs\.recording\(false\)\)/);
  const w = readFileSync(new URL('../src/settings-window.js', import.meta.url), 'utf8');
  assert.match(w, /ipcMain\.on\('settings-shortcut-recording', \(e, on\) => \{ if \(isMine\(e\)\) deps\.appPrefs\?\.recording\(on === true\); \}\)/);
  const p = readFileSync(new URL('../renderer/panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(p, /e\.key === 'n' \|\| e\.key === 'N'/); // ⌘N 은 메뉴가 받는다(설정에서 바꾼 키가 먹게)
  assert.match(p, /if \(s === 'chat' && id === NEW_CHAT\) \{ newChat\(\); return; \}/);
});
