// 캐릭터 상태 — 순수 로직. 렌더러와 테스트가 같이 쓴다.
// 정지 그림: 눈 뜬 그림이 기본, 랜덤 간격으로 잠깐 눈 감은 그림(가끔 두 번 깜빡).
// 활동: 데몬 state { activity, runs, danceId } → 보여줄 것 'idle'(정지 그림) | 'studying'(공부 영상) | 'dancing'(춤 영상).
// 우선순위 dancing > studying > idle. 춤이 끝나면(데몬이 알리거나 로컬 상한) 그 전 상태로 돌아간다.
// 집중하기(focus.js): 집중 중이면 공부 영상, 일시정지면 기본 그림(데몬이 다른 일로 공부 중이면 그대로 공부 영상).

import { CHARACTER_LINES } from './character-lines.js';

export const CHAR_DIR = 'cy-asset://app/character';
// 정지 그림 대체 순서: 눈 뜬 그림 → 예전 개인 그림 → 번들 그림 → 번들 svg
export const STILL_SRCS = [`${CHAR_DIR}/eyes_open.png`, 'cy-asset://app/character.png', '../assets/character.png', '../assets/character.svg'];
export const VIDEOS = {
  studying: { src: `${CHAR_DIR}/studying.webm`, poster: `${CHAR_DIR}/studying.png`, kind: 'video' },
  dancing: { src: `${CHAR_DIR}/dance.webm`, poster: `${CHAR_DIR}/dance.png`, kind: 'video' },
};

// ---- 고를 수 있는 캐릭터(데몬 characters.ts 와 같은 id). 시사는 예전 자리(character/), 나머지는 characters/<id>/ ----
// study = 집중·공부 중(studying 자리), plan = 일정 알림·춤(dancing 자리). scene: 배경이 있는 장면이라 둥근 네모 카드로 보인다
// clips: 춤 영상 종류(데몬 state.danceClip: plan 일정 알림 · dance 춤춰 줘 · cheer 응원해 줘) → 그 캐릭터의 파일 이름. 없는 종류는 같은 파일을 다시 쓴다
// 사용자가 만든 캐릭터(u-xxxxxxxx)는 데몬 GET /characters 를 받아 character-registry.js 가 여기에 더한다: { name, custom: true, media, frame }
export const CHARACTERS = {
  shisa: { name: '시사' },
  hachi: { name: '하치와레', blink: true, scenes: { cheer: true }, clips: { plan: 'plan', dance: 'plan', cheer: 'cheer' } },
  rakko: { name: '랏코', blink: true, scenes: { study: true, plan: true, dance: true }, clips: { plan: 'plan', dance: 'dance', cheer: 'plan' } },
  momonga: { name: '모몽가', blink: true, scenes: { study: true, plan: true, dance: true }, clips: { plan: 'plan', dance: 'dance', cheer: 'plan' } },
  usagi: { name: '우사기', blink: false, scenes: {}, clips: { plan: 'plan', dance: 'dance', cheer: 'cheer' } },
};
export const DANCE_CLIPS = ['plan', 'dance', 'cheer'];
export const CHARACTER_IDS = Object.freeze(Object.keys(CHARACTERS)); // 기본 다섯
export const DEFAULT_CHARACTER = 'shisa';
// 데몬 state 를 받기 전 첫 화면(데몬 config.ts START_CHARACTER 와 같다)
export const START_CHARACTER = 'usagi';
// 사용자 캐릭터 id 모양(데몬 character-store.ts USER_ID 와 같다). 있는지는 데몬이 다시 본다
export const USER_CHARACTER_ID = /^u-[a-z0-9]{4,32}$/;
export const okCharacterId = (id) => typeof id === 'string' && (CHARACTER_IDS.includes(id) || USER_CHARACTER_ID.test(id));
// 오버레이가 데몬 말 없이 스스로 띄우는 짧은 말(머지 결과를 먼저 보일 때·AI 없이 묻기 칩). 시사는 예전 글 그대로
export const SHISA_SAY_LOCAL = { quickAi: '정해진 답으로 바로 알려 드릴게요. 무엇이 궁금하세요?', mergeDone: '머지했어요 🎉 (스이시~사)', mergeDeclined: '알겠어요, 머지는 안 할게요. PR은 열어 둘게요', quick: '무엇이 궁금하세요? AI 없이도 이건 바로 알려 드려요', quickLogin: 'Claude Code 로그인 전이라도 이건 바로 알려 드려요. 무엇이 궁금하세요?' };
// 다른 캐릭터 글은 assets/characters/lines.json 의 overlay
export const LOCAL_SAY = { shisa: SHISA_SAY_LOCAL, ...Object.fromEntries(Object.entries(CHARACTER_LINES).map(([id, c]) => [id, { ...SHISA_SAY_LOCAL, ...(c.overlay ?? {}) }])) };
export const localSay = (id) => LOCAL_SAY[okCharacter(id)] ?? SHISA_SAY_LOCAL;

