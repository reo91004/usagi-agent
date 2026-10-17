// Slack permalink → 데스크탑 앱 주소. 순수 함수.
// channel/team/id 는 공식 deep link(docs.slack.dev/interactivity/deep-linking). message·thread_ts 는 비공식이라
// Slack 이 무시해도 채널은 열린다. 그 워크스페이스의 permalink 가 아니면 null(= 그대로 브라우저로).
const CHANNEL = /^[CDG][A-Z0-9]{2,20}$/;
const TS = /^\d{10}\.\d{6}$/;
const TEAM = /^[TE][A-Z0-9]{2,20}$/;

// team: { url: 'https://x.slack.com', id: 'T…' } | null
export function slackAppUrl(link, team) {
  if (!team || !TEAM.test(team.id ?? '')) return null;
  let u, base;
  try { u = new URL(link); base = new URL(team.url); } catch { return null; }
  if (u.protocol !== 'https:' || u.host !== base.host) return null;
  const m = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(u.pathname);
  if (!m || !CHANNEL.test(m[1])) return null;
  const q = new URLSearchParams({ team: team.id, id: m[1], message: `${m[2]}.${m[3]}` });
  const thread = u.searchParams.get('thread_ts');
  if (thread && TS.test(thread)) q.set('thread_ts', thread);
  return `slack://channel?${q}`;
}
