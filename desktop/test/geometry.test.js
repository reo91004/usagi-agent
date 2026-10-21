import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPosition, restorePosition, contentMismatch } from '../src/geometry.js';

const size = { width: 360, height: 420 };
const wa = { x: 0, y: 25, width: 1440, height: 800 };

test('기본 위치: 오른쪽 아래, 독 위', () => {
  assert.deepEqual(defaultPosition(wa, size), { x: 1440 - 360 - 16, y: 25 + 800 - 420 });
});

test('저장 위치 복원', () => {
  assert.deepEqual(restorePosition({ x: 100, y: 100 }, [wa], size), { x: 100, y: 100 });
});

test('화면 밖이거나 깨진 값이면 null', () => {
  assert.equal(restorePosition({ x: 5000, y: 100 }, [wa], size), null);
  assert.equal(restorePosition({ x: 'a', y: 1 }, [wa], size), null);
  assert.equal(restorePosition(undefined, [wa], size), null);
});

test('보조 모니터 위 위치', () => {
  const second = { x: 1440, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(restorePosition({ x: 2000, y: 300 }, [wa, second], size), { x: 2000, y: 300 });
});

test('놓은 자리: 아래쪽은 그대로, 창 윗변이 작업영역 위로 나가면 뒤집기', async () => {
  const { dropPlacement } = await import('../src/geometry.js');
  const s = { width: 420, height: 580 }; // 캐릭터 윗변 = 보통 y+436, 뒤집으면 y+4
  const area = { x: 0, y: 39, width: 1800, height: 1076 };
  assert.deepEqual(dropPlacement(500, false, area, s), { y: 500, flip: false });
  assert.deepEqual(dropPlacement(39, false, area, s), { y: 39, flip: false }); // 경계: 캐릭터 윗변 475
  assert.deepEqual(dropPlacement(-300, false, area, s), { y: 132, flip: true }); // 캐릭터 윗변 136 그대로
  assert.deepEqual(dropPlacement(700, true, area, s), { y: 268, flip: false }); // 뒤집힌 채 아래로 → 되돌림
  assert.deepEqual(dropPlacement(300, true, area, s), { y: 300, flip: true });
  assert.deepEqual(dropPlacement(-500, false, area, s), { y: 35, flip: true }); // 메뉴 막대 뒤로는 안 감
});

test('contentMismatch: 페이지가 창보다 좁게 그려졌으면 true, 확대 배율은 셈에 넣는다', () => {
  assert.equal(contentMismatch([900, 640], { width: 900, height: 640 }), false);
  assert.equal(contentMismatch([751, 640], { width: 900, height: 640 }), true);
  assert.equal(contentMismatch([1000, 711], { width: 900, height: 640 }, 0.9), false);
  assert.equal(contentMismatch(null, { width: 900, height: 640 }), false);
});

test('가장자리에 숨기: 캐릭터 가운데, 가까운 가장자리, 붙인 자리', async () => {
  const { charCenter, nearestEdge, edgePlacement } = await import('../src/geometry.js');
  const s = { width: 420, height: 580 };
  const area = { x: 0, y: 39, width: 1800, height: 1076 }; // 아래 1115
  // 캐릭터는 보통 창 가운데 아래(위·아래 여백 4), 옆 가장자리면 창 그 쪽 끝
  assert.deepEqual(charCenter([100, 200], null, false, s), { x: 310, y: 200 + 580 - 4 - 70 });
  assert.deepEqual(charCenter([100, 200], 'left', true, s), { x: 170, y: 274 });
  assert.deepEqual(charCenter([100, 200], 'right', false, s), { x: 450, y: 706 });
  assert.equal(nearestEdge({ x: 60, y: 500 }, area), 'left');
  assert.equal(nearestEdge({ x: 1750, y: 500 }, area), 'right');
  assert.equal(nearestEdge({ x: 900, y: 1000 }, area), 'bottom');
  assert.equal(nearestEdge({ x: 140, y: 80 }, area), 'left'); // 위는 고르지 않는다
  assert.equal(nearestEdge({ x: -30, y: 500 }, area), 'left'); // 화면 밖으로 밀어 놓아도
  // 가장자리에서 캐릭터 반 개(70px) 넘게 떨어지면 붙이지 않는다(#300)
  assert.equal(nearestEdge({ x: 141, y: 500 }, area), null);
  assert.equal(nearestEdge({ x: 900, y: 500 }, area), null);
  assert.equal(nearestEdge({ x: 900, y: 80 }, area), null);
  assert.equal(nearestEdge({ x: 900, y: 1115 - 74 }, area), 'bottom'); // 기본 자리(창 아랫변이 작업영역 아래)는 아래에 붙는다
  // 아래: 캐릭터를 c.x 에 두고 창 아랫변을 작업영역 아래에, 뒤집기 풀기
  assert.deepEqual(edgePlacement('bottom', { x: 900, y: 600 }, 100, true, area, s), { x: 690, y: 1115 - 580, flip: false });
  // 옆: 창을 화면 안 그 쪽 끝에, 위아래는 dropPlacement(화면 위쪽이면 뒤집기)
  assert.deepEqual(edgePlacement('left', { x: 50, y: 600 }, 300, false, area, s), { x: 0, y: 300, flip: false });
  assert.deepEqual(edgePlacement('right', { x: 1750, y: 600 }, -300, false, area, s), { x: 1380, y: 132, flip: true }); // 캐릭터 윗변 -300+436=136 그대로
});
