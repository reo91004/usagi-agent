import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsSetup } from '../src/setup.js';

test('needsSetup: Slack·캘린더가 둘 다 준비 전일 때만', () => {
  assert.equal(needsSetup([]), false);
  assert.equal(needsSetup(null), false);
  assert.equal(needsSetup([
    { cap: 'slack', ready: false },
    { cap: 'calendar', ready: false },
  ]), true);
  assert.equal(needsSetup([
    { cap: 'slack', ready: true },
    { cap: 'calendar', ready: false },
  ]), false);
  assert.equal(needsSetup([{ cap: 'mail', ready: false }]), false);
});