// 화면에 쓰는 이름: 「하치와레」·「하치와레 비서」(앱 이름·메뉴·창 제목)
export const characterName = (id) => CHARACTERS[okCharacter(id)].name;
export const appName = (id) => `${characterName(id)} 비서`;
export const okCharacter = (id) => (typeof id === 'string' && Object.hasOwn(CHARACTERS, id) ? id : DEFAULT_CHARACTER);

// ---- 사용자 캐릭터 그림·영상 ----
// 올린 파일은 ~/.cy-agent/characters/<id>/<칸>-<무작위>.<확장자>(데몬이 이름을 짓는다) → cy-asset://app/user-characters/<id>/<그 이름>
export const USER_CHAR_DIR = 'cy-asset://app/user-characters';
export const MEDIA_SLOTS = ['eyes_open', 'eyes_closed', 'cheer', 'dance', 'study', 'plan'];
export const REQUIRED_SLOTS = ['eyes_open', 'eyes_closed', 'cheer', 'dance'];
export const MEDIA_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'mp4'];
const VIDEO_EXT = /\.(webm|mp4)$/i;
// 파일 이름 → 'video'(<video> 로 튼다) | 'img'(<img>: 정지 그림·움직이는 gif·webp 는 <video> 가 못 튼다)
export const clipKind = (file) => (VIDEO_EXT.test(String(file ?? '')) ? 'video' : 'img');
// 빈 칸 대신 쓰는 규칙(꼭 넣을 넷이 비어도 깨지지 않게):
//   응원 → 춤 · 춤 → 응원 · 일정 알림 → 춤 → 응원 · 집중 → 없으면 정지 그림(눈 뜬 모습, 깜빡임 그대로)
//   눈 감은 모습이 없으면 깜빡이지 않는다 · 눈 뜬 모습이 없으면 시사 그림
// frames: 칸마다 테두리(둥근 네모 카드). 없는 칸은 파일 종류로(투명 배경이 흔한 png·webm 은 끔, 그 밖은 켬 — 데몬 defaultFrame 과 같다).
// 정사각형이 아니어도 비율대로 상자 안에 맞춘다(fit)
export const defaultFrame = (file) => !/\.(png|webm)$/i.test(String(file ?? ''));
export function customAssets(id, media = {}, frames = {}) {
  const dir = `${USER_CHAR_DIR}/${id}`;
  const url = (slot) => (typeof media?.[slot] === 'string' && media[slot] ? `${dir}/${media[slot]}` : null);
  const framed = (slot) => (typeof frames?.[slot] === 'boolean' ? frames[slot] : defaultFrame(media?.[slot]));
  const clip = (slot) => { const src = url(slot); return src ? { src, poster: '', scene: framed(slot), kind: clipKind(src), fit: true, slot } : null; };
  const cheer = clip('cheer') ?? clip('dance');
  const dance = clip('dance') ?? clip('cheer');
  const plan = clip('plan') ?? dance;
  const open = url('eyes_open');
  return {
    id, dir, retina: false, custom: true,
    open: open ?? STILL_SRCS[0], closed: open ? url('eyes_closed') : null,
    openFrame: !!open && framed('eyes_open'), closedFrame: !!open && !!url('eyes_closed') && framed('eyes_closed'),
    stills: open ? [open, ...STILL_SRCS] : STILL_SRCS,
    videos: { studying: clip('study'), dancing: plan },
    clips: { plan, dance, cheer },
  };
}

// 캐릭터 하나의 그림·영상 주소. { dir, open, closed(없으면 null), stills(대체 순서), videos: { studying, dancing }, clips: { plan, dance, cheer } }
// videos.dancing 은 일정 알림(plan) 영상 — 춤춰 줘·응원해 줘는 clips 에서 고른다(clipFor). 사용자 캐릭터는 빈 칸이 null 일 수 있다(정지 그림으로)
export function characterAssets(id) {
  const cid = okCharacter(id);
  const c = CHARACTERS[cid];
  if (c.custom) return customAssets(cid, c.media, c.frames);
  if (cid === 'shisa') return { id: cid, dir: CHAR_DIR, retina: true, open: `${CHAR_DIR}/eyes_open.png`, closed: `${CHAR_DIR}/eyes_closed.png`, stills: STILL_SRCS, videos: VIDEOS, clips: { plan: VIDEOS.dancing, dance: VIDEOS.dancing, cheer: VIDEOS.dancing } };
  const dir = `cy-asset://app/characters/${cid}`;
  const clip = (name) => ({ src: `${dir}/${name}.webm`, poster: `${dir}/${name}.png`, scene: !!c.scenes[name], kind: 'video' });
  const clips = Object.fromEntries(DANCE_CLIPS.map((k) => [k, clip(c.clips[k])]));
  return {
    id: cid, dir, retina: false, open: `${dir}/eyes_open.png`, closed: c.blink ? `${dir}/eyes_closed.png` : null,
    stills: [`${dir}/eyes_open.png`, ...STILL_SRCS],
    videos: { studying: clip('study'), dancing: clips.plan },
    clips,
  };
}
// 춤 영상 하나: 종류(plan·dance·cheer, 모르면 plan) → { src, poster, scene, kind } | null(사용자 캐릭터에 그 칸이 없음 → 정지 그림)
export const clipFor = (a, kind) => a.clips[DANCE_CLIPS.includes(kind) ? kind : 'plan'] ?? null;

