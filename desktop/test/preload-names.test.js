// 패널이 부르는 window.cy 함수가 preload 에 정말 있는가. 없으면 cy.x?.() 는 조용히 아무 일도 안 한다(#171 핀 단추가 그랬다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const exposed = (file) => {
  let api;
  const electron = { contextBridge: { exposeInMainWorld: (_name, obj) => { api = obj; } }, ipcRenderer: { invoke() {}, send() {}, on() {}, removeListener() {} } };
  vm.runInNewContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { require: (m) => (m === 'electron' ? electron : {}), process, console });
  return api;
};

// 이 창의 cy(window.cy) 로 부르는 이름. 문자열 안(`cy.session.…` 저장 키)·window.cy 자체는 뺀다
const usedNames = (file) => {
  const src = readFileSync(new URL(`../renderer/${file}`, import.meta.url), 'utf8');
  return [...new Set([...src.matchAll(/(?<![\w.'"`])cy\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
};

for (const [renderer, preload] of [['panel.js', 'preload-panel.cjs'], ['session.js', 'preload-session.cjs'], ['renderer.js', 'preload.cjs']]) {
  test(`${renderer} 가 부르는 cy.* 는 모두 ${preload} 에 있다`, () => {
    const api = exposed(preload);
    const used = usedNames(renderer);
    assert.ok(used.length > 10, renderer);
    assert.deepEqual(used.filter((k) => !(k in api)), []);
  });
}

test('settings.js(window.cy.settings) 가 부르는 것도 preload-panel 의 settings 에 있다', () => {
  const api = exposed('preload-panel.cjs').settings;
  assert.deepEqual(usedNames('settings.js').filter((k) => !(k in api)), []);
  for (const k of ['getAppPrefs', 'setAppPrefs']) assert.equal(typeof api[k], 'function'); // 패널 핀 단추(#171)도 여기를 쓴다
});
