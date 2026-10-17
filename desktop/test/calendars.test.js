import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calendarUrls, withCalendarAdded, withCalendarRemoved, calendarKind, maskCalendarUrl, calendarRows, calendarUrlById, okCalendarId,
  hubDoneFor, calendarRemoveCopy, calendarReloadNote, CALENDAR_DUP,
} from '../src/calendars.js';
import { withConnectorOff } from '../src/disconnect.js';
import { setupSettings } from '../src/settings-window.js';
import { ipcHandlers, buildHandler, decl } from './helpers/main-calls.js';
import { denied } from '../src/denied.js';

const G1 = 'https://calendar.google.com/calendar/ical/chaewon.kim%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics';
const G2 = 'https://calendar.google.com/calendar/ical/abcdef123456%40group.calendar.google.com/private-fedcba9876543210/basic.ics';
const O1 = 'https://outlook.office365.com/owa/calendar/1a2b3c4d5e6f@example.com/9f8e7d6c5b4a3210/calendar.ics';
const hash = (u) => `h${u.length}${u.slice(-12, -8)}`;

test('캘린더 더하기: 덮어쓰지 않고 더한다, 개수 상한 없음, 다른 칸은 그대로', () => {
  let cfg = { character: 'sisa', connectors: { slack: { mode: 'off' } } };
  for (const u of [G1, G2, O1]) {
    const r = withCalendarAdded(cfg, u);
    assert.equal(r.added, true);
    cfg = r.cfg;
  }
  assert.deepEqual(cfg.connectors.calendar, { icsUrls: [G1, G2, O1], mode: 'api', timeZone: 'Asia/Seoul' });
  assert.equal(cfg.character, 'sisa');
  assert.deepEqual(cfg.connectors.slack, { mode: 'off' });
  // 상한 없음: 50개도 그대로 더한다
  for (let i = 0; i < 50; i++) cfg = withCalendarAdded(cfg, `https://x.example/c${i}.ics`).cfg;
  assert.equal(calendarUrls(cfg).length, 53);
  // 예전 모양(icsUrl 하나)에 더해도 그 주소는 남는다
  const old = withCalendarAdded({ connectors: { calendar: { mode: 'api', icsUrl: G1, timeZone: 'UTC' } } }, G2).cfg;
  assert.deepEqual(calendarUrls(old), [G1, G2]);
  assert.equal(old.connectors.calendar.timeZone, 'UTC');
  // 연결 해제(off) 뒤에 다시 붙이면 api 로
  assert.equal(withCalendarAdded(withConnectorOff({}, 'calendar'), G1).cfg.connectors.calendar.mode, 'api');
});

test('같은 주소는 한 번만: icsUrl·icsUrls 어디에 있든, 앞뒤 빈칸이 있어도', () => {
  const cfg = { connectors: { calendar: { mode: 'api', icsUrl: G1, icsUrls: [G2] } } };
  for (const u of [G1, G2, ` ${G2} `]) {
    const r = withCalendarAdded(cfg, u);
    assert.equal(r.added, false);
    assert.equal(r.cfg, cfg, '그대로');
  }
  assert.equal(withCalendarAdded(cfg, '').added, false);
  assert.match(CALENDAR_DUP, /이미 연결된 캘린더예요/);
  // 설정 파일에 같은 주소가 두 번 들어 있어도 목록엔 한 번
  assert.deepEqual(calendarUrls({ connectors: { calendar: { icsUrl: G1, icsUrls: [G1, '', 3, G2] } } }), [G1, G2]);
});

test('하나 빼기: 그 주소만 지우고 나머지·다른 설정은 그대로, icsUrl 에 있던 것도', () => {
  const cfg = { brain: { provider: 'local' }, connectors: { calendar: { mode: 'api', icsUrl: G1, icsUrls: [G2, O1], timeZone: 'Asia/Seoul', email: 'me@example.com' }, slack: { mode: 'off' } } };
  const a = withCalendarRemoved(cfg, G2);
  assert.deepEqual(a.connectors.calendar, { mode: 'api', icsUrls: [G1, O1], timeZone: 'Asia/Seoul', email: 'me@example.com' });
  assert.deepEqual(a.brain, cfg.brain);
  assert.deepEqual(a.connectors.slack, { mode: 'off' });
  const b = withCalendarRemoved(cfg, G1);
  assert.deepEqual(calendarUrls(b), [G2, O1]);
  assert.equal('icsUrl' in b.connectors.calendar, false);
  // 없는 주소면 목록은 그대로
  assert.deepEqual(calendarUrls(withCalendarRemoved(cfg, 'https://nope.example/a.ics')), [G1, G2, O1]);
  assert.deepEqual(cfg.connectors.calendar.icsUrls, [G2, O1], '원래 객체는 안 바뀐다');
});

