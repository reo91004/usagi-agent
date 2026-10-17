import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 고를 수 있는 캐릭터: 시사(기본)·하치와레·랏코·모몽가·우사기 + 사용자가 만든 캐릭터(character-store.ts, ~/.cy-agent/characters/).
// 캐릭터마다 이름·말투(모델 프롬프트)·말투 양념(voice.ts)·고정 문구 기본값(phrases.ts)·AI 없이 하는 정해진 말(local-mode.ts)이 다르다.
// 그림·영상은 데스크톱이 같은 id 로 고른다(assets/characters/<id>/, 시사는 예전 그대로 assets/character/, 사용자 캐릭터는 ~/.cy-agent/characters/<id>/).
// 고르는 곳: 설정 「캐릭터」 → PUT /settings { character } → config.json character. 데몬은 setCharacter 로 바로 바꾼다.
// 사용자가 설정 「문구」에서 고친 문구는 캐릭터와 상관없이 그대로 쓴다(phrases.ts).
// 기본 캐릭터의 대사를 설정에서 고친 것(덮어쓰기)과 사용자 캐릭터는 character-store.ts 가 읽어 installCharacters 로 넣는다.

export const CHARACTER_IDS = ["shisa", "hachi", "rakko", "momonga", "usagi"] as const;
export type BuiltinId = (typeof CHARACTER_IDS)[number];
// 사용자 캐릭터 id 도 들어간다(u-xxxxxxxx). 지금 목록에 있는지는 isCharacterId 로
export type CharacterId = string;
export const DEFAULT_CHARACTER: BuiltinId = "shisa";
// 이 포크가 새 설치·지운 캐릭터 대신 고르는 캐릭터(모르는 id 를 받을 때의 DEFAULT_CHARACTER 는 시사 그대로)
export const START_CHARACTER: BuiltinId = "usagi";
export const isBuiltinId = (v: unknown): v is BuiltinId => typeof v === "string" && (CHARACTER_IDS as readonly string[]).includes(v);

export type Mood = "happy" | "excited" | "calm" | "busy";

export type Character = {
  id: CharacterId;
  custom?: boolean; // 사용자가 만든 캐릭터
  name: string; // 화면·프롬프트에 쓰는 이름
  intro: string; // 모델 프롬프트 첫 문장(누구인지)
  tone: string; // 모델 프롬프트 말투 한 줄
  // 고정 말풍선 양념(voice.ts): stretch = 「있어요」→「있어~요」, lead = 앞에 붙이는 감탄사, tail = 뒤에 붙이는 감정 표시
  stretch: boolean;
  lead?: Record<Mood, readonly string[]>;
  tail?: Record<Mood, readonly string[]>;
  phrases: Record<string, readonly string[]>; // phrases.ts 키 → 이 캐릭터의 기본 줄들(없는 키는 phrases.ts 기본값)
  lines: Partial<Record<LocalLineKey, string>>; // local-mode.ts 의 정해진 말(없는 키는 시사 말)
  cheer?: readonly string[]; // local-mode.ts 응원 칩
};

export type LocalLineKey =
  | "morning" | "lunch" | "afternoon" | "evening" | "remind" | "praise" | "empty" | "emptyHead" | "praiseDone"
  | "todayEmpty" | "todayPick" | "todayAll" | "todayNone" | "todaySome" | "todoEmpty" | "todoTop"
  | "calOff" | "calNone" | "calNow" | "calNext" | "calThen";

