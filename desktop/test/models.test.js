import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSisa, connectedProviders, activeProvider, publicView, withKey, withCli, withSkip, withModels, withVoice, isModelId,
} from '../src/sisa-store.js';
import { SISA_BASE } from '../src/persona.js';
import { CANNED_DEFAULTS } from '../src/canned.js';
import { optionsFor, codeOptions, cannedOverrideOf } from '../renderer/models-view.js';
import { pickModels, listModels, CLI_MODELS } from '../src/llm-check.js';

const KEY = 'AIzaSyExampleExampleExample';

test('예전 저장 모양(provider + apiKey)도 읽는다', () => {
  const d = normalizeSisa({ provider: 'gemini', apiKey: KEY, persona: 'p' });
  assert.deepEqual(connectedProviders(d), ['gemini']);
  assert.equal(publicView(d).hasKey, true);
});

test('AI를 여러 개 연결해 두고 하나를 채팅에 쓴다', () => {
  let d = withKey({}, 'gemini', KEY);
  d = withCli(d, 'claudecode');
  assert.deepEqual(connectedProviders(d), ['gemini', 'claudecode']);
  assert.equal(activeProvider(d), 'claudecode');
  const next = withModels(d, { chat: { provider: 'gemini', model: 'gemini-2.5-flash' } });
  assert.equal(publicView(next).provider, 'gemini');
  assert.equal(publicView(next).chatModels.gemini, 'gemini-2.5-flash');
});

test('연결 안 된 AI나 이상한 모델 이름은 거절한다', () => {
  const d = withKey({}, 'gemini', KEY);
  assert.equal(withModels(d, { chat: { provider: 'openai', model: 'gpt-4o' } }), null);
  assert.equal(withModels(d, { chat: { provider: 'gemini', model: 'x; rm -rf /' } }), null);
  assert.equal(withModels(d, { code: '--dangerous flag' }), null);
  assert.equal(isModelId('claude-opus-5-5'), true);
  assert.equal(isModelId('models/gemini-2.5-flash'), true);
});

test('안 쓰기로 하면 채팅 AI가 없다. 연결은 남는다', () => {
  const d = withSkip(withKey({}, 'claude', 'sk-ant-abcdefghij'));
  assert.equal(publicView(d).hasKey, false);
  assert.deepEqual(publicView(d).connected, ['claude']);
});

test('밖으로 나가는 값에는 키가 없다', () => {
  const view = JSON.stringify(publicView(withKey({}, 'gemini', KEY), '기본 말투'));
  assert.equal(view.includes(KEY), false);
  assert.match(view, /기본 말투/);
});

test('코딩 모델은 default 로 되돌릴 수 있다', () => {
  const d = withModels(withCli({}, 'claudecode'), { code: 'opus' });
  assert.equal(d.codeModel, 'opus');
  assert.equal(withModels(d, { code: 'default' }).codeModel, 'default');
});

test('Gemini·GPT 목록은 대화용만 추린다', () => {
  const g = pickModels('gemini', { models: [
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] },
  ] });
  assert.deepEqual(g.map((m) => m.id), ['gemini-2.5-flash']);
  const o = pickModels('openai', { data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o-audio-preview' }, { id: 'o3-mini' }, { id: 'whisper-1' }] });
  assert.deepEqual(o.map((m) => m.id).sort(), ['gpt-4o', 'o3-mini']);
  assert.deepEqual(pickModels('claude', { data: [{ id: 'claude-x', display_name: 'X' }] }), [{ id: 'claude-x', label: 'X' }]);
});

test('목록 요청은 키를 오류에 남기지 않는다', async () => {
  const ok = await listModels('gemini', KEY, async () => ({ ok: true, text: async () => JSON.stringify({ models: [] }) }));
  assert.deepEqual(ok, { ok: true, models: [] });
  const bad = await listModels('gemini', KEY, async () => ({ ok: false, text: async () => `bad key ${KEY}` }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.includes(KEY), false);
  assert.deepEqual((await listModels('claudecode', '')).models, CLI_MODELS.claudecode);
  assert.equal((await listModels('openai', '')).ok, false);
});

test('모델 탭 선택지: 지금 값이 목록에 없어도 남고, 코딩은 Claude만', () => {
  const rows = optionsFor('gemini', { status: 'ok', models: [{ id: 'a', label: '' }] }, 'zzz');
  assert.deepEqual(rows.map((m) => m.id), ['default', 'a', 'zzz']);
  const code = codeOptions(
    { claudecode: { status: 'ok', models: CLI_MODELS.claudecode }, gemini: { status: 'ok', models: [{ id: 'g', label: '' }] } },
    ['claudecode', 'gemini', 'codexcli'],
    'default',
  );
  assert.deepEqual(code.map((m) => m.id), ['default', 'sonnet', 'opus', 'haiku']);
});

test('말투·정해진 말은 키 없이 저장하고, 기본값과 같으면 비운다', () => {
  const d = withKey({}, 'gemini', KEY);
  const p = withVoice(d, { persona: '  짧게 말해.  ' });
  assert.equal(p.persona, '짧게 말해.');
  assert.equal(withVoice(p, { persona: SISA_BASE }).persona, '');
  const c = withVoice(d, { canned: { tired: ['안녕 **시사**예요.\n오늘은 쉬어요.'], nope: ['x'] } });
  assert.deepEqual(c.canned, { tired: ['안녕 **시사**예요.\n오늘은 쉬어요.'] });
  const view = publicView(c);
  assert.equal(JSON.stringify(view).includes(KEY), false);
  assert.deepEqual(view.canned, c.canned);
});

test('cannedOverrideOf: 기본값과 다른 칸만 남긴다', () => {
  assert.deepEqual(cannedOverrideOf(null, {}), {});
  const tired = ['안녕 **시사**예요.\n오늘은 쉬어요.'];
  assert.deepEqual(cannedOverrideOf({ tired }, {}), { tired });
  assert.deepEqual(cannedOverrideOf({ tired: [...CANNED_DEFAULTS.tired] }, {}), {});
});
