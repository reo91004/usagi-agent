import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AI_PROVIDERS, HUB, SISA_SAY,
  connectSteps, cannedReply, slotCheck, slotOk, DEFAULT_PERSONA, SLACK_MANIFEST,
} from '../src/ai-onboard.js';
import { checkLlm } from '../src/llm-check.js';

const all = (steps) => JSON.stringify(steps);

test('AI 공급자는 넷이고, 슬랙은 쿠키를 쓰지 않는다', () => {
  assert.deepEqual(AI_PROVIDERS.map((p) => p.id), ['gemini', 'claude', 'openai', 'genspark']);
  assert.equal(/xoxc/.test(DEFAULT_PERSONA), false);
  assert.match(DEFAULT_PERSONA, /스이시~사/);
  // Slack: 어떤 뇌든 읽기 전용 앱의 사용자 토큰(xoxp-)을 붙인다. 쿠키·봇 토큰은 받지 않는다
  for (const agent of ['claude', 'codex', 'agy', null]) {
    const slack = all(connectSteps('slack', agent));
    assert.equal(/xoxc|xoxd|SLACK_MCP/.test(slack), false);
    assert.deepEqual(connectSteps('slack', agent).map((s) => s.id), ['slack-app', 'slack-token']);
  }
  const tok = (kind) => [kind, '1234567890', '1234567890', 'abcdefabcdef'].join('-'); // 비밀값 검사에 걸리지 않게 조각으로
  assert.equal(slotOk('slack', tok('xoxp')), true);
  for (const bad of [tok('xoxb'), tok('xoxc'), 'xoxp-짧음', 'xoxp-123 456']) assert.equal(slotOk('slack', bad), false, bad);
  // 마법사의 매니페스트는 ops/slack-readonly-manifest.yaml 과 같아야 한다(주석 줄만 빼고)
  const yaml = readFileSync(new URL('../../ops/slack-readonly-manifest.yaml', import.meta.url), 'utf8');
  assert.equal(SLACK_MANIFEST, `${yaml.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim()}\n`);
  assert.doesNotMatch(SLACK_MANIFEST, /chat:write|:write\b/, '쓰기 스코프 없음');
  assert.ok(HUB.find((h) => h.id === 'slack'));
});

test('Gemini 안내는 무료 키 주소와 만들기 버튼을 알려 준다', () => {
  const gemini = AI_PROVIDERS.find((p) => p.id === 'gemini');
  assert.equal(gemini.url, 'https://aistudio.google.com/apikey');
  const text = all(gemini.rows);
  assert.equal(gemini.rows[0].link, true);
  assert.match(text, /Create API key/);
  assert.match(text, /AIza/);
  assert.match(gemini.blurb, /무료/);
});

test('GPT 안내는 챗지피티 계정으로 키가 안 된다고 말한다', () => {
  const gpt = AI_PROVIDERS.find((p) => p.id === 'openai');
  assert.match(gpt.note, /챗지피티/);
  assert.match(all(gpt.rows), /5달러/);
});

test('AI가 없으면 정해진 말만 한다', () => {
  for (let i = 0; i < 8; i += 1) {
    assert.match(cannedReply('today', { open: 2, done: 1, next: '빨래' }), /1개|2개|3개/);
    assert.match(cannedReply('today', { open: 0, done: 0 }), /할 일|조용|비어|쉬어/);
  }
  assert.match(cannedReply('tired'), /\S/);
  assert.match(cannedReply('done'), /수고|잘|대단|고생|해냈|멋|승리/);
});

test('캘린더 주소는 모양이 맞아야 통과한다', () => {
  const good = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123/basic.ics';
  assert.equal(slotCheck('gcal', good).ok, true);
  assert.equal(slotCheck('gcal', 'https://calendar.google.com/calendar/embed?src=me').ok, false);
  assert.equal(slotCheck('gcal', '').ok, false);
  assert.equal(slotCheck('outlook', 'https://outlook.office365.com/owa/calendar/a/b/calendar.ics').ok, true);
  assert.equal(slotCheck('outlook', 'https://outlook.office365.com/owa/calendar/a/b/calendar.html').ok, false);
  assert.equal(slotCheck('whatever', 'x').ok, true);
});

test('시사 말풍선은 설치 화면이 읽는 자리에 모두 있다', () => {
  assert.deepEqual(Object.keys(SISA_SAY), ['name', 'brain', 'extras', 'done']);
  for (const k of Object.keys(SISA_SAY)) {
    assert.equal(typeof SISA_SAY[k], 'string', k);
    assert.match(SISA_SAY[k], /\n/, `${k}: 문장마다 줄을 바꾼다`);
    assert.match(SISA_SAY[k], /\*\*[^*]+\*\*/, `${k}: 핵심은 굵게`);
  }
});

test('구글·아웃룩 안내는 주소를 칸에 받고, 쿠키는 묻지 않는다', () => {
  for (const id of ['gcal', 'outlook']) {
    const steps = connectSteps(id);
    assert.equal(steps.at(-1).slots[0].id, id);
    assert.ok(steps.at(-1).slotNote);
    assert.equal(/쿠키|xoxc/.test(all(steps)), false);
  }
});

