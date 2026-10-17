import { test } from "node:test";
import assert from "node:assert/strict";
import { Focus, focusApi, focusDoneText, focusDuration, localDay, dayStart, splitByDay, RESUME_GAP_MS } from "./focus.ts";
import { Bus } from "./bus.ts";
import { Store } from "./store.ts";

// 로컬 시각(시간대와 무관하게 테스트가 맞도록 Date 생성자로)
const at = (d: number, h: number, m = 0, s = 0) => new Date(2026, 9, d, h, m, s).getTime();
function setup(start = at(14, 9)) {
  let t = start;
  const store = new Store(":memory:");
  const f = new Focus(store, { now: () => t });
  return { store, f, set: (v: number) => { t = v; }, add: (ms: number) => { t += ms; } };
}

test("로컬 날짜: localDay·dayStart, 틀린 날짜는 NaN", () => {
  assert.equal(localDay(at(14, 23, 59, 59)), "2026-10-14");
  assert.equal(localDay(at(15, 0)), "2026-10-15");
  assert.equal(dayStart("2026-10-14"), at(14, 0));
  assert.ok(Number.isNaN(dayStart("2026-02-30")));
  assert.ok(Number.isNaN(dayStart("26-1-1")));
});

test("splitByDay: 자정을 넘긴 구간은 날마다 나뉜다", () => {
  const m = splitByDay([{ start: at(14, 23, 30), end: at(15, 0, 45) }]);
  assert.equal(m.get("2026-10-14"), 30 * 60e3);
  assert.equal(m.get("2026-10-15"), 45 * 60e3);
});

test("시작 → 일시정지 → 다시 시작 → 그만: 일시정지 시간은 빠진다", () => {
  const s = setup();
  const changes: unknown[] = [];
  const stops: number[] = [];
  s.f.onChange = (v) => changes.push(v);
  s.f.onStop = (sec) => stops.push(sec);
  let v = s.f.start();
  assert.ok(v.active && !v.active.paused);
  assert.equal(s.f.start().active!.id, v.active!.id); // 두 번 눌러도 같은 세션
  s.add(10 * 60e3);
  v = s.f.pause();
  assert.equal(v.active!.paused, true);
  assert.equal(v.active!.seconds, 600);
  assert.equal(v.active!.since, null);
  s.add(30 * 60e3); // 쉬는 30분
  assert.equal(s.f.view().active!.seconds, 600);
  assert.equal(s.f.view().today, 600);
  s.f.resume();
  s.add(5 * 60e3);
  const live = s.f.view();
  assert.equal(live.active!.seconds, 900);
  assert.equal(live.today, 900); // 집중 중인 것도 오늘에 친다
  const r = s.f.stop();
  assert.equal(r.active, null);
  assert.equal(r.stopped!.seconds, 900);
  assert.deepEqual(stops, [900]);
  assert.equal(r.today, 900);
  assert.equal(s.f.stop().stopped, null); // 없으면 아무 일 없음
  assert.equal(changes.length, 4); // start · pause · resume · stop (같은 걸 다시 누른 건 안 침)
  const row = s.store.db.prepare("SELECT * FROM focus_sessions").get() as any;
  assert.equal(row.seconds, 900);
  assert.equal(row.ended, at(14, 9, 45));
});

test("가장 길게 이어서 집중한 시간: 일시정지로 끊긴 구간 중 가장 긴 것", () => {
  const s = setup(at(14, 9));
  s.f.start(); s.add(10 * 60e3); s.f.pause(); s.add(5 * 60e3); // 10분 집중, 5분 쉼
  s.f.resume(); s.add(25 * 60e3); s.f.pause(); s.f.resume(); s.add(5 * 60e3); s.f.stop(); // 25분 + 5분
  const d = s.f.stats("2026-10-14", "2026-10-14")!.days[0];
  assert.equal(d.seconds, 40 * 60);
  assert.equal(d.longest, 25 * 60);
});

test("일별 합계: 여러 세션 · 자정 넘김 · 범위 밖은 0", () => {
  const s = setup(at(13, 22));
  s.f.start(); s.add(3600e3); s.f.stop(); // 13일 1시간
  s.set(at(14, 23, 40)); s.f.start(); s.set(at(15, 0, 20)); s.f.stop(); // 14일 20분 + 15일 20분
  s.set(at(15, 9)); s.f.start(); s.add(15 * 60e3); s.f.stop(); // 15일 15분
  const st = s.f.stats("2026-10-12", "2026-10-16")!;
  assert.deepEqual(st.days, [
    { date: "2026-10-12", seconds: 0, longest: 0 },
    { date: "2026-10-13", seconds: 3600, longest: 3600 },
    { date: "2026-10-14", seconds: 1200, longest: 1200 },
    { date: "2026-10-15", seconds: 2100, longest: 1200 },
    { date: "2026-10-16", seconds: 0, longest: 0 },
  ]);
  assert.equal(st.total, 6900);
  assert.equal(s.f.stats("2026-10-15", "2026-10-14"), undefined);
  assert.equal(s.f.stats("2026-13-01", "2026-13-02"), undefined);
});

test("0초 세션(바로 그만)은 남기지 않는다", () => {
  const s = setup();
  s.f.start();
  assert.equal(s.f.stop().stopped!.seconds, 0);
  assert.equal((s.store.db.prepare("SELECT COUNT(*) AS n FROM focus_sessions").get() as any).n, 0);
});

