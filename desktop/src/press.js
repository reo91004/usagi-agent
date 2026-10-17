// 캐릭터를 누르고 떼는 순서가 클릭인지 끌기인지 가르는 순수 판정(DOM·타이머 없음, 시각은 부르는 쪽이 준다).
// 클릭은 「움직임 없이 짧게 누르고 뗀 것」뿐이다. 조금이라도 움직였거나 창이 옮겨졌으면 뗄 때 아무것도 열지 않는다.

export const DRAG_PX = 4; // 누른 자리에서 이만큼을 넘게 움직이면 끌기
export const LONG_PRESS_MS = 500; // 이보다 오래 누르고 있다 뗀 건 옮기려다 만 것 — 클릭이 아니다
export const AFTER_DRAG_MS = 600; // 옮긴 직후 들어온 클릭(드래그 잠금을 끝내는 탭 등)은 무시
export const DOUBLE_CLICK_MS = 280;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// p = { x, y, t, ox, oy }: 화면 좌표 커서, 시각(ms), 이 창의 화면 좌표 원점
export function createPress() {
  let down = null;
  let dragging = false;
  let dragEndAt = -Infinity;
  return {
    get pressed() { return !!down; },
    get dragging() { return dragging; },
    get at() { return down?.t; },
    press(p) { down = p; dragging = false; },
    // 문턱을 처음 넘은 순간에만 true — 그때 끌기를 시작한다
    move(p) {
      if (!down || dragging || dist(p, down) <= DRAG_PX) return false;
      dragging = true;
      return true;
    },
    // 'dragEnd' = 끌던 것을 놓음, 'click' = 클릭, 'none' = 아무 일 없음. onChar: 뗀 자리가 캐릭터 위인가
    // 뗀 자리와 창 위치도 본다: 움직임 이벤트가 빠졌거나 창이 옮겨졌어도 클릭으로 치지 않게
    release(p, onChar) {
      if (!down) return 'none';
      const d = down;
      const wasDrag = dragging;
      down = null;
      dragging = false;
      if (wasDrag) { dragEndAt = p.t; return 'dragEnd'; }
      const still = dist(p, d) <= DRAG_PX && p.ox === d.ox && p.oy === d.oy;
      return onChar && still && p.t - d.t < LONG_PRESS_MS && p.t - dragEndAt > AFTER_DRAG_MS ? 'click' : 'none';
    },
    // 눌린 줄 알았는데 아니었거나(메뉴가 mouseup 을 삼킴, 창 포커스 잃음) 끌던 중이면 풀어 준다. 끌던 중이었으면 true
    reset(t) {
      const was = dragging;
      if (was) dragEndAt = t;
      down = null;
      dragging = false;
      return was;
    },
  };
}

// 한 번 클릭과 더블클릭 가르기. 첫 클릭이 바로 일을 하고(말 걸기), DOUBLE_CLICK_MS 안의 두 번째 클릭만 더블이다
export function createClicks() {
  let last = -Infinity;
  return {
    click(t) {
      const double = t - last <= DOUBLE_CLICK_MS;
      last = double ? -Infinity : t;
      return double ? 'double' : 'single';
    },
    // 방금 누른 것이 끌기로 이어졌다: 앞 클릭이 더블을 기다리던 중이었으면 true(그 클릭은 끌기를 위한 탭이었다)
    cancel(pressAt) {
      const waiting = pressAt - last <= DOUBLE_CLICK_MS;
      last = -Infinity;
      return waiting;
    },
  };
}
