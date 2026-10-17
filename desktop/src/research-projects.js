// 연구 탭 프로젝트 목록 뷰모델 — 순수 로직. GET /dashboard 의 researchProjects 를 그리기 좋게 다듬는다.
import { isSafeLink } from './bubbles.js';
import { relativeTime, durationText } from './dashboard.js';

export const STAGES = ['prep', 'submitted', 'review', 'rebuttal', 'revision', 'accepted', 'rejected', 'withdrawn'];
export const STAGE_LABELS = { prep: '준비 중', submitted: '제출함', review: '리뷰 중', rebuttal: '리부탈', revision: '수정 요청', accepted: '채택', rejected: '거절', withdrawn: '철회' };
export const AI_LABEL = { claude: 'Claude', codex: 'Codex', agy: 'Agy', gemini: 'Gemini', aider: 'Aider', 'cursor-agent': 'Cursor', opencode: 'OpenCode' };
// 단계 칩 색: 준비 중은 기본 회색
export const STAGE_CHIP = { prep: '', submitted: 'accent', review: 'accent', rebuttal: 'warn', revision: 'warn', accepted: 'ok', rejected: 'err', withdrawn: 'err' };
const ENDED = ['accepted', 'rejected', 'withdrawn']; // 끝난 단계는 마감이 더 뜻이 없다
export const WARN_DAYS = 21, ERR_DAYS = 7;

const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const DAY = 86400e3;

// 마감 YYYY-MM-DD → { text: "D-38", tone: ''|warn|err }. 끝난 단계·날짜 없음은 null. 지난 마감은 D+n(색 없음)
export function deadlineChip(deadline, stage, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(deadline)) || ENDED.includes(stage)) return null;
  const d = new Date(now);
  const days = Math.round((Date.parse(`${deadline}T00:00:00`) - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / DAY);
  if (!Number.isFinite(days)) return null;
  return { text: days === 0 ? 'D-day' : days > 0 ? `D-${days}` : `D+${-days}`, tone: days < 0 || days > WARN_DAYS ? '' : days <= ERR_DAYS ? 'err' : 'warn' };
}

function shapeSub(s) {
  const stage = STAGES.includes(s.stage) ? s.stage : 'prep';
  return { venue: str(s.venue), stage, stageLabel: STAGE_LABELS[stage], tone: STAGE_CHIP[stage], deadline: str(s.deadline), at: str(s.at), day: str(s.at).slice(0, 10) };
}

function shapeExp(e, now) {
  const start = Number.isFinite(e.start) ? e.start * 1000 : 0;
  const secs = Number.isFinite(e.seconds) ? e.seconds : null;
  const state = e.running ? 'running' : e.lost ? 'lost' : e.code != null && e.code !== 0 ? 'failed' : 'done';
  const time = e.running
    ? (start ? `${durationText((now - start) / 1000)}째` : '')
    : [start && secs != null ? relativeTime(new Date(start + secs * 1000).toISOString(), now) : '', secs != null ? durationText(secs) : ''].filter(Boolean).join(' · ');
  const folder = str(e.cwd).split('/').filter(Boolean).at(-1) ?? '';
  return { name: str(e.name), host: str(e.host), state, time, folder, ai: AI_LABEL[e.ai] ?? '', where: [str(e.cwd), str(e.cmd)].filter(Boolean).join(' · ') };
}

// 작업 기록 제목 앞의 #, -, *, > 와 「Files mentioned by the user:」 첨부 머리를 뗀다
export function cleanTitle(t) {
  let x = str(t);
  for (let prev = null; prev !== x;) { prev = x; x = x.replace(/^[#\-*>\s]+/, '').replace(/^Files mentioned by the user:?/i, ''); }
  return x || '(제목 없음)';
}

export function shapeResearchProjects(list, now = Date.now()) {
  return arr(list).filter((p) => p && typeof p === 'object' && str(p.key)).map((p) => {
    const kind = p.kind === 'research' || p.kind === 'project' ? p.kind : null;
    const subs = kind === 'research' ? arr(p.subs).filter((s) => s && str(s.venue)).map(shapeSub) : [];
    const cur = subs.at(-1) ?? null;
    const rc = p.recent && typeof p.recent === 'object' ? p.recent : {};
    const running = arr(p.running).filter((e) => e && typeof e === 'object').map((e) => shapeExp(e, now));
    const experiments = running.filter((e) => !e.ai), ais = running.filter((e) => e.ai);
    const sessions = arr(p.sessions).filter((s) => s && typeof s === 'object').slice(0, 5).map((s) => ({ title: cleanTitle(s.title), tool: str(s.tool), rel: relativeTime(s.at, now) }));
    const done = Number.isInteger(rc.done) ? rc.done : 0, failed = Number.isInteger(rc.failed) ? rc.failed : 0;
    const aiNames = [...new Set(ais.map((e) => e.ai))];
    return {
      key: p.key, kind, name: str(p.name) || p.key,
      folders: arr(p.folders).filter((f) => f && str(f.path)).map((f) => ({ path: f.path, onMac: f.onMac })),
      subs, cur,
      chip: cur ? `${cur.venue} · ${cur.stageLabel}` : '학회 미정',
      dday: cur ? deadlineChip(cur.deadline, cur.stage, now) : null,
      url: str(p.url) && isSafeLink(p.url) ? p.url : '',
      lastRel: relativeTime(p.lastActive, now),
      experiments, ais,
      // 목록 둘째 줄
      line2: [experiments.length ? `실험 ${experiments.length}개 도는 중` : '', aiNames.length ? `${aiNames.join('·')} 작업 중` : '', sessions.length ? `최근: ${sessions[0].title}` : ''].filter(Boolean).join(' · ') || '최근 30일 활동 없음',
      recent: { done, failed, items: arr(rc.items).filter((e) => e && typeof e === 'object').slice(0, 5).map((e) => shapeExp(e, now)) },
      sessions,
    };
  });
}

// 이전에 쓴 학회 이름(자동완성): 모든 제출에서, 중복 없이
export function venuesUsed(projects) {
  return [...new Set(projects.flatMap((p) => p.subs.map((s) => s.venue)))];
}

// PUT /research/projects 로 보낼 제출 전체 배열 (daemon 모양: venue·stage·deadline?·at)
export const subsBody = (subs) => subs.map((s) => ({ venue: s.venue, stage: s.stage, ...(s.deadline ? { deadline: s.deadline } : {}), ...(s.at ? { at: s.at } : {}) }));

// 마지막 제출만 바꾼 새 배열(지금 제출 편집)
export const withCurrent = (subs, patch) => subs.map((s, i) => (i === subs.length - 1 ? { ...s, ...patch } : s));

// 새 학회(기본 준비 중)를 마지막 제출 뒤에 쌓는다(거절·철회 뒤나 처음). 옛것은 그대로
export const withNextVenue = (subs, venue, deadline, stage = 'prep') => [...subs, { venue, stage, ...(deadline ? { deadline } : {}) }];
