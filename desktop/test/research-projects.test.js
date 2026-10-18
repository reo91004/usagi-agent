import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { shapeDashboard, SECTIONS } from '../src/dashboard.js';
import { shapeResearchProjects, cleanTitle, deadlineChip, venuesUsed, subsBody, withCurrent, withNextVenue, rulesChip } from '../src/research-projects.js';
import { ipcHandlers, buildHandler } from './helpers/main-calls.js';

const NOW = new Date(2026, 9, 18, 12, 0).getTime();
const ymd = (d) => { const x = new Date(NOW + d * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

test('탭 6개(+설치): 연구 다음에 작업 폴더', () => {
  assert.deepEqual(SECTIONS, ['overview', 'todos', 'chat', 'research', 'projects', 'setup', 'settings']);
});

test('deadlineChip: D-day 글자, 21일 이하 warn, 7일 이하 err, 지난 마감은 D+n, 끝난 단계는 없음', () => {
  assert.deepEqual(deadlineChip(ymd(38), 'submitted', NOW), { text: 'D-38', tone: '' });
  assert.deepEqual(deadlineChip(ymd(22), 'prep', NOW), { text: 'D-22', tone: '' });
  assert.deepEqual(deadlineChip(ymd(21), 'prep', NOW), { text: 'D-21', tone: 'warn' });
  assert.deepEqual(deadlineChip(ymd(8), 'prep', NOW), { text: 'D-8', tone: 'warn' });
  assert.deepEqual(deadlineChip(ymd(7), 'prep', NOW), { text: 'D-7', tone: 'err' });
  assert.deepEqual(deadlineChip(ymd(0), 'prep', NOW), { text: 'D-day', tone: 'err' });
  assert.deepEqual(deadlineChip(ymd(-3), 'review', NOW), { text: 'D+3', tone: '' });
  assert.equal(deadlineChip(ymd(5), 'rejected', NOW), null);
  assert.equal(deadlineChip('', 'prep', NOW), null);
});

const raw = [
  { key: '/a', kind: 'research', name: 'poly', folders: [{ path: '/a' }, { path: '/b' }], url: 'javascript:x',
    subs: [{ venue: 'CHES 2026', stage: 'rejected', at: 'x' }, { venue: 'CHES 2027', stage: 'submitted', deadline: ymd(38), at: 'y' }],
    lastActive: new Date(NOW - 7200e3).toISOString(), running: [{ name: 't', host: 'h', kind: 'tmux', running: true, start: NOW / 1000 - 600 }, { name: 'claude', host: 'h', kind: 'tmux', ai: 'claude', cwd: '/w/dp', running: true, start: NOW / 1000 - 8 * 86400 }],
    recent: { done: 3, failed: 1, lost: 0, items: [{ name: 'e', host: 'h', kind: 'job', start: NOW / 1000 - 5000, seconds: 60, code: 1, running: false }] },
    sessions: [{ title: '# Files mentioned by the user: ## - docs/a.md', tool: 'claude', at: new Date(NOW - 3600e3).toISOString() }] },
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
  assert.equal(r.cur.tone, 'accent');
  assert.equal(r.line2, '실험 1개 도는 중 · Claude 작업 중 · 최근: docs/a.md');
  assert.deepEqual([r.experiments.length, r.ais.length, r.ais[0].time, r.ais[0].folder], [1, 1, '8일째', 'dp']);
  assert.equal(r.subs.at(-1).tone, 'accent');
  assert.equal(r.url, '');
  assert.equal(r.lastRel, '2시간 전');
  assert.deepEqual(r.recent.items.map((e) => e.state), ['failed']);
  assert.equal(r.experiments[0].time, '10분째');
  assert.deepEqual([p.name, p.subs.length, p.line2], ['/p', 0, '최근 30일 활동 없음']);
  assert.equal(shapeResearchProjects([{ key: '/n', kind: 'research' }], NOW)[0].chip, '학회 미정');
  assert.equal(cleanTitle('> * # '), '(제목 없음)');
  assert.equal(cleanTitle('- docs/x.md'), 'docs/x.md');
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

test('IPC agent-rules: 보낸 창 확인 · 모양 거르기 · 상태는 GET, 넣기는 POST · preload 연결', async () => {
  const src = ipcHandlers().get('agent-rules');
  assert.match(src, /fromOurs\(e\)/);
  const sent = [];
  const fn = buildHandler(src, { fromOurs: () => true, denied: () => 'denied', request: async (...a) => { sent.push(a); return { ok: true }; } });
  assert.equal(await fn({}, '', false), 'denied');
  assert.equal(await fn({}, 5, false), 'denied');
  assert.equal(await fn({}, '/a', 'yes'), 'denied');
  await fn({}, 'srv:/a b', false);
  await fn({}, '/a', true);
  assert.deepEqual(sent, [['GET', '/research/projects/rules?path=srv%3A%2Fa%20b', undefined, 30000], ['POST', '/research/projects/rules', { path: '/a' }, 30000]]);
  let api;
  const electron = { contextBridge: { exposeInMainWorld: (_n, o) => { api = o; } }, ipcRenderer: { invoke: (...x) => x, on() {}, send() {}, removeListener() {} } };
  vm.runInNewContext(readFileSync(new URL('../preload-panel.cjs', import.meta.url), 'utf8'), { require: () => electron, process, console });
  assert.deepEqual(api.agentRules('/a', 1), ['agent-rules', '/a', true]);
});

test('rulesChip: AGENTS 에 있고 CLAUDE 가 규칙을 갖거나 가져올 때만 완료 칩', () => {
  assert.equal(rulesChip({ agents: 'added', claude: 'imports' }).text, 'AI 지시 ✓');
  assert.match(rulesChip({ agents: 'added', claude: 'imports' }).title, /@AGENTS\.md/);
  assert.match(rulesChip({ agents: 'added', claude: 'added' }).title, /CLAUDE\.md 에도/);
  for (const st of [null, {}, { agents: 'missing', claude: 'added' }, { agents: 'absent', claude: 'imports' }, { agents: 'added', claude: 'missing' }, { agents: 'added', claude: 'absent' }]) assert.equal(rulesChip(st), null, JSON.stringify(st));
});

test('IPC folder-open: 7일 활동이 없어도 연구 프로젝트의 폴더면 열 수 있다', async () => {
  const src = ipcHandlers().get('folder-open');
  const dash = { projects: [], researchProjects: [{ folders: [{ path: 'srv:/w/p' }] }] };
  const fn = buildHandler(src, {
    fromOurs: () => true, denied: () => 'denied', request: async () => ({ ok: true, data: dash }),
    splitHost: (p) => ({ host: 'srv', dir: p.slice(4) }), isDir: () => false, sshHosts: () => [], codeApp: () => null, shell: {}, process,
  });
  const listMiss = '목록에 없는 폴더예요';
  assert.equal((await fn({}, 'srv:/w/other', 'finder')).error, listMiss);
  assert.notEqual((await fn({}, 'srv:/w/p', 'finder')).error, listMiss);
});

test('연구 상세 save: 낙관적 값이 바로 raw 에 들어가고 실패하면 저장 전 raw 로 되돌린다', async () => {
  globalThis.document = { createElement: () => ({ setAttribute() {}, addEventListener() {}, append() {}, dataset: {} }) };
  const { createResearchProjects } = await import('../renderer/research-projects.js');
  let raw = { researchProjects: [{ key: '/a', kind: 'research', name: 'A', subs: [] }] };
  const first = raw, seen = [];
  const ctx = { getRaw: () => raw, setRaw: (r) => { raw = r; seen.push(r); }, render() {}, loadSoon() {}, why: () => 'x', cy: { researchProjectSave: async () => ({ ok: false }) } };
  const rp = createResearchProjects(ctx);
  await rp.save('/a', { name: 'B' });
  assert.equal(seen[0].researchProjects[0].name, 'B');
  assert.equal(raw, first);
});
