import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPosition, restorePosition } from '../src/geometry.js';

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