test('다 빼기: 마지막 하나를 빼면 [연결 해제]와 같은 상태(mode off, 주소 없음)', () => {
  let cfg = { connectors: { calendar: { mode: 'api', icsUrls: [G1, O1] } } };
  cfg = withCalendarRemoved(cfg, G1);
  cfg = withCalendarRemoved(cfg, O1);
  assert.deepEqual(cfg, withConnectorOff({ connectors: { calendar: { mode: 'api', icsUrls: [G1, O1] } } }, 'calendar'));
  assert.deepEqual(cfg.connectors.calendar, { mode: 'off' });
  assert.deepEqual(calendarUrls(cfg), []);
});

test('가림 표시: 비밀 토큰은 안 보이고, 캘린더 id 앞부분·도메인만', () => {
  assert.equal(maskCalendarUrl(G1), 'chae…@gmail.com');
  assert.equal(maskCalendarUrl(G2), 'abcd…@group.calendar.google.com');
  assert.equal(maskCalendarUrl(O1), '1a2b…@example.com');
  assert.equal(maskCalendarUrl('https://calendar.google.com/calendar/ical/ab%40gmail.com/private-xyz/basic.ics'), 'a…@gmail.com', '짧은 이름은 절반만');
  assert.equal(maskCalendarUrl('https://cal.example.com/feeds/secret-token-123.ics?key=abc'), 'cal.example.com', '모르는 모양은 호스트만');
  assert.equal(maskCalendarUrl('not a url'), '알 수 없는 주소');
  for (const u of [G1, G2, O1]) {
    const shown = maskCalendarUrl(u);
    for (const secret of ['private-', '0123456789abcdef', 'fedcba9876543210', '9f8e7d6c5b4a3210', 'kim', '123456', '5e6f']) assert.ok(!shown.includes(secret), `${shown} 에 ${secret}`);
  }
  assert.equal(calendarKind(G1), 'gcal');
  assert.equal(calendarKind(O1), 'outlook');
  assert.equal(calendarKind('https://outlook.live.com/owa/calendar/x@outlook.com/y/calendar.ics'), 'outlook');
  assert.equal(calendarKind('https://cal.example.com/a.ics'), 'ics');
});

test('화면 줄: 주소 대신 id·종류·가린 이름, id 로 주소를 다시 찾는다', () => {
  const cfg = { connectors: { calendar: { mode: 'api', icsUrls: [G1, O1] } } };
  const rows = calendarRows(cfg, hash);
  assert.deepEqual(rows, [
    { id: hash(G1), kind: 'gcal', title: '구글 캘린더', label: 'chae…@gmail.com' },
    { id: hash(O1), kind: 'outlook', title: 'Outlook 캘린더', label: '1a2b…@example.com' },
  ]);
  assert.ok(!JSON.stringify(rows).includes('private-'), '주소는 싣지 않는다');
  assert.equal(calendarUrlById(cfg, hash(O1), hash), O1);
  assert.equal(calendarUrlById(cfg, 'nope', hash), null);
  assert.equal(calendarUrlById(cfg, undefined, hash), null);
  assert.equal(okCalendarId('0123456789abcdef'), true);
  for (const bad of ['', '0123', 'G123456789abcdef', '0123456789abcdef0', null, 1]) assert.equal(okCalendarId(bad), false);
});

test('설치 표시(done): 남은 주소에 구글이 없으면 gcal 을, Outlook 이 없으면 outlook 을 뗀다', () => {
  const done = { gcal: true, outlook: true, slack: true };
  assert.deepEqual(hubDoneFor(done, [G1, O1]), done);
  assert.deepEqual(hubDoneFor(done, [O1]), { outlook: true, slack: true });
  assert.deepEqual(hubDoneFor(done, [G2]), { gcal: true, slack: true });
  assert.deepEqual(hubDoneFor(done, []), { slack: true });
});

