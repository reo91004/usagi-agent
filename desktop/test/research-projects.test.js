import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { shapeDashboard, SECTIONS } from '../src/dashboard.js';
import { shapeResearchProjects, deadlineChip, venuesUsed, subsBody, withCurrent, withNextVenue } from '../src/research-projects.js';
import { ipcHandlers, buildHandler } from './helpers/main-calls.js';

const NOW = new Date(2026, 9, 18, 12, 0).getTime();
const ymd = (d) => { const x = new Date(NOW + d * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

test('탭은 작업 폴더 없이 연구까지', () => {
  assert.deepEqual(SECTIONS, ['overview', 'todos', 'chat', 'research', 'setup', 'settings']);
});

test('deadlineChip: D-day 글자, 21일 이하 경고, 지난 마감은 D+n, 끝난 단계는 없음', () => {
  assert.deepEqual(deadlineChip(ymd(38), 'submitted', NOW), { text: 'D-38', warn: false });
  assert.deepEqual(deadlineChip(ymd(21), 'prep', NOW), { text: 'D-21', warn: true });
  assert.deepEqual(deadlineChip(ymd(0), 'prep', NOW), { text: 'D-day', warn: true });
  assert.deepEqual(deadlineChip(ymd(-3), 'review', NOW), { text: 'D+3', warn: false });
  assert.equal(deadlineChip(ymd(5), 'rejected', NOW), null);
  assert.equal(deadlineChip('', 'prep', NOW), null);
});

const raw = [
  { key: '/a', kind: 'research', name: 'poly', folders: [{ path: '/a' }, { path: '/b' }], url: 'javascript:x',
    subs: [{ venue: 'CHES 2026', stage: 'rejected', at: 'x' }, { venue: 'CHES 2027', stage: 'submitted', deadline: ymd(38), at: 'y' }],
    lastActive: new Date(NOW - 7200e3).toISOString(), running: [{ name: 't', host: 'h', kind: 'tmux', running: true, start: NOW / 1000 - 600 }],
    recent: { done: 3, failed: 1, lost: 0, items: [{ name: 'e', host: 'h', kind: 'job', start: NOW / 1000 - 5000, seconds: 60, code: 1, running: false }] },
    sessions: [{ title: '세션', tool: 'claude', at: new Date(NOW - 3600e3).toISOString() }] },
  { key: '/p', kind: 'project', name: '', subs: [{ venue: 'X', stage: 'prep' }], running: [], recent: { done: 2, failed: 1 } },
  { key: '/c', kind: null },
  { name: 'no key' },
];

test('shapeResearchProjects: 목록 줄은 마지막 제출만, 프로젝트는 학회 칸 없음, 위험 주소는 버림', () => {
  const list = shapeResearchProjects(raw, NOW);
  assert.equal(list.length, 3);
  const [r, p, c] = list;
  assert.equal(r.chip, 'CHES 2027 · 제출함');
  assert.equal(r.subs.length, 2);
  assert.equal(r.dday.text, 'D-38');
  assert.equal(r.summary, '실험 1 도는 중');
  assert.equal(r.url, '');
  assert.equal(r.lastRel, '2시간 전');
  assert.deepEqual(r.recent.items.map((e) => e.state), ['failed']);
  assert.equal(r.running[0].time, '10분째');
  assert.deepEqual([p.name, p.chip, p.subs.length, p.summary], ['/p', '', 0, '끝 2 · 실패 1']);
  assert.equal(c.kind, null);
});

test('제출 배열 도우미: 현재 편집·다음 학회 추가는 옛 제출을 남긴다', () => {
  const [r] = shapeResearchProjects(raw, NOW);
  assert.deepEqual(venuesUsed([r]), ['CHES 2026', 'CHES 2027']);
  assert.deepEqual(subsBody(withCurrent(r.subs, { stage: 'rejected', deadline: '' })).at(-1), { venue: 'CHES 2027', stage: 'rejected', at: 'y' });
  const next = subsBody(withNextVenue(r.subs, 'USENIX', '2027-02-01'));
  assert.equal(next.length, 3);
  assert.deepEqual(next[2], { venue: 'USENIX', stage: 'prep', deadline: '2027-02-01' });
  assert.deepEqual(next[0], { venue: 'CHES 2026', stage: 'rejected', at: 'x' });
});

test('shapeDashboard: researchProjects·묶인 폴더 표시·실험 label/project', () => {
  const d = shapeDashboard({ researchProjects: raw, projects: [{ name: 'a', path: '/a', hiddenByResearch: true }, { name: 'z', path: '/z' }],
    research: { hosts: ['h'], jobs: [{ id: 'j', name: 'cmd', label: 'train · exp7', project: '/a', state: 'done' }], tmux: { h: { sessions: [{ name: '0', label: 'x', project: '/a' }] } } } }, NOW);
  assert.equal(d.researchProjects.length, 3);
  assert.deepEqual(d.projects.map((p) => [p.path, p.byResearch]), [['/a', true], ['/z', false]]);
  assert.deepEqual([d.research.jobs[0].title, d.research.jobs[0].project], ['train · exp7', '/a']);
  assert.deepEqual([d.research.tmux[0].sessions[0].title, d.research.tmux[0].sessions[0].project], ['x', '/a']);
  assert.deepEqual(shapeDashboard({}, NOW).researchProjects, []);
});

test('IPC research-project-save: 보낸 창 확인 · 모양 거르기 · PUT /research/projects', async () => {
  const src = ipcHandlers().get('research-project-save');
  assert.match(src, /fromOurs\(e\)/);
  const sent = [];
  const fn = buildHandler(src, { fromOurs: () => true, denied: () => 'denied', request: async (...a) => { sent.push(a); return { ok: true }; } });
  assert.equal(await fn({}, null), 'denied');
  assert.equal(await fn({}, { key: '' }), 'denied');
  assert.equal(await fn({}, { key: 'k', kind: 'x' }), 'denied');
  assert.equal(await fn({}, { key: 'k', subs: [{ venue: 1, stage: 'prep' }] }), 'denied');
  assert.equal(await fn({}, { key: 'k', subs: new Array(21).fill({ venue: 'v', stage: 'prep' }) }), 'denied');
  await fn({}, { key: 'k', kind: 'research', name: null, extra: 1, subs: [{ venue: 'v', stage: 'prep', deadline: '', zzz: 1 }] });
  assert.deepEqual(sent, [['PUT', '/research/projects', { key: 'k', kind: 'research', name: null, subs: [{ venue: 'v', stage: 'prep' }] }]]);
  let api;
  const electron = { contextBridge: { exposeInMainWorld: (_n, o) => { api = o; } }, ipcRenderer: { invoke: (...x) => x, on() {}, send() {}, removeListener() {} } };
  vm.runInNewContext(readFileSync(new URL('../preload-panel.cjs', import.meta.url), 'utf8'), { require: () => electron, process, console });
  assert.deepEqual(api.researchProjectSave({ key: 'k' }), ['research-project-save', { key: 'k' }]);
});