// 그림 비율 그대로 상자 안에 꽉 차게(contain) — 둥근 테두리·그림자가 그림 크기에 맞게. 모르는 크기면 상자 그대로
export function fitBox(w, h, boxW, boxH) {
  if (!(w > 0 && h > 0 && boxW > 0 && boxH > 0)) return { w: boxW, h: boxH };
  const k = Math.min(boxW / w, boxH / h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

// ---- 깜빡임 ----
export const BLINK = {
  minGap: 2500, maxGap: 7000,           // 다음 깜빡임까지
  reducedMinGap: 9000, reducedMaxGap: 16000, // 동작 줄이기: 드물게
  minClosed: 120, maxClosed: 180,       // 눈 감고 있는 시간
  doubleChance: 0.18, doubleGap: 140,   // 가끔 두 번(동작 줄이기면 안 함)
};

// rand: () => [0,1)
export function nextBlinkDelay(rand = Math.random, reduced = false) {
  const lo = reduced ? BLINK.reducedMinGap : BLINK.minGap;
  const hi = reduced ? BLINK.reducedMaxGap : BLINK.maxGap;
  return Math.round(lo + rand() * (hi - lo));
}

// 한 번의 깜빡임 = 눈 감기·뜨기 단계들. [{ closed: true, ms }, { closed: false, ms }, …] (마지막은 늘 뜬 상태로 끝)
export function blinkPlan(rand = Math.random, reduced = false) {
  const closed = () => Math.round(BLINK.minClosed + rand() * (BLINK.maxClosed - BLINK.minClosed));
  const steps = [{ closed: true, ms: closed() }];
  if (!reduced && rand() < BLINK.doubleChance) steps.push({ closed: false, ms: BLINK.doubleGap }, { closed: true, ms: closed() });
  steps.push({ closed: false, ms: 0 });
  return steps;
}

// ---- 활동 ----
export const ACTIVITIES = ['idle', 'studying', 'dancing'];
export const DANCE_MAX_MS = 15000; // 데몬이 춤 끝을 못 알려도(끊김 등) 이만큼 뒤엔 스스로 멈춘다

export function initialActivity() {
  return { studying: false, dancing: false, danceId: null, endedDance: null, connected: true };
}

// action: { type:'state', activity, runs, danceId } | { type:'danceEnd' } | { type:'connection', connected } | { type:'localDance', on }
//       | { type:'focus', active, paused }
export function activityReducer(s, a) {
  switch (a?.type) {
    case 'state': {
      const act = ACTIVITIES.includes(a.activity) ? a.activity : 'idle';
      const runs = Array.isArray(a.runs) ? a.runs.length : 0;
      const studying = act === 'studying' || (act === 'dancing' && runs > 0);
      const danceId = act === 'dancing' ? (typeof a.danceId === 'string' && a.danceId ? a.danceId : 'dance') : null;
      // 로컬에서 이미 끝낸 춤은 같은 id 로 다시 와도(재연결 등) 다시 추지 않는다
      const dancing = !!danceId && danceId !== s.endedDance;
      const danceClip = DANCE_CLIPS.includes(a.danceClip) ? a.danceClip : 'plan';
      return { ...s, studying, dancing, danceId, danceClip, connected: true };
    }
    case 'danceEnd': {
      let n = s;
      if (s.localDance) n = { ...n, localDance: false };
      if (s.dancing) n = { ...n, dancing: false, endedDance: s.danceId };
      return n;
    }
    // 앱이 스스로 추는 짧은 춤(뇌 연결 전 한 번 클릭 등) — 데몬과 끊겨 있어도 춘다
    case 'localDance':
      return { ...s, localDance: !!a.on, ...(a.on ? { localClip: DANCE_CLIPS.includes(a.clip) ? a.clip : 'dance' } : {}) };
    case 'focus':
      return { ...s, focus: a.active ? (a.paused ? 'paused' : 'on') : null };
    case 'connection':
      return a.connected ? { ...s, connected: true } : { ...initialActivity(), connected: false, endedDance: s.endedDance };
    default:
      return s;
  }
}

// 지금 틀 춤 영상 종류(viewOf 가 dancing 일 때)
export function danceClipOf(s) {
  return s.localDance ? (s.localClip ?? 'dance') : (s.danceClip ?? 'plan');
}

export function viewOf(s) {
  if (s.localDance) return 'dancing';
  if (!s.connected) return 'idle';
  return s.dancing ? 'dancing' : s.studying || s.focus === 'on' ? 'studying' : 'idle';
}