test('[빼기] 문구·반영 안내', () => {
  const row = { title: '구글 캘린더', label: 'chae…@gmail.com' };
  assert.equal(calendarRemoveCopy(row, false).ask, '구글 캘린더 「chae…@gmail.com」를 뺄까요?');
  assert.match(calendarRemoveCopy(row, false).note, /이 주소만/);
  assert.match(calendarRemoveCopy(row, true).note, /마지막 주소라서 빼면 주소로 읽는 캘린더는 꺼져요. 이 Mac 캘린더를 연결해 두었으면 그건 그대로예요/);
  assert.equal(calendarRemoveCopy(row, true).label, '빼기');
  for (const c of [calendarRemoveCopy(row, false), calendarRemoveCopy(row, true)]) assert.ok(!Object.values(c).join('').includes('—'), 'em dash 없음');
  assert.equal(calendarReloadNote({ changed: true, restarting: true }, false), '잠깐 다시 켜지며 적용돼요.');
  assert.equal(calendarReloadNote({ changed: true, restarting: false }, false), '다시 켜면 적용돼요.');
  assert.equal(calendarReloadNote(null, true), '지금 꺼져 있어서 다음에 켤 때 적용돼요.');
  assert.equal(calendarReloadNote({ changed: false, restarting: false }, false), '');
});

test('캘린더 IPC: 목록·빼기는 패널에서만(main 의 공용 채널)', async () => {
  const h = ipcHandlers(), removed = [];
  const deps = { denied, fromPanel: (e) => e.panel, okCalendarId, calendarList: () => ['row'], removeCalendar: async (id) => { removed.push(id); return { ok: true }; } };
  const run = (ch, e, ...a) => buildHandler(h.get(ch), deps)(e, ...a);
  assert.deepEqual(run('calendar-list', { panel: false }), denied());
  assert.deepEqual(run('calendar-list', { panel: true }), { ok: true, items: ['row'] });
  assert.deepEqual(await run('calendar-remove', { panel: false }, 'a1b2c3d4e5f60718'), denied());
  assert.deepEqual(await run('calendar-remove', { panel: true }, '../x'), denied());
  assert.deepEqual(removed, []);
  await run('calendar-remove', { panel: true }, 'a1b2c3d4e5f60718');
  assert.deepEqual(removed, ['a1b2c3d4e5f60718']);
});

// removeCalendar: 가짜 config·데몬으로 — 어떤 주소가 지워지고 데몬이 다시 읽는지
async function removeRun({ cfg, connected = true }) {
  const log = { edits: [], posts: [], saved: [], disconnected: [] };
  const calendarId = hash;
  const readDaemonConfig = () => cfg;
  const deps = {
    connected, readDaemonConfig, calendarId, calendarUrlById, calendarUrls, calendarList: () => calendarRows(cfg, calendarId), hubDoneFor, calendarReloadNote,
    withCalendarRemoved, normalizeSisa: (x) => x ?? { done: {} }, readSisa: () => ({ done: { gcal: true } }), writeSisa: (d) => log.saved.push(d), sisaPublic: (d) => d, sendPanel() {}, who: () => '시사',
    editDaemonConfig: (fn) => { const next = fn(cfg); log.edits.push(next); return next; },
    post: async (...a) => { log.posts.push(a); return { ok: true, data: { changed: true, restarting: true } }; },
    disconnectConnector: async (cap) => { log.disconnected.push(cap); return { ok: true, cap }; },
  };
  const id = (u) => hash(u);
  return { log, run: (url) => buildHandler(decl('removeCalendar'), deps)(id(url)) };
}

test('removeCalendar: 그 주소만 config 에서 빼고 데몬이 다시 읽게 한다, 마지막 하나면 연결 해제', async () => {
  const two = { connectors: { calendar: { mode: 'api', icsUrls: [G1, G2] } } };
  const a = await removeRun({ cfg: two });
  const r = await a.run(G1);
  assert.deepEqual(a.log.edits[0].connectors.calendar.icsUrls, [G2]);
  assert.deepEqual(a.log.posts, [['/connectors/reload']]);
  assert.equal(r.ok, true);
  assert.equal(r.note, '잠깐 다시 켜지며 적용돼요.');
  // 꺼진 데몬: 다시 읽기를 부르지 않는다
  const off = await removeRun({ cfg: two, connected: false });
  await off.run(G1);
  assert.deepEqual(off.log.posts, []);
  // 모르는 id
  const none = await removeRun({ cfg: two });
  assert.equal((await none.run('https://x.example/none.ics')).ok, false);
  assert.deepEqual(none.log.edits, []);
  // 마지막 하나: 커넥터 전체 해제
  const one = await removeRun({ cfg: { connectors: { calendar: { mode: 'api', icsUrls: [G1] } } } });
  await one.run(G1);
  assert.deepEqual(one.log.disconnected, ['calendar']);
  assert.deepEqual(one.log.edits, []);
  // 이 Mac 캘린더를 같이 쓰면 마지막 주소를 빼도 그건 남는다
  const local = await removeRun({ cfg: { connectors: { calendar: { mode: 'api', local: true, icsUrls: [G1] } } } });
  await local.run(G1);
  assert.equal(local.log.edits[0].connectors.calendar.local, true);
  assert.deepEqual(local.log.disconnected, []);
});