test("앱이 꺼졌다 켜짐: 금방이면 이어 가고(꺼진 동안은 빼고), 오래면 마지막 저장 시각에 끝낸다", () => {
  const s = setup();
  s.f.start();
  for (let i = 0; i < 40; i++) { s.add(30e3); s.f.checkpoint(); } // 타이머처럼 30초마다 저장, 20분까지
  s.add(60e3); // 저장 안 된 1분 뒤 꺼짐
  // 금방 다시 켜짐
  s.add(60e3);
  let t = at(14, 9, 22);
  const f2 = new Focus(s.store, { now: () => t });
  let v = f2.view();
  assert.ok(v.active && !v.active.paused);
  assert.equal(v.active.seconds, 1200);
  t += 2.5 * 60e3;
  f2.checkpoint(); // 타이머처럼 간격(RESUME_GAP_MS) 안에서 저장 — 아니면 잠자기로 본다
  t += 2.5 * 60e3;
  assert.equal(f2.view().active!.seconds, 1500);
  f2.checkpoint();
  // 이번엔 오래 꺼져 있다 켜짐
  t += RESUME_GAP_MS + 3600e3;
  const f3 = new Focus(s.store, { now: () => t });
  v = f3.view();
  assert.equal(v.active, null);
  assert.equal(v.today, 1500);
  const row = s.store.db.prepare("SELECT * FROM focus_sessions").get() as any;
  assert.equal(row.seconds, 1500);
});

test("일시정지 중 오래 꺼졌어도 집중한 시간은 그대로", () => {
  const s = setup();
  s.f.start(); s.add(10 * 60e3); s.f.pause(); s.add(60e3);
  const f2 = new Focus(s.store, { now: () => at(14, 18) });
  assert.equal(f2.view().active, null);
  assert.equal(f2.stats("2026-10-14", "2026-10-14")!.total, 600);
});

test("마무리 말·시간 글", () => {
  assert.equal(focusDuration(42), "42초");
  assert.equal(focusDuration(25 * 60 + 3), "25분");
  assert.equal(focusDuration(3600), "1시간");
  assert.equal(focusDuration(4320), "1시간 12분");
  assert.equal(focusDoneText(1500), "25분 집중했어요. 수고했어요!");
  assert.equal(focusDoneText(30), "30초 집중했어요. 수고했어요!");
});

test("bus: GET /focus · /focus/stats · POST /focus/:cmd (헤더 필수) · SSE focus", async () => {
  const s = setup();
  const bus = new Bus();
  s.f.onChange = (v) => bus.focusChanged(v);
  await bus.listen(0, {
    approve: async () => {}, hold: async () => {}, briefing: async () => {}, dashboard: async () => ({}),
    todoDone: () => true, chat: () => "c1", focus: focusApi(s.f),
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (p: string, headers: Record<string, string> = { "x-cy-agent": "1" }) => fetch(`${base}${p}`, { method: "POST", headers });
  try {
    assert.equal((await post("/focus/start", {})).status, 403);
    assert.equal((await post("/focus/nope")).status, 404);
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = "";
    while (!buf.includes("event: focus")) buf += new TextDecoder().decode((await reader.read()).value);
    const r = await post("/focus/start");
    assert.equal(r.status, 200);
    assert.ok((await r.json()).active);
    while (!buf.includes('"paused":false')) buf += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    s.add(90e3);
    const v = await (await fetch(`${base}/focus`)).json();
    assert.equal(v.active.seconds, 90);
    const stop = await (await post("/focus/stop")).json();
    assert.equal(stop.stopped.seconds, 90);
    const st = await (await fetch(`${base}/focus/stats?from=2026-10-14&to=2026-10-14`)).json();
    assert.deepEqual(st.days, [{ date: "2026-10-14", seconds: 90, longest: 90 }]);
    assert.equal((await fetch(`${base}/focus/stats?from=2026-10-14`)).status, 400);
    assert.equal((await fetch(`${base}/focus/stats?from=2026-10-15&to=2026-10-14`)).status, 400);
  } finally {
    bus.close();
  }
});

test("잠자기: 지난 checkpoint 에서 RESUME_GAP_MS 넘게 지났으면 잠든 시간은 빼고 지금부터 새 구간", () => {
  const s = setup(at(14, 23));
  s.f.start();
  s.add(30e3); s.f.checkpoint();
  s.add(8 * 3600e3); s.f.checkpoint(); // 8시간 잠들었다 깸
  assert.equal(s.f.view().active!.seconds, 30);
  s.add(10e3);
  const r = s.f.stop();
  assert.equal(r.stopped!.seconds, 40);
  assert.equal(s.f.stats("2026-10-14", "2026-10-15")!.total, 40);
  // 타이머가 돌고 있으면 checkpoint 없이 깨자마자 그만해도 같다
  const s2 = setup(at(14, 10));
  s2.f.startTimer(3600e3);
  s2.f.start();
  s2.add(20e3); s2.f.checkpoint();
  s2.add(RESUME_GAP_MS + 1);
  assert.equal(s2.f.stop().stopped!.seconds, 20);
  s2.f.stopTimer();
  // 간격 안이면 그대로 이어진다
  const s3 = setup(at(14, 10));
  s3.f.start();
  s3.add(RESUME_GAP_MS - 1); s3.f.checkpoint();
  assert.equal(s3.f.view().active!.seconds, Math.floor((RESUME_GAP_MS - 1) / 1000));
});

test("그만할 때 초는 오늘 합계처럼 버림(1초 차이 없음)", () => {
  const s = setup(at(14, 10));
  s.f.start();
  s.add(10_700);
  const r = s.f.stop();
  assert.equal(r.stopped!.seconds, 10);
  assert.equal(r.today, 10);
});

test("통계 범위: 3660일 넘으면 undefined(→ 400)", () => {
  const s = setup();
  assert.equal(s.f.stats("1000-01-01", "9999-12-31"), undefined);
  assert.ok(s.f.stats("2016-01-01", "2026-01-01"));
});
