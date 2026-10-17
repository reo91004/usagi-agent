// 설치·모델 탭에서 고른 AI → 시사 데몬 설정(brain·models.general)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonBrainPatch, withDaemonBrain, settingsBrainBody, withOrder, priorityList, publicView, withoutProvider, normalizeSisa } from '../src/sisa-store.js';

const KEY = 'k'.repeat(20);

test('daemonBrainPatch: 고른 AI 를 데몬 뇌 이름으로, 키는 그 AI 것만', () => {
  assert.deepEqual(daemonBrainPatch({ provider: 'gemini', keys: { gemini: KEY, openai: `${KEY}o` }, chatModels: { gemini: 'gemini-2.5-pro' } }),
    { brain: { provider: 'gemini', geminiApiKey: KEY, fallback: [{ provider: 'openai' }], openaiApiKey: `${KEY}o` }, general: 'gemini-2.5-pro' });
  assert.deepEqual(daemonBrainPatch({ provider: 'openai', keys: { openai: KEY } }), { brain: { provider: 'openai', openaiApiKey: KEY, fallback: null }, general: null });
  assert.deepEqual(daemonBrainPatch({ provider: 'claudecode', clis: { claudecode: true }, chatModels: { claudecode: 'default' } }), { brain: { provider: 'claude-code', fallback: null }, general: null });
  assert.deepEqual(daemonBrainPatch({ provider: 'codexcli', clis: { codexcli: true } }), { brain: { provider: 'codex', fallback: null }, general: undefined });
  assert.deepEqual(daemonBrainPatch({ provider: 'none' }), { brain: { provider: 'local', fallback: null }, general: undefined });
});

test('daemonBrainPatch: Claude API 키도 데몬 뇌(anthropic)로 — 모든 대화가 데몬 한 길. 연결 안 된 AI 는 null', () => {
  assert.deepEqual(daemonBrainPatch({ provider: 'claude', keys: { claude: KEY }, chatModels: { claude: 'claude-haiku-5-5' } }), { brain: { provider: 'anthropic', anthropicApiKey: KEY, fallback: null }, general: 'claude-haiku-5-5' });
  assert.equal(daemonBrainPatch({ provider: 'gemini', keys: {} }), null);
  assert.equal(daemonBrainPatch({}), null);
});

test('withDaemonBrain: 다른 칸·다른 키는 그대로, 기본 모델이면 models.general 을 비운다', () => {
  const cfg = { repoRoots: ['/x'], brain: { provider: 'claude-code', openaiApiKey: 'old' }, models: { general: 'claude-x', code: 'c' } };
  assert.deepEqual(withDaemonBrain(cfg, { brain: { provider: 'gemini', geminiApiKey: KEY }, general: 'gemini-2.5-flash' }),
    { repoRoots: ['/x'], brain: { provider: 'gemini', openaiApiKey: 'old', geminiApiKey: KEY }, models: { general: 'gemini-2.5-flash', code: 'c' } });
  assert.deepEqual(withDaemonBrain(cfg, { brain: { provider: 'claude-code' }, general: null }).models, { code: 'c' });
  assert.deepEqual(withDaemonBrain({ models: { general: 'x' } }, { brain: { provider: 'openai' }, general: null }), { brain: { provider: 'openai' } });
  assert.deepEqual(withDaemonBrain(cfg, { brain: { provider: 'local' }, general: undefined }).models, cfg.models, 'undefined 면 모델은 손대지 않는다');
  assert.deepEqual(cfg.models, { general: 'claude-x', code: 'c' }, '원본은 그대로');
});

test('settingsBrainBody: PUT /settings 본문(키는 keys 로, 모델 기본값은 null) — 데몬이 바로 반영', () => {
  assert.deepEqual(settingsBrainBody(daemonBrainPatch({ provider: 'gemini', keys: { gemini: KEY }, chatModels: { gemini: 'gemini-2.5-pro' } })),
    { brain: { provider: 'gemini', fallback: [], keys: { gemini: KEY }, model: 'gemini-2.5-pro' } });
  assert.deepEqual(settingsBrainBody(daemonBrainPatch({ provider: 'claude', keys: { claude: KEY } })), { brain: { provider: 'anthropic', fallback: [], keys: { anthropic: KEY }, model: null } });
  assert.deepEqual(settingsBrainBody(daemonBrainPatch({ provider: 'codexcli', clis: { codexcli: true } })), { brain: { provider: 'codex', fallback: [] } });
  assert.deepEqual(settingsBrainBody(daemonBrainPatch({ provider: 'none' })), { brain: { provider: 'local', fallback: [] } });
  assert.equal(settingsBrainBody(null), null);
});

test('우선순위: 맨 앞이 지금 쓰는 AI, 나머지는 저장한 순서. 연결 안 된 AI·중복은 거절, 연결 해제하면 순서에서 빠진다', () => {
  const d = { provider: 'gemini', keys: { gemini: KEY, openai: `${KEY}o` }, clis: { codexcli: true }, chatModels: { gemini: 'gemini-2.5-pro', openai: 'gpt-5.4-mini', codexcli: 'x' } };
  assert.deepEqual(priorityList(d), ['gemini', 'openai', 'codexcli']);
  assert.equal(withOrder(d, ['claude']), null);
  assert.equal(withOrder(d, ['openai', 'openai']), null);
  const o = withOrder(d, ['codexcli', 'gemini']);
  assert.equal(o.provider, 'codexcli');
  assert.deepEqual(publicView(o).order, ['codexcli', 'gemini', 'openai']);
  // 데몬엔 첫 AI + 이어 받을 순서(모델은 AI 마다, codex 는 모델 없이) + 연결한 키 전부
  assert.deepEqual(daemonBrainPatch(o), {
    brain: { provider: 'codex', geminiApiKey: KEY, openaiApiKey: `${KEY}o`, fallback: [{ provider: 'gemini', model: 'gemini-2.5-pro' }, { provider: 'openai', model: 'gpt-5.4-mini' }] },
    general: undefined,
  });
  assert.deepEqual(settingsBrainBody(daemonBrainPatch(o)).brain.keys, { gemini: KEY, openai: `${KEY}o` });
  const file = withDaemonBrain({ brain: { provider: 'gemini', fallback: [{ provider: 'codex' }] } }, daemonBrainPatch(withoutProvider(withoutProvider(o, 'gemini'), 'openai')));
  assert.equal(file.brain.fallback, undefined, '남은 AI 가 하나면 데몬의 옛 순서를 지운다');
  assert.deepEqual(normalizeSisa(withoutProvider(o, 'gemini')).order, ['codexcli', 'openai']);
});
