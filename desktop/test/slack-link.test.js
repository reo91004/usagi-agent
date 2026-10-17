import test from 'node:test';
import assert from 'node:assert/strict';
import { slackAppUrl } from '../src/slack-link.js';

const team = { url: 'https://lab.slack.com/', id: 'T012AB3C4' };
test('메시지 permalink → slack://channel', () => {
  assert.equal(slackAppUrl('https://lab.slack.com/archives/C0123ABCD/p1792232129398889', team),
    'slack://channel?team=T012AB3C4&id=C0123ABCD&message=1792232129.398889');
});
test('스레드 답은 thread_ts 도', () => {
  assert.equal(slackAppUrl('https://lab.slack.com/archives/D0123ABCD/p1792232129398889?thread_ts=1792230000.000100&cid=D0123ABCD', team),
    'slack://channel?team=T012AB3C4&id=D0123ABCD&message=1792232129.398889&thread_ts=1792230000.000100');
});
test('다른 호스트·이상한 경로·팀 모름은 바꾸지 않는다', () => {
  assert.equal(slackAppUrl('https://other.slack.com/archives/C0123ABCD/p1792232129398889', team), null);
  assert.equal(slackAppUrl('https://lab.slack.com.evil.com/archives/C0123ABCD/p1792232129398889', team), null);
  assert.equal(slackAppUrl('http://lab.slack.com/archives/C0123ABCD/p1792232129398889', team), null);
  assert.equal(slackAppUrl('https://lab.slack.com/archives/c0123/p1792232129398889', team), null);
  assert.equal(slackAppUrl('https://lab.slack.com/archives/C0123ABCD/p12', team), null);
  assert.equal(slackAppUrl('https://lab.slack.com/archives/C0123ABCD/p1792232129398889', null), null);
  assert.equal(slackAppUrl('https://lab.slack.com/archives/C0123ABCD/p1792232129398889', { url: team.url, id: 'x&y' }), null);
});
test('잘못된 thread_ts 는 뺀다', () => {
  assert.equal(slackAppUrl('https://lab.slack.com/archives/C0123ABCD/p1792232129398889?thread_ts=a&b', team),
    'slack://channel?team=T012AB3C4&id=C0123ABCD&message=1792232129.398889');
});
