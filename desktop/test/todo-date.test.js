import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDue, dueBucket } from '../src/todo-date.js';

const NOW = new Date(2026, 9, 26, 10, 0); // 10/26(월) 오전 10시
const at = (m, d, h = 0, min = 0, y = 2026) => new Date(y, m - 1, d, h, min).toISOString();
const due = (s, now = NOW) => parseDue(s, now)?.due;

test('parseDue: 날짜·시각을 마감으로 읽고 그 말은 제목에서 뺀다', () => {
  assert.deepEqual(parseDue('내일 3시 발표 자료 보내기', NOW), { due: at(10, 27, 15), title: '발표 자료 보내기', label: '10/27 (화) 15:00', words: ['내일', '3시'] });
  assert.deepEqual(parseDue('금요일까지 보고서', NOW), { due: at(10, 30), title: '보고서', label: '10/30 (금)', words: ['금요일까지'] });
  assert.equal(due('다음 주 월요일 회의'), at(11, 2));
  assert.equal(due('담주 수요일 스터디'), at(11, 4));
  assert.equal(due('이번 주 일요일 청소'), at(11, 1));
  assert.equal(due('10/30 16:00 서류 제출'), at(10, 30, 16));
  assert.equal(due('서류 제출 10월 31일'), at(10, 31));
  assert.equal(due('11/3 회의'), at(11, 3));
  assert.equal(due('1/5까지 세금'), at(1, 5, 0, 0, 2027)); // 지난 날짜면 내년. 두 달 넘게 먼 M/D 는 「까지·에」가 있을 때만
  assert.equal(due('2026-12-01 마감'), at(12, 1));
  assert.equal(due('3일 뒤 연락'), at(10, 29));
  assert.equal(due('일주일 후 점검'), at(11, 2));
  assert.equal(due('2주 뒤 회고'), at(11, 9));
  assert.equal(parseDue('오늘 저녁 7시에 저녁 약속', NOW).title, '저녁 약속');
  assert.equal(due('오늘 저녁 7시에 저녁 약속'), at(10, 26, 19));
});

test('parseDue: 시각 읽기(오전·오후 없으면 1~7시는 오후, 시각만 있으면 지났을 때 내일)', () => {
  assert.equal(due('오후 2시 반 치과'), at(10, 26, 14, 30));
  assert.equal(due('오전 11시 10분 통화'), at(10, 26, 11, 10));
  assert.equal(due('12시 점심'), at(10, 26, 12));
  assert.equal(due('9시 운동'), at(10, 27, 9)); // 오늘 9시는 지났다
  assert.equal(due('아침 7시 기상 내일'), at(10, 27, 7));
  assert.equal(due('밤 11시 정리'), at(10, 26, 23));
  assert.equal(due('밤 12시 마감'), at(10, 26, 23, 59)); // 그날 끝
  assert.equal(due('오후 12시 점심'), at(10, 26, 12));
  assert.equal(parseDue('15:30 회의', NOW).label, '10/26 (월) 15:30');
});

test('parseDue: 낱말 안쪽·없는 날짜는 읽지 않는다', () => {
  for (const s of ['오늘의 집 리뷰', '3시간 공부', '수업 준비', '다음 주 수업', '2월 30일 무엇', '월요병', '내일의 나', '', '세금 낼 것', '이번 주 일 정리', '1/2 컵 계량', 'PR 3/4 리뷰']) assert.equal(parseDue(s, NOW), null, s);
});

test('parseDue: 날짜 말만 있으면 제목은 그대로, 오늘이 그 요일이면 오늘', () => {
  assert.deepEqual(parseDue('모레', NOW), { due: at(10, 28), title: '모레', label: '10/28 (수)', words: ['모레'] });
  assert.equal(due('금요일 보고', new Date(2026, 9, 30, 9)), at(10, 30));
});

test('dueBucket: 데몬 duePriority 와 같은 기준(오늘까지 1, 7일 안 2, 그 뒤 3)', () => {
  assert.equal(dueBucket(at(10, 26, 23), NOW), 1);
  assert.equal(dueBucket(at(10, 20), NOW), 1);
  assert.equal(dueBucket(at(10, 27), NOW), 2);
  assert.equal(dueBucket(at(11, 1, 23), NOW), 2);
  assert.equal(dueBucket(at(11, 2), NOW), 3);
});