test('sisa-mark: 이미 있는 캘린더 주소면 duplicate 로 알리고 데몬은 다시 읽지 않는다', async () => {
  const posts = [];
  const mk = (wrote) => buildHandler(ipcHandlers().get('sisa-mark'), {
    denied, fromOurs: () => true, HUB_IDS: new Set(['gcal', 'outlook', 'slack']), slotOk: () => true, CALENDAR_DUP: 'dup!', connected: true, console,
    normalizeSisa: () => ({ done: {} }), readSisa: () => ({}), writeSisa() {}, writeConnector: () => wrote,
    post: async (...a) => { posts.push(a); return { ok: true, data: { changed: false } }; },
  });
  assert.deepEqual(await mk('dup')({}, 'gcal', G1), { ok: false, duplicate: true, error: 'dup!', done: { gcal: true } });
  assert.deepEqual(posts, []);
  assert.equal((await mk(true)({}, 'gcal', G1)).ok, true);
  assert.deepEqual(posts, [['/connectors/reload']]);
});

test('화면 연결: 패널 설치 탭·설정 창·프리로드·main 이 캘린더 더하기·목록·빼기를 부른다', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const panel = read('../renderer/panel.js');
  assert.match(panel, /cy\.calendarRemove\(id\)/);
  assert.match(panel, /cy\.calendarList/);
  assert.match(panel, /mark\?\.duplicate/);
  const view = read('../renderer/setup-view.js');
  assert.match(view, /구글 캘린더 하나 더 추가/);
  assert.match(view, /Outlook 캘린더 하나 더 추가/);
  assert.match(view, /onConfirm: \(\) => onRemove\(c\.id\)/);
  const settings = read('../renderer/settings.js');
  assert.match(settings, /cy\.removeCalendar\(c\.id\)/);
  assert.match(settings, /캘린더 하나 더 추가/);
  assert.match(read('../preload-panel.cjs'), /calendarRemove: .*'calendar-remove'/);
  assert.match(read('../preload-panel.cjs'), /removeCalendar: .*'calendar-remove'/);
});

