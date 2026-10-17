import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockWanted, panelClickAction } from '../src/dock.js';

test('dockWanted: 패널이 열려 있거나 설정이 켜져 있으면 Dock 에 보인다', () => {
  assert.equal(dockWanted({ panelVisible: true, showInDock: false }), true);
  assert.equal(dockWanted({ panelVisible: true, showInDock: undefined }), true);
  assert.equal(dockWanted({ panelVisible: false, showInDock: true }), true);
  assert.equal(dockWanted({ panelVisible: false, showInDock: false }), false);
  assert.equal(dockWanted({ panelVisible: false }), false);
});

test('panelClickAction: 보이고 앞이면 숨기고, 가려졌거나 안 보이면 앞으로', () => {
  assert.equal(panelClickAction({ visible: true, focused: true }), 'hide');
  assert.equal(panelClickAction({ visible: true, focused: false }), 'show');
  assert.equal(panelClickAction({ visible: false, focused: false }), 'show');
});
