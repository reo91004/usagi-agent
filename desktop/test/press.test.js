import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPress, createClicks, DRAG_PX, LONG_PRESS_MS, AFTER_DRAG_MS, DOUBLE_CLICK_MS } from '../src/press.js';

const P = (x, y, t, ox = 100, oy = 100) => ({ x, y, t, ox, oy });

// 렌더러의 mousedown/mousemove/mouseup 핸들러와 같은 순서로 부른다. 'click' 이 나오면 onCharacterClick 이 불린다
function gesture({ moves = [], up = [0, 0], held = 50, t0 = 1000, win = [100, 100], onChar = true, press = createPress() }) {
  press.press(P(0, 0, t0));
  let dragStarts = 0;
  for (const [x, y] of moves) if (press.move(P(x, y, t0 + 10, ...win))) dragStarts++;
  const result = press.release(P(up[0], up[1], t0 + held, ...win), onChar);
  return { result, dragStarts };
}

test('움직임 없이 짧게 누르고 뗀 것은 클릭', () => {
  assert.deepEqual(gesture({}), { result: 'click', dragStarts: 0 });
});

test('끌기 문턱: 4px 까지는 클릭, 넘으면 끌기이고 뗄 때 클릭이 아니다', () => {
  assert.equal(gesture({ moves: [[DRAG_PX, 0]], up: [DRAG_PX, 0] }).result, 'click');
  const over = gesture({ moves: [[DRAG_PX + 1, 0]], up: [DRAG_PX + 1, 0] });
  assert.deepEqual(over, { result: 'dragEnd', dragStarts: 1 });
});

test('4px 넘게 움직인 뒤 제자리로 돌아와 뗀 것도 끌기', () => {
  assert.deepEqual(gesture({ moves: [[30, 0], [0, 0]], up: [0, 0] }), { result: 'dragEnd', dragStarts: 1 });
});

test('끌기 시작은 한 번만 알린다', () => {
  assert.equal(gesture({ moves: [[10, 0], [20, 0], [30, 0]], up: [30, 0] }).dragStarts, 1);
});

test('움직임 이벤트 없이 멀리서 뗀 것은 클릭이 아니다', () => {
  assert.equal(gesture({ up: [40, 0] }).result, 'none');
});

test('누르는 동안 창이 옮겨졌으면 클릭이 아니다', () => {
  const press = createPress();
  press.press(P(0, 0, 1000, 100, 100));
  assert.equal(press.release(P(0, 0, 1050, 130, 100), true), 'none');
});

test('길게 누르고 뗀 것은 클릭이 아니다', () => {
  assert.equal(gesture({ held: LONG_PRESS_MS - 1 }).result, 'click');
  assert.equal(gesture({ held: LONG_PRESS_MS }).result, 'none');
});

test('캐릭터 밖에서 뗀 것은 클릭이 아니다', () => {
  assert.equal(gesture({ onChar: false }).result, 'none');
});

test('눌리지 않았는데 온 mouseup 은 무시', () => {
  assert.equal(createPress().release(P(0, 0, 1000), true), 'none');
});

test('끌기를 놓은 직후(드래그 잠금을 끝내는 탭 등)의 클릭은 무시, 시간이 지나면 다시 클릭', () => {
  const press = createPress();
  gesture({ press, moves: [[30, 0]], up: [30, 0], held: 300 }); // t0+300 에 놓음
  const tap = (t) => { press.press(P(30, 0, t)); return press.release(P(30, 0, t + 50), true); };
  assert.equal(tap(1000 + 300 + 100), 'none');
  assert.equal(tap(1000 + 300 + AFTER_DRAG_MS + 100), 'click');
});

test('reset: 끌던 중이었으면 true 를 주고 그 직후 클릭도 막는다. 안 끌었으면 false', () => {
  const press = createPress();
  press.press(P(0, 0, 1000));
  assert.equal(press.reset(1010), false);
  assert.equal(press.pressed, false);
  press.press(P(0, 0, 1100));
  press.move(P(30, 0, 1110));
  assert.equal(press.reset(1200), true);
  assert.equal(press.pressed, false);
  press.press(P(0, 0, 1300));
  assert.equal(press.release(P(0, 0, 1350), true), 'none');
});

test('더블클릭: 간격 안의 두 번째 클릭만 더블, 세 번째는 다시 한 번 클릭', () => {
  const c = createClicks();
  assert.equal(c.click(1000), 'single');
  assert.equal(c.click(1000 + DOUBLE_CLICK_MS), 'double');
  assert.equal(c.click(1000 + DOUBLE_CLICK_MS + 50), 'single');
  assert.equal(c.click(2000), 'single'); // 간격이 지나면 새 한 번 클릭
});

test('탭 후 끌기: 탭 직후 누른 것이 끌기로 이어지면 더블이 되지 않고 탭을 거둔다', () => {
  const c = createClicks();
  const press = createPress();
  // 탭
  press.press(P(0, 0, 1000));
  assert.equal(press.release(P(0, 0, 1050), true), 'click');
  assert.equal(c.click(1050), 'single');
  // 100ms 뒤 다시 누르고 끈다
  press.press(P(0, 0, 1150));
  assert.equal(press.move(P(30, 0, 1170)), true);
  assert.equal(c.cancel(press.at), true); // 입력창을 열었던 그 탭이다
  assert.equal(press.release(P(30, 0, 1400), true), 'dragEnd');
  // 끌기 뒤 곧바로 눌러도 앞 탭과 더블이 되지 않는다
  assert.equal(c.click(1500), 'single');
});

test('끌기와 상관없이 오래된 탭은 거둘 게 없다', () => {
  const c = createClicks();
  c.click(1000);
  assert.equal(c.cancel(1000 + DOUBLE_CLICK_MS + 1), false);
});
