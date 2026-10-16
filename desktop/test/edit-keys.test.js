import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editCommand } from '../src/edit-keys.js';

const key = (key, code, mods = {}) => ({ type: 'keyDown', key, code, meta: true, ...mods });

test('⌘C·⌘V·⌘X·⌘A 만, 한글 입력 중이면 물리 키로', () => {
  assert.equal(editCommand(key('c', 'KeyC')), 'copy');
  assert.equal(editCommand(key('V', 'KeyV')), 'paste');
  assert.equal(editCommand(key('x', 'KeyX')), 'cut');
  assert.equal(editCommand(key('a', 'KeyA')), 'selectAll');
  assert.equal(editCommand(key('ㅍ', 'KeyV')), 'paste');
});

test('⌘Z·다른 조합·keyUp·⌘ 없음은 건드리지 않는다', () => {
  assert.equal(editCommand(key('z', 'KeyZ')), null);
  assert.equal(editCommand(key('v', 'KeyV', { shift: true })), null);
  assert.equal(editCommand(key('v', 'KeyV', { alt: true })), null);
  assert.equal(editCommand(key('c', 'KeyC', { control: true })), null);
  assert.equal(editCommand(key('c', 'KeyC', { type: 'keyUp' })), null);
  assert.equal(editCommand(key('c', 'KeyC', { meta: false })), null);
  assert.equal(editCommand(key('w', 'KeyW')), null);
});
