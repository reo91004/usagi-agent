// 앱 안에 든 데몬을 자식 프로세스로 띄우고 지킨다. 프로세스·시계·확인은 주입받는다(시험은 가짜로).
// 이미 그 포트에 데몬이 있으면 띄우지 않고 다시 본다(그 데몬이 사라지면 그때 띄운다). 처음 FAST_FOR_MS 동안은 FAST_MS 마다,
// 그 뒤로는 WATCH_MS 마다 — 앱을 껐다 바로 켜면 꺼지는 중인 옛 데몬이 아직 답하므로, 1분씩 비지 않게.
// 죽으면 restartDelay 간격으로 다시 띄우고, stop() 은 SIGTERM → 기다려도 안 꺼지면 SIGKILL.
// 데몬이 포트를 못 잡아 EXIT_PORT_TAKEN 으로 끝나면 충돌로 세지 않고 그 포트를 다시 지켜본다.
import { restartDelay, nextFailures, EXIT_PORT_TAKEN } from './bundle.js';

export const WATCH_MS = 60_000; // 남의 데몬이 살아 있나 다시 보는 간격
export const FAST_MS = 2000; // 지켜보기 시작 직후의 간격
export const FAST_FOR_MS = 60_000; // 이만큼 동안은 FAST_MS 마다
export const OTHER_MS = 300_000; // 다른 프로그램이 포트를 쥐고 있으면 이 간격으로만 다시 본다(띄우지 않는다)
export const STOPPING_MS = 1000; // 그 데몬이 "꺼지는 중"이라고 답하면
export const KILL_AFTER_MS = 4000; // SIGTERM 뒤 이만큼 기다려도 안 꺼지면 SIGKILL

// deps: { spawn() → child(on('exit'), kill(sig), pid) · probe() → Promise<true|false|'stopping'|'other'> · now() · setTimeout · clearTimeout · log?(msg) · onSpawn?(child) }
export function createDaemonHost(deps) {
  const log = deps.log ?? (() => {});
  // watchSince: 지켜보기(external·port-taken)를 시작한 때. 지켜보던 데몬이 사라지거나 우리 데몬이 제대로 뜨고 죽으면 비운다
  const st = { mode: 'idle', child: null, failures: 0, startedAt: 0, timer: null, stopping: false, restarts: 0, watchSince: null };

  const clear = () => { if (st.timer) { deps.clearTimeout(st.timer); st.timer = null; } };
  const later = (ms, fn) => { clear(); st.timer = deps.setTimeout(() => { st.timer = null; fn(); }, ms); };
  const watch = (mode, fast = FAST_MS) => {
    st.mode = mode;
    if (st.watchSince === null) st.watchSince = deps.now();
    later(deps.now() - st.watchSince < FAST_FOR_MS ? fast : WATCH_MS, check);
  };

  function launch() {
    if (st.stopping || st.child) return;
    let child;
    try {
      child = deps.spawn();
    } catch (e) {
      log(`데몬을 띄우지 못했어요: ${e?.message ?? e}`);
      st.failures = nextFailures(st.failures, 0);
      st.mode = 'waiting';
      later(restartDelay(st.failures), check);
      return;
    }
    st.child = child;
    st.mode = 'child';
    st.startedAt = deps.now();
    log(`데몬을 띄웠어요 (pid ${child.pid})`);
    deps.onSpawn?.(child);
    const gone = (code, signal) => {
      if (st.child !== child) return;
      st.child = null;
      if (st.stopping) { st.mode = 'stopped'; return; }
      const up = deps.now() - st.startedAt;
      if (code === EXIT_PORT_TAKEN) {
        // 포트를 누가 쓰고 있다(꺼지는 중인 옛 데몬·다른 프로그램): 충돌이 아니니 간격을 늘리지 않고 그 포트를 지켜본다
        if (st.watchSince === null) log('데몬이 포트를 잡지 못했어요(이미 누가 쓰는 중). 그 포트를 지켜보다 비면 다시 띄워요');
        watch('port-taken');
        return;
      }
      st.watchSince = null;
      st.failures = nextFailures(st.failures, up);
      const wait = restartDelay(st.failures);
      st.restarts += 1;
      st.mode = 'waiting';
      log(`데몬이 꺼졌어요 (${signal ?? `code ${code}`}, ${Math.round(up / 1000)}초 동안 켜짐). ${Math.round(wait / 1000)}초 뒤 다시 띄워요`);
      later(wait, check);
    };
    child.on('exit', gone);
    // 실행 파일을 못 찾는 등 띄우기 자체가 실패하면 exit 없이 error 만 온다
    child.on('error', (e) => { log(`데몬 프로세스 오류: ${e?.message ?? e}`); if (!child.pid) gone(null, null); });
  }

  // 띄우기 전에 그 포트를 본다: 누가 이미 떠 있으면 그쪽을 쓰고 지켜보기만
  async function check() {
    if (st.stopping || st.child) return;
    let alive = false;
    try { alive = await deps.probe(); } catch { alive = false; }
    if (st.stopping || st.child) return;
    if (alive === 'stopping') {
      // 꺼지는 중인 데몬(앱을 껐다 바로 켬): 곧 비니 자주 본다
      if (st.mode !== 'external') log('이 포트의 데몬이 꺼지는 중이에요. 꺼지면 바로 띄워요');
      watch('external', STOPPING_MS);
      return;
    }
    if (alive === 'other') {
      // 시사 데몬이 아닌 프로그램이 응답한다: 띄워 봐야 포트를 못 잡으니 spawn 없이 드물게 다시 본다
      if (st.mode !== 'occupied') log('이 포트를 다른 프로그램이 쓰고 있어요. 데몬을 띄우지 않고 5분마다 다시 봐요');
      st.mode = 'occupied';
      later(OTHER_MS, check);
      return;
    }
    if (alive) {
      if (st.mode !== 'external') log('이 포트에 이미 데몬이 떠 있어요. 그 데몬을 써요');
      watch('external');
      return;
    }
    // 지켜보던 데몬이 사라졌다 → 새로 띄운다(또 부딪히면 지켜보기를 처음부터 빠르게)
    if (st.mode === 'external' || st.mode === 'occupied') st.watchSince = null;
    launch();
  }

  function stop() {
    st.stopping = true;
    clear();
    const child = st.child;
    if (!child) { st.mode = 'stopped'; return Promise.resolve(); }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; deps.clearTimeout(kt); st.mode = 'stopped'; resolve(); };
      child.on('exit', finish);
      const kt = deps.setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 이미 꺼짐 */ } finish(); }, KILL_AFTER_MS);
      // 윈도우는 SIGTERM 이 곧 강제 종료라 데몬이 정리를 못 한다 — IPC 로 띄웠으면 "shutdown" 메시지를 먼저(안 되면 SIGTERM)
      let asked = false;
      try { if (child.connected && typeof child.send === 'function') { child.send('shutdown'); asked = true; } } catch { asked = false; }
      if (!asked) try { child.kill('SIGTERM'); } catch { finish(); }
    });
  }

  return {
    start: () => check(),
    stop,
    get mode() { return st.mode; },
    get pid() { return st.child?.pid ?? null; },
    get restarts() { return st.restarts; },
    get failures() { return st.failures; },
  };
}