// 시사: 예전 말투 그대로(voice.ts TONE, character-store 기본 꼬리표, phrases.ts 기본값, local-mode.ts LINES).
// 프롬프트(brain.ts BASE 등)에 박힌 첫 문장·말투 줄은 늘 이 글이다. withCharacter 가 이 자리만 지금 캐릭터 것으로 바꾼다
// 첫 문장은 캐릭터 이름으로 소개한다(예전엔 「비서 "cy"」라 시사에게 이름을 물으면 「cy예요」라고 답했다)
export const introFor = (name: string) => `너는 사용자 개인 PC에 상주하는 비서 캐릭터 "${name}"다.`;
export const SHISA_INTRO = introFor("시사");
// 예전 시사 첫 문장 — 이 글로 저장된 덮어쓰기·사용자 캐릭터 대사는 기본 소개로 본다
export const LEGACY_SHISA_INTRO = "너는 사용자 개인 PC에 상주하는 비서 \"cy\"다.";
const ownIntro = (intro: string | undefined) => (intro && intro !== LEGACY_SHISA_INTRO ? intro : undefined);
export const SHISA_TONE = "존댓말로 짧고 다정하게. 가끔(네 번에 한 번 정도) 말끝을 '~요'처럼 늘이거나 '(기쁜 시사)' 같은 감정 표시를 붙여도 되지만, 오류·머지·결재처럼 진지한 내용에는 쓰지 않는다.";
const SHISA: Character = {
  id: "shisa",
  name: "시사",
  intro: SHISA_INTRO,
  tone: SHISA_TONE,
  stretch: true,
  tail: {
    happy: ["(스이시~사)", "(기쁜 시사)", "(뿌듯한 시사)"],
    excited: ["(들뜬 시사)", "(스이시~사)"],
    calm: ["(안심한 시사)", "(스이시~사)"],
    busy: ["(비장한 시사)", "(집중하는 시사)"],
  },
  phrases: {},
  lines: {},
};

// 시사 외 캐릭터의 말은 전부 assets/characters/lines.json 에 있다(사람이 고치는 파일 — 데스크톱도 같은 파일을 쓴다).
// 레포에서도, 앱 번들(Resources/agent/src ↔ Resources/assets)에서도 ../../assets 다
export const LINES_FILE = fileURLToPath(new URL("../../assets/characters/lines.json", import.meta.url));
// 대사 한 벌(lines.json 의 캐릭터 하나와 같은 모양). canned·setup·overlay·tour 는 데스크톱만 쓴다
export type LinesEntry = {
  name: string;
  prompt: { intro: string; tone: string; persona: string };
  flair: { lead?: Partial<Record<Mood, string[]>>; tail?: Partial<Record<Mood, string[]>> };
  phrases: Record<string, string[]>;
  local: Partial<Record<LocalLineKey, string>>;
  cheer: string[];
  canned?: Record<string, string[]>;
  setup?: Record<string, string>;
  overlay?: Record<string, string>;
  tour?: Record<string, string>;
};
// 일부만 있는 대사(덮어쓰기 파일 · 사용자 캐릭터에서 빠진 칸)
export type LinesPatch = { [K in keyof LinesEntry]?: LinesEntry[K] extends string | string[] ? LinesEntry[K] : Partial<LinesEntry[K]> };
export const LINES_JSON = JSON.parse(readFileSync(LINES_FILE, "utf8")) as Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// 대사 합치기: 칸(묶음) 안은 키마다 뒤의 것이 이긴다(flair 는 lead·tail 안의 기분마다). 배열·글은 통째로 바뀐다
export function mergeLines<T>(base: T, over: unknown): T {
  if (!isObj(over)) return base;
  const out: Record<string, unknown> = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = isObj(v) && isObj(out[k]) ? mergeLines(out[k], v) : v;
  }
  return out as T;
}

const nonEmpty = <R extends object>(r?: R) => (r && Object.keys(r).length ? r : undefined);
function fromLines(id: CharacterId, e: Partial<LinesEntry>, extra: Partial<Character> = {}): Character {
  return {
    id, name: e.name || id, intro: ownIntro(e.prompt?.intro) || (e.name ? introFor(e.name) : SHISA_INTRO), tone: e.prompt?.tone || SHISA_TONE, stretch: false,
    lead: nonEmpty(e.flair?.lead) as Character["lead"], tail: nonEmpty(e.flair?.tail) as Character["tail"],
    phrases: e.phrases ?? {}, lines: e.local ?? {}, cheer: e.cheer?.length ? e.cheer : undefined, ...extra,
  };
}

// 고치지 않은 기본 캐릭터(시사 상수는 voice.ts TONE, character-store 기본 꼬리표 가 이걸 본다)
export const CHARACTERS: Record<BuiltinId, Character> = {
  shisa: SHISA,
  hachi: fromLines("hachi", LINES_JSON.hachi as LinesEntry),
  rakko: fromLines("rakko", LINES_JSON.rakko as LinesEntry),
  momonga: fromLines("momonga", LINES_JSON.momonga as LinesEntry),
  usagi: fromLines("usagi", LINES_JSON.usagi as LinesEntry),
};

