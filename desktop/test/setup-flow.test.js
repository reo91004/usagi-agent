import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSteps } from '../src/setup-flow.js';

test('agentSteps: claude·codex·agy 는 설치 뒤 로그인 단계가 있고, 모르는 도구는 비어 있다', () => {
  assert.equal(agentSteps('none').length, 0);
  assert.equal(agentSteps('claude')[0].id, 'claude-install');
  assert.equal(agentSteps('claude')[1].gate, 'login');
  assert.equal(agentSteps('codex')[1].code, 'codex login');
  assert.equal(agentSteps('claude')[1].code, 'claude auth login');
  assert.equal(agentSteps('codex')[1].gate, 'login');
});