test('키 확인은 상태 코드만 본다', async () => {
  const ok = await checkLlm('openai', 'sk-test', async () => ({ ok: true, text: async () => '{"data":[]}' }));
  assert.equal(ok.ok, true);
  const bad = await checkLlm('openai', 'sk-secret', async () => ({ ok: false, text: async () => 'invalid sk-secret' }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.includes('sk-secret'), false);
});

test('키 만들기 첫 단계에 주소 열기·복사가 바로 붙는다', () => {
  for (const p of AI_PROVIDERS) {
    const first = p.rows[0];
    assert.equal(first.link, true, p.id);
    assert.equal(first.note, undefined, p.id);
    assert.doesNotMatch(first.text, /주소 열기|주소 복사/, p.id);
    assert.equal(p.rows.filter((r) => r?.link === true).length, 1, p.id);
    assert.match(p.url, /^https:\/\//, p.id);
  }
});

test('구글·Outlook 캘린더 첫 단계에도 주소 열기가 바로 붙는다', () => {
  for (const id of ['gcal', 'outlook']) {
    const first = connectSteps(id, null)[0];
    assert.match(first.url, /^https:\/\//, id);
    assert.equal(first.rows[0].link, true, id);
    assert.equal(first.rows.filter((r) => r?.link === true).length, 1, id);
    assert.doesNotMatch(first.rows[0].text, /주소 열기/, id);
    assert.equal(first.code, undefined, `${id}: 붙여 넣는 상자는 없다`);
  }
});

test('구글 캘린더 비공개 주소는 왼쪽 이름 누른 뒤 맨 아래에 있다', () => {
  const copy = connectSteps('gcal', null).find((s) => s.id === 'gcal-copy');
  const text = JSON.stringify(copy.rows);
  assert.match(text, /내 캘린더의 설정/);
  assert.match(text, /맨 아래/);
  assert.match(text, /캘린더 통합/);
  assert.match(text, /iCal 형식의 비공개 주소/);
});

test('Gemini 키 안내는 AIza 로만 시작한다고 하지 않는다', () => {
  const g = AI_PROVIDERS.find((p) => p.id === 'gemini');
  assert.match(JSON.stringify(g.rows), /AQ\./);
  assert.equal(g.keyHint, '');
});

test('뇌 고르기: AI 없이 쓰기가 다른 뇌와 같은 카드로 있고, 안내 말은 AI 가 선택이라고 한다', async () => {
  const { BRAIN_CHOICES } = await import('../src/ai-onboard.js');
  const none = BRAIN_CHOICES.find((c) => c.id === 'none');
  assert.ok(none, 'AI 없이 쓰기 카드');
  assert.equal(none.local, true);
  assert.equal(none.title, 'AI 없이 쓰기');
  for (const w of [/할 일/, /오늘 할 일 표/, /회의 알림/, /인사/, /나중에 설정/]) assert.match(none.blurb, w);
  assert.equal(BRAIN_CHOICES.filter((c) => c.local).length, 1);
  assert.doesNotMatch(SISA_SAY.brain, /필요해요/);
  assert.match(SISA_SAY.brain, /AI 없이도/);
  for (const c of BRAIN_CHOICES) assert.doesNotMatch(`${c.title} ${c.blurb}`, /—/);
  assert.doesNotMatch(SISA_SAY.brain, /—/);
});

test('작업 기록 읽기 동의 문구: 무엇을 읽는지·끌 수 있는지 밝히고, 긴 줄표를 쓰지 않는다', async () => {
  const { SESSIONS_CONSENT, hubItem, SISA_SAY } = await import('../src/ai-onboard.js');
  assert.match(SESSIONS_CONSENT.title, /Claude Code·Codex 작업 기록/);
  assert.match(SESSIONS_CONSENT.blurb, /~\/\.claude\/projects/);
  assert.match(SESSIONS_CONSENT.warn, /켜지 않으면 읽지 않고/);
  assert.match(hubItem('repos').blurb, /적은 폴더만 읽고/);
  assert.match(SISA_SAY.extras, /아무것도 읽지 않아요/);
  for (const t of [SESSIONS_CONSENT.title, SESSIONS_CONSENT.blurb, SESSIONS_CONSENT.warn, hubItem('repos').blurb, SISA_SAY.extras]) assert.doesNotMatch(t, /—/);
});

test('마법사: 작업 기록 체크박스는 저장된 값(처음엔 꺼짐)으로 그리고, 다 했어요·건너뛰기는 마침을 데몬에 알린다', async () => {
  const { readFileSync } = await import('node:fs');
  const view = readFileSync(new URL('../renderer/setup-view.js', import.meta.url), 'utf8');
  assert.match(view, /sessionsConsent\(readSessions, onToggleSessions\)/);
  assert.match(view, /cb\.checked = !!on/);
  const panel = readFileSync(new URL('../renderer/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /let setupReadSessions = false/);
  assert.match(panel, /onFinishExtras: async \(\) => \{\n\s+await saveSetupSettings\(\{ onboarded: true \}\)/);
  assert.match(panel, /onSkipSetup: async \(\) => \{\n\s+await saveSetupSettings\(\{ onboarded: true \}\)/);
  assert.match(panel, /saveSetupSettings\(\{ readSessions: !!on \}\)/);
});
