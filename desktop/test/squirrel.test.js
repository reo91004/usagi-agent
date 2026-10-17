// 윈도우 Squirrel 설치 이벤트 · 로그인 자동 실행 자리
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainSource, buildHandler, decl, ipcHandlers } from './helpers/main-calls.js';
import { squirrelPlan, loginItemTarget, updateExe, appUserModelId } from '../src/squirrel.js';

const EXE = 'C:\\Users\\me\\AppData\\Local\\Shisa\\app-0.2.0\\Shisa.exe';
const UPDATE = 'C:\\Users\\me\\AppData\\Local\\Shisa\\Update.exe';

test('squirrelPlan: 설치는 바로 가기 만들기, 업데이트(updated)는 아무것도 안 띄움, 제거는 지우기 + 로그인 항목 끄기, obsolete 는 그냥 끝', () => {
  const at = (arg) => squirrelPlan({ platform: 'win32', argv: [EXE, arg], execPath: EXE });
  assert.equal(updateExe(EXE), UPDATE);
  assert.deepEqual(at('--squirrel-install'), { event: 'install', run: [UPDATE, ['--createShortcut=Shisa.exe']], removeLoginItem: false });
  // 업데이트는 바로 가기를 다시 만들지 않는다(사용자가 지운 바탕화면 바로 가기가 되살아나지 않게)
  assert.deepEqual(at('--squirrel-updated'), { event: 'updated', run: null, removeLoginItem: false });
  assert.deepEqual(at('--squirrel-uninstall'), { event: 'uninstall', run: [UPDATE, ['--removeShortcut=Shisa.exe']], removeLoginItem: true });
  assert.deepEqual(at('--squirrel-obsolete'), { event: 'obsolete', run: null, removeLoginItem: false });
});

test('squirrelPlan: 평소 실행·첫 실행(--squirrel-firstrun)·맥은 null', () => {
  for (const arg of [undefined, '', '--squirrel-firstrun', '--squirrel-installx', '.', '--hidden']) {
    assert.equal(squirrelPlan({ platform: 'win32', argv: [EXE, arg], execPath: EXE }), null, String(arg));
  }
  assert.equal(squirrelPlan({ platform: 'darwin', argv: ['/A/Shisa', '--squirrel-install'], execPath: '/A/Shisa' }), null);
  assert.equal(squirrelPlan({ platform: 'win32', argv: [EXE, '--squirrel-install'], execPath: '' }), null);
  // 개발 실행(electron.exe . --squirrel-install)은 argv[1] 이 앱 폴더라 안 걸린다
  assert.equal(squirrelPlan({ platform: 'win32', argv: ['electron.exe', '.', '--squirrel-install'], execPath: 'electron.exe' }), null);
});

test('loginItemTarget: 윈도우 설치본만 Update.exe --processStart, 그 밖엔 기본값', () => {
  // name 을 박아 둬야 앱 ID 를 정하기 전(Squirrel 제거 실행)에도 같은 Run 값을 지운다
  assert.deepEqual(loginItemTarget({ platform: 'win32', packaged: true, execPath: EXE }), { path: UPDATE, args: ['--processStart', '"Shisa.exe"'], name: 'com.squirrel.Shisa.Shisa' });
  assert.equal(appUserModelId(EXE), 'com.squirrel.Shisa.Shisa');
  assert.deepEqual(loginItemTarget({ platform: 'win32', packaged: true, execPath: EXE, exists: () => false }), {});
  assert.deepEqual(loginItemTarget({ platform: 'win32', packaged: false, execPath: EXE }), {});
  assert.deepEqual(loginItemTarget({ platform: 'darwin', packaged: true, execPath: '/Applications/시사.app/Contents/MacOS/시사' }), {});
});

test('handleSquirrel: Update.exe 만 띄우고 끝나면 종료(창·데몬 없음), 제거면 로그인 항목도 끈다', () => {
  const mk = () => {
    const log = { quit: 0, login: [], spawn: [], timers: [] }, child = { on(ev, f) { (child[ev] ??= []).push(f); } };
    const deps = {
      app: { quit: () => log.quit++, setLoginItemSettings: (o) => log.login.push(o) }, loginTarget: () => ({ path: 'U' }), console,
      spawn: (...a) => { log.spawn.push(a); return child; }, setTimeout: (f, ms) => log.timers.push([f, ms]),
    };
    return { log, child, run: (plan) => buildHandler(decl('handleSquirrel'), deps)(plan) };
  };
  const m = mk();
  m.run({ run: ['Update.exe', ['--createShortcut=Shisa.exe']], removeLoginItem: true });
  assert.deepEqual(m.log.spawn, [['Update.exe', ['--createShortcut=Shisa.exe'], { detached: true, stdio: 'ignore', windowsHide: true }]]);
  assert.deepEqual(m.log.login, [{ openAtLogin: false, path: 'U' }], '같은 Run 값을 지운다');
  assert.equal(m.log.quit, 0);
  m.child.close[0]();
  m.log.timers[0][0](); // 안 끝나도 10초 뒤 한 번만
  assert.equal(m.log.timers[0][1], 10_000);
  assert.equal(m.log.quit, 1);
  const none = mk();
  none.run({ run: null });
  assert.deepEqual([none.log.quit, none.log.spawn.length], [1, 0]);
});