// 아주 작은 가짜 DOM(설치 화면 그리기·누르기만)
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.disabled = false; }
  append(...n) { for (const c of n) { if (c == null) continue; if (typeof c === 'string') { const t = new Node('#text'); t.textContent = c; this.children.push(t); continue; } c.parent = this; this.children.push(c); } }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  fire(t, e = {}) { for (const f of this.listeners[t] ?? []) f({ preventDefault() {}, stopPropagation() {}, target: this, ...e }); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byClass(c) { return this.all((n) => n.className.split(' ').includes(c)); }
  querySelector() { return null; }
  get text() { return [this.textContent, ...this.children.map((c) => c.text)].join(''); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('설치 탭 「더 연결할까요?」: 연결된 캘린더 목록(가린 이름) · 하나 더 추가 · 하나 빼기', async () => {
  globalThis.document = { createElement: (t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; }, title: '' };
  const { renderSetup, readSlot, clearSlot } = await import('../renderer/setup-view.js');
  const root = new Node('div');
  const added = [], removed = [];
  const calendars = calendarRows({ connectors: { calendar: { icsUrls: [G1, O1] } } }, hash);
  const state = {
    phase: 'extras', done: { gcal: true, outlook: true }, repos: [], calendars,
    onAddCalendar: (id) => added.push(id),
    onRemoveCalendar: async (id) => { removed.push(id); return { ok: true }; },
  };
  renderSetup(root, state);
  const box = root.byClass('setup-cals')[0];
  assert.ok(box, '캘린더 칸');
  assert.match(box.text, /연결된 캘린더 · 2개/);
  assert.match(box.text, /chae…@gmail\.com/);
  assert.match(box.text, /1a2b…@example\.com/);
  assert.ok(!root.text.includes('private-'), '주소는 화면에 없다');
  const btn = (label) => box.all((n) => n.tagName === 'BUTTON' && n.text === label)[0];
  btn('구글 캘린더 하나 더 추가').fire('click');
  btn('Outlook 캘린더 하나 더 추가').fire('click');
  assert.deepEqual(added, ['gcal', 'outlook']);
  // 빼기: 그 자리에서 한 번 더 묻고, 누르면 그 id 만
  const li = box.all((n) => n.dataset.id === hash(O1))[0];
  li.byClass('dc-open')[0].fire('click');
  assert.match(li.text, /Outlook 캘린더 「1a2b…@example\.com」를 뺄까요\?/);
  assert.match(li.text, /이 주소만/);
  li.byClass('dc-yes')[0].fire('click');
  await tick();
  assert.deepEqual(removed, [hash(O1)]);
  assert.match(li.text, /캘린더를 뺐어요/);
  // 하나만 남으면 「마지막」 안내, 하나도 없으면 칸이 없다
  renderSetup(root, { ...state, calendars: calendars.slice(0, 1) });
  const one = root.byClass('setup-cals')[0];
  one.byClass('dc-open')[0].fire('click');
  assert.match(one.text, /마지막 주소라서/);
  renderSetup(root, { ...state, calendars: [] });
  assert.equal(root.byClass('setup-cals').length, 0);

  // 주소 칸: 이미 연결된 주소로 막히면 알리고 다음(완료)을 끈다. 칸을 고치면 풀린다
  const connect = { phase: 'connect', link: 'gcal', cursor: 2, slotError: { id: 'gcal', value: G1, text: CALENDAR_DUP } };
  renderSetup(root, connect);
  const input = root.all((n) => n.attrs['data-slot'] === 'gcal')[0];
  input.value = G1;
  input.fire('input');
  assert.equal(readSlot('gcal'), G1);
  assert.match(root.text, /이미 연결된 캘린더예요/);
  const done = () => root.all((n) => n.tagName === 'BUTTON' && n.text === '완료')[0];
  assert.equal(done().attrs.disabled, '');
  const in2 = root.all((n) => n.attrs['data-slot'] === 'gcal')[0];
  in2.value = G2;
  in2.fire('input');
  assert.ok(!root.text.includes('이미 연결된 캘린더예요'));
  assert.equal(done().attrs.disabled, undefined);
  clearSlot('gcal');
  assert.equal(readSlot('gcal'), '');
  delete globalThis.document;
});

test('설치 탭 이 Mac 캘린더·미리알림: 앱 업데이트로 허락이 풀리면 「연결됨」 대신 [다시 허락하기], 누르면 풀린 것만 다시 묻는다', async () => {
  globalThis.document = { createElement: (t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; }, title: '' };
  const { renderSetup } = await import('../renderer/setup-view.js');
  const asked = [];
  const base = { phase: 'extras', done: {}, repos: [], calendars: [], onAppleConnect: (o) => asked.push(o), onAppleDisconnect: () => {}, onOpenPrivacy: () => {} };
  const root = new Node('div');
  renderSetup(root, { ...base, apple: { available: true, calendar: 'notDetermined', reminders: 'granted', connected: { calendar: true, reminders: true } } });
  const box = root.byClass('setup-apple')[0];
  assert.match(box.text, /미리알림 연결됨/);
  assert.doesNotMatch(box.text, /캘린더·미리알림 연결됨/);
  assert.match(box.text, /허락이 풀렸어요/);
  box.all((n) => n.tagName === 'BUTTON' && n.text === '다시 허락하기')[0].fire('click');
  assert.deepEqual(asked, [{ calendar: true, reminders: false }]);
  assert.equal(box.all((n) => n.tagName === 'BUTTON' && n.text === '캘린더 빼기').length, 1, '연결해 둔 것은 뺄 수도 있다');
  renderSetup(root, { ...base, apple: { available: true, calendar: 'granted', reminders: 'granted', connected: { calendar: true, reminders: true } } });
  const ok = root.byClass('setup-apple')[0];
  assert.match(ok.text, /캘린더·미리알림 연결됨/);
  assert.equal(ok.all((n) => n.tagName === 'BUTTON' && n.text === '다시 허락하기').length, 0);
  delete globalThis.document;
});