// 시사를 고친 것: 고친 칸만 바뀌고 나머지는 시사 기본(문구·정해진 말은 phrases.ts·local-mode.ts 기본값이 받는다)
function shisaWith(o: LinesPatch): Character {
  return {
    ...SHISA,
    name: o.name || SHISA.name,
    intro: ownIntro(o.prompt?.intro) || (o.name && o.name !== SHISA.name ? introFor(o.name) : SHISA.intro), // 이름만 바꿨으면 새 이름으로 소개
    tone: o.prompt?.tone || SHISA.tone,
    lead: nonEmpty(o.flair?.lead) as Character["lead"],
    tail: (o.flair?.tail ? nonEmpty(o.flair.tail) : SHISA.tail) as Character["tail"],
    phrases: o.phrases as Record<string, string[]> ?? {},
    lines: o.local ?? {},
    cheer: o.cheer?.length ? o.cheer : undefined,
  };
}

// 지금 쓰는 목록: 기본 다섯(덮어쓰기 반영) + 사용자 캐릭터(만든 순서)
let table: Record<string, Character> = { ...CHARACTERS };
let order: string[] = [...CHARACTER_IDS];
export const isCharacterId = (v: unknown): v is CharacterId => typeof v === "string" && Object.hasOwn(table, v);

// character-store.ts 가 시작할 때·바뀔 때 부른다. 지금 캐릭터가 사라졌으면 시사로(돌려준 값이 true)
export function installCharacters(o: { overrides?: Record<string, LinesPatch>; users?: { id: string; lines: Partial<LinesEntry> }[] }): boolean {
  const next: Record<string, Character> = {};
  for (const id of CHARACTER_IDS) {
    const ov = o.overrides?.[id];
    next[id] = !ov ? CHARACTERS[id] : id === "shisa" ? shisaWith(ov) : fromLines(id, mergeLines(LINES_JSON[id] as LinesEntry, ov));
  }
  const users = (o.users ?? []).filter((u) => !isBuiltinId(u.id) && !Object.hasOwn(next, u.id));
  for (const u of users) next[u.id] = fromLines(u.id, u.lines, { custom: true });
  table = next;
  order = [...CHARACTER_IDS, ...users.map((u) => u.id)];
  if (isCharacterId(current)) return false;
  current = DEFAULT_CHARACTER;
  return true;
}

let current: CharacterId = DEFAULT_CHARACTER;
// config.json character(모르는 값이면 시사). 설정이 바꾸면 Settings 가 다시 부른다 — 다음 말풍선·답부터 바로
export function setCharacter(id: unknown): CharacterId {
  current = isCharacterId(id) ? id : DEFAULT_CHARACTER;
  return current;
}
export const characterId = (): CharacterId => current;
export const character = (): Character => table[current] ?? SHISA;
export const characterOptions = () => order.map((id) => ({ id, name: table[id].name, ...(table[id].custom ? { custom: true } : {}) }));

// 프롬프트의 시사 첫 문장+말투(brain.ts BASE)를 지금 캐릭터 것으로 바꾼다. 시사 그대로면 글자 하나 안 바뀐다(프롬프트 캐시도 그대로).
// 바꾸는 건 이 두 자리뿐이다: 사용자가 쓴 말투라도 그 밖의 규칙·안전 지시는 건드리지 못한다(한 번에 바꿔서 새 글 안의 글자를 다시 바꾸지 않는다)
export function withCharacter(system: string): string;
export function withCharacter(system: string | undefined): string | undefined;
export function withCharacter(system: string | undefined): string | undefined {
  if (!system) return system;
  const c = character();
  if (c.intro === SHISA_INTRO && c.tone === SHISA_TONE) return system;
  return system.split(`${SHISA_INTRO} ${SHISA_TONE}`).map((part) => part.split(SHISA_TONE).join(c.tone)).join(`${c.intro} ${c.tone}`);
}
