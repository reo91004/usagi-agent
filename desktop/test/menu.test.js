import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuTemplate } from '../src/menu.js';

const a = Object.fromEntries(['open', 'session', 'briefing', 'settings', 'tour', 'toggleBubbles', 'toggleTuck', 'toggleCharacter', 'quit'].map((k) => [k, () => k]));
const s = { name: '우사기', connected: true, brainLabel: 'Claude Code', coder: true, bubblesHidden: false };
const labels = (t) => t.map((i) => (i.type === 'separator' ? '-' : i.label));

test('항목과 순서', () => {
  assert.deepEqual(labels(menuTemplate(s, a)), [
    '우사기 켜짐 · Claude Code', '-', '패널 열기', '작업 세션 열기', '지금 브리핑', '-', '설정…', '사용법 다시 보기', '-', '말풍선 숨기기', '가장자리에 숨기', '캐릭터 숨기기', '-', '우사기 끄기',
  ]);
});

test('코더가 없으면 작업 세션 없음, 꺼짐이면 뇌 이름 없음', () => {
  const t = menuTemplate({ ...s, coder: false, connected: false }, a);
  assert.ok(!labels(t).includes('작업 세션 열기'));
  assert.equal(t[0].label, '우사기 꺼짐');
  assert.equal(t[0].enabled, false);
});

test('숨기기 셋은 체크 항목', () => {
  const t = menuTemplate({ ...s, bubblesHidden: true, tucked: true, characterHidden: false }, a);
  const item = (label) => t.find((i) => i.label === label);
  assert.deepEqual(['말풍선 숨기기', '가장자리에 숨기', '캐릭터 숨기기'].map((l) => [item(l).type, item(l).checked]), [['checkbox', true], ['checkbox', true], ['checkbox', false]]);
  assert.equal(item('가장자리에 숨기').click(), 'toggleTuck');
  assert.equal(item('캐릭터 숨기기').click(), 'toggleCharacter');
});

test('아이콘은 있는 것만 붙는다', () => {
  const t = menuTemplate(s, a, (n) => (n === 'gearshape' ? 'IMG' : undefined));
  assert.equal(t.find((i) => i.label === '설정…').icon, 'IMG');
  assert.ok(!('icon' in t.find((i) => i.label === '패널 열기')));
});
