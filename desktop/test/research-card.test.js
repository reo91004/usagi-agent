import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationText, shapeDashboard, shapeGpu, shapeResearch, shortGpuName, shortProc } from '../src/dashboard.js';

const NOW = Date.parse('2026-10-17T03:00:00Z');
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();

test('shapeResearch: 연구 연결이 없으면 null, 작업 줄은 상태 칩·시간 글·물어볼 글', () => {
  assert.equal(shapeResearch(undefined, NOW), null);
  assert.equal(shapeDashboard({}, NOW).research, null);
  const r = shapeResearch({
    hosts: ['pacl-208', 3],
    jobs: [
      { id: 'job:a', name: '학습', host: 'pacl-208', state: 'running', start: NOW / 1000 - 3 * 3600 - 120, at: ago(0.1), cwd: '/w', cmd: 'python t.py' },
      { id: 'job:b', name: '평가', host: 'pacl-208', state: 'done', seconds: 5400, code: 0, at: ago(2), files: ['a.json', 'b.csv', 'c', 'd'] },
      { id: 'job:c', name: 'ablation', state: 'failed', seconds: 60, code: 137, at: ago(1) },
      { id: 'job:d', name: '죽음', state: 'lost', at: ago(3) },
      { id: 'job:e', name: '이상한 상태', state: 'weird', at: ago(1) },
      { name: 'id 없음', state: 'done' },
    ],
    note: { day: '2026-10-17', exists: true, yesterday: { day: '2026-10-16', lines: ['a', 2], next: ['b'] } },
  }, NOW);
  assert.deepEqual(r.hosts, ['pacl-208']);
  assert.deepEqual(r.jobs.map((j) => [j.label, j.chip, j.time]), [
    ['도는 중', 'warn', '3시간 2분째'],
    ['끝', 'ok', '2시간 전 · 1시간 30분'],
    ['실패', 'err', '1시간 전 · 1분 · 종료 코드 137'],
    ['끊김', 'err', '끝 기록 없이 사라짐'],
  ]);
  assert.equal(r.jobs[0].detail, '/w · python t.py');
  assert.deepEqual(r.jobs[1].files, ['a.json', 'b.csv', 'c']);
  assert.equal(r.jobs[0].ask, "'학습' @pacl-208 실험 지금 어디까지 왔어? 로그 끝부분 봐 줘.");
  assert.equal(r.jobs[2].ask, "'ablation' 실험 결과 정리해 줘.");
  assert.deepEqual(r.note, { day: '2026-10-17', exists: true, yesterday: { day: '2026-10-16', lines: ['a'], next: ['b'] } });
});

test('durationText', () => {
  assert.equal(durationText(5), '5초');
  assert.equal(durationText(600), '10분');
  assert.equal(durationText(3600), '1시간');
  assert.equal(durationText(5400), '1시간 30분');
});

test('shapeGpu: 짧은 이름·사용률·GB, 그 GPU 의 프로세스만, 실패한 서버는 이유', () => {
  assert.equal(shortGpuName('NVIDIA GeForce RTX 4090'), 'RTX 4090');
  assert.equal(shortGpuName('NVIDIA RTX PRO 6000 Blackwell Server Edition'), 'RTX PRO 6000 Blackwell');
  assert.deepEqual(shortProc('user 01:02:03 /home/u/venv/bin/python -u train.py --lr 3e-4'), { etime: '01:02:03', cmd: 'python -u train.py --lr 3e-4' });
  const g = shapeGpu([
    { host: 'pacl-205', ok: true, gpus: [{ idx: '0', name: 'NVIDIA GeForce RTX 4090', util: 92, memUsed: 21749, memTotal: 24564, temp: 74 }, { idx: '1', name: 'NVIDIA GeForce RTX 4090', util: 0, memUsed: 15, memTotal: 24564, temp: 40 }],
      procs: [{ gpu: '0', pid: '1', mem: 21726, who: 'user 16:50:23 /x/python -u run.py' }] },
    { host: 'pacl-ugrp', ok: false, error: '접속하지 못했어요: timeout', gpus: [], procs: [] },
  ]);
  assert.deepEqual(g[0].gpus[0], { idx: '0', name: 'RTX 4090', util: 92, mem: '21.2/24.0 GB', memPct: 89, temp: 74, procs: [{ pid: '1', mem: '21.2 GB', etime: '16:50:23', cmd: 'python -u run.py' }] });
  assert.deepEqual(g[0].gpus[1].procs, []);
  assert.deepEqual([g[1].ok, g[1].error], [false, '접속하지 못했어요: timeout']);
});

test('shapeDirectives: Slack 연결 전 null, 사람 id 검사, 지시 줄(DM·채널, 안전한 링크만)', async () => {
  const { shapeDirectives } = await import('../src/dashboard.js');
  assert.equal(shapeDirectives(undefined, NOW), null);
  const d = shapeDirectives({
    from: [{ id: 'UPROF', name: '김교수' }, { id: 'bad' }],
    candidates: [{ id: 'UFRIEND', name: '친구', count: 3 }],
    open: [
      { id: 'message:D1:1.1', authorName: '김교수', isDM: true, text: '그림 3\n고쳐 주세요', at: ago(1), permalink: 'https://lab.slack.com/archives/D1/p11' },
      { id: 'message:C1:2.1', authorName: '김교수', isDM: false, channelLabel: 'lab', text: '결과 공유', at: ago(2), permalink: 'javascript:alert(1)' },
      { id: 'x', text: 'id 이상' },
    ],
  }, NOW);
  assert.deepEqual(d.from, [{ id: 'UPROF', name: '김교수' }]);
  assert.deepEqual(d.candidates, [{ id: 'UFRIEND', name: '친구', count: 3 }]);
  assert.deepEqual(d.open.map((x) => [x.where, x.text, x.rel, x.link]), [['DM', '그림 3 고쳐 주세요', '1시간 전', 'https://lab.slack.com/archives/D1/p11'], ['#lab', '결과 공유', '2시간 전', null]]);
});
