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
