// 창 위치 계산 — 순수 함수

// 기본 위치: 작업영역(독/메뉴바 제외) 오른쪽 아래
export function defaultPosition(workArea, size, margin = 16) {
  return {
    x: Math.round(workArea.x + workArea.width - size.width - margin),
    y: Math.round(workArea.y + workArea.height - size.height),
  };
}

// 저장된 위치가 어느 화면에도 안 걸치면 null (모니터 뺐을 때)
export function restorePosition(saved, workAreas, size, minVisible = 80) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
  for (const wa of workAreas) {
    const ox = Math.min(saved.x + size.width, wa.x + wa.width) - Math.max(saved.x, wa.x);
    const oy = Math.min(saved.y + size.height, wa.y + wa.height) - Math.max(saved.y, wa.y);
    if (ox >= minVisible && oy >= minVisible) return { x: Math.round(saved.x), y: Math.round(saved.y) };
  }
  return null;
}

// 캐릭터(140px)는 보통 창 아래쪽에 있고 말풍선이 그 위로 쌓인다. 화면 위쪽에서는 그 자리가 화면 밖이라
// 창을 뒤집어 캐릭터를 창 위쪽에, 말풍선을 아래에 둔다(style.css #stage.flip). 4 는 #stage 의 캐릭터 쪽 여백
const CHAR_SIZE = 140;
const charOffset = (flip, size) => (flip ? 4 : size.height - 4 - CHAR_SIZE);

// 끌어다 놓은 자리: 캐릭터는 놓은 곳에 두고, 보통 배치로는 창 윗변이 작업영역 위로 나가면 뒤집는다.
// 캐릭터가 메뉴 막대 뒤로 들어가지 않게 위쪽만 막는다. y·flip 은 지금 창 윗변과 배치
export function dropPlacement(y, flip, workArea, size) {
  const top = Math.max(y + charOffset(flip, size), workArea.y);
  const next = top - charOffset(false, size) < workArea.y;
  return { y: Math.round(top - charOffset(next, size)), flip: next };
}

// 가장자리에 숨기(#stage.edge-left·edge-right·tucked): 옆 가장자리면 캐릭터가 창의 그 쪽 끝에, 아니면 창 가운데에 있다
export const charCenter = ([x, y], edge, flip, size) => ({
  x: edge === 'left' ? x + CHAR_SIZE / 2 : edge === 'right' ? x + size.width - CHAR_SIZE / 2 : x + size.width / 2,
  y: y + charOffset(flip, size) + CHAR_SIZE / 2,
});

// 캐릭터 가운데 c 에서 가장 가까운 작업영역 가장자리. 위는 메뉴 막대라 뺀다
export function nearestEdge(c, workArea) {
  const d = { left: c.x - workArea.x, right: workArea.x + workArea.width - c.x, bottom: workArea.y + workArea.height - c.y };
  return Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
}

// 그 가장자리에 붙인 창 자리. 아래면 캐릭터가 c.x 에 오게 작업영역 아래에(뒤집지 않음),
// 옆이면 창을 화면 안 그 쪽 끝에 붙이고(캐릭터는 CSS 로 창 끝에) 위아래는 놓은 자리(dropPlacement)
export function edgePlacement(edge, c, y, flip, workArea, size) {
  if (edge === 'bottom') return { x: Math.round(c.x - size.width / 2), y: defaultPosition(workArea, size).y, flip: false };
  return { x: edge === 'left' ? workArea.x : workArea.x + workArea.width - size.width, ...dropPlacement(y, flip, workArea, size) };
}

// 창 안쪽 크기와 페이지가 그린 크기(CSS px × 확대 배율)가 2px 넘게 다르면 true — 오른쪽·아래에 빈 띠가 남은 것(#128)
export function contentMismatch(inner, content, zoom = 1) {
  if (!Array.isArray(inner) || !content) return false;
  const z = Number(zoom) > 0 ? Number(zoom) : 1;
  return Math.abs(inner[0] * z - content.width) > 2 || Math.abs(inner[1] * z - content.height) > 2;
}