test('applyLoginItem: 로그인 항목은 loginTarget 과 같은 자리로 읽고 쓴다, 이미 같으면 쓰지 않는다', () => {
  const mk = (current, want) => {
    const log = { get: [], set: [] };
    const app = { getLoginItemSettings: (o) => { log.get.push(o); return { openAtLogin: current }; }, setLoginItemSettings: (o) => log.set.push(o) };
    buildHandler(decl('applyLoginItem'), { loginPlan: () => ({ manage: true, openAtLogin: want }), app, loginTarget: () => ({ path: 'U', args: ['a'] }), console })();
    return log;
  };
  const on = mk(false, true);
  assert.deepEqual(on.get, [{ path: 'U', args: ['a'] }]);
  assert.deepEqual(on.set, [{ openAtLogin: true, path: 'U', args: ['a'] }]);
  assert.deepEqual(mk(true, true).set, []);
});

test('main.js 시작 순서: Squirrel 갈림길이 단일 실행 잠금보다 먼저, 앱 ID 는 그 갈림길보다 먼저', () => {
  // 맨 아래 시작 코드는 import 하면 앱이 떠서 실행해 볼 수 없어 소스 순서로 본다
  const main = mainSource;
  assert.match(main, /const SQUIRREL = squirrelPlan\(\{ platform: process\.platform, argv: process\.argv, execPath: process\.execPath \}\);/);
  assert.match(main, /if \(SQUIRREL\) \{\s*handleSquirrel\(SQUIRREL\);\s*\} else if \(!app\.requestSingleInstanceLock\(\)\) \{/);
  assert.ok(main.indexOf('const SQUIRREL') < main.indexOf('requestSingleInstanceLock'));
  const aumid = main.indexOf('app.setAppUserModelId(appUserModelId(process.execPath))');
  assert.ok(aumid > 0 && aumid < main.indexOf('if (SQUIRREL) {'));
});

test('onSessionEnd: 윈도우 로그오프·종료에도 집중 기록을 짧게 멈추고 데몬을 끈다', async () => {
  const mk = (focus) => {
    const log = { posts: [], stops: 0 };
    const daemonHost = { pid: 1, stop: async () => log.stops++ };
    const post = async (...a) => { log.posts.push(a); };
    // 이 함수가 대입하는 변수(quitting·daemonStopping·focusStopped)는 가짜 의존물 쪽 let 으로 받는다
    const src = `let quitting = false, daemonStopping = false, focusStopped = false;\nreturn (${decl('onSessionEnd')});`;
    const f = new Function('lastFocus', 'connected', 'daemonHost', 'post', src)(focus, true, daemonHost, post);
    return { log, f };
  };
  const a = mk({ active: true });
  a.f();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.log.posts, [['/focus/stop', {}, 800]]);
  assert.equal(a.log.stops, 1);
  const b = mk({ active: false });
  b.f();
  assert.deepEqual(b.log.posts, []);
  assert.equal(b.log.stops, 1);
  assert.match(mainSource, /if \(process\.platform === 'win32'\) win\?\.on\('session-end', onSessionEnd\);/); // 연결은 시작 코드 안
});

test('드래그: 윈도우는 크기까지 setBounds, 그 밖엔 setPosition', () => {
  const run = (platform) => {
    const log = { bounds: [], pos: [] };
    let tick;
    const win = { getPosition: () => [100, 100], setBounds: (b) => log.bounds.push(b), setPosition: (...a) => log.pos.push(a) };
    const deps = {
      screen: { getCursorScreenPoint: () => ({ x: 110, y: 130 }) }, process: { platform }, SIZE: { width: 50, height: 60 },
      setInterval: (f) => { tick = f; return 1; },
    };
    // drag 는 핸들러가 대입하므로 같은 let 으로 감싸 준다
    const src = `let drag = null, dragEpoch = 0;\nreturn (${ipcHandlers().get('drag-start')});`;
    new Function('win', 'screen', 'process', 'SIZE', 'Date', 'setInterval', 'endDrag', src)(win, deps.screen, deps.process, deps.SIZE, Date, deps.setInterval, () => {})();
    tick();
    return log;
  };
  assert.deepEqual(run('win32'), { bounds: [{ x: 100, y: 100, width: 50, height: 60 }], pos: [] });
  assert.deepEqual(run('darwin'), { bounds: [], pos: [[100, 100]] });
});
