// 패널 렌더러 — 대시보드(개요·작업 폴더·할 일·오늘 할 일)와 채팅. 네트워크는 전부 메인을 거친다.
import DOMPurify from './vendor/purify.js';
import { Marked } from './vendor/marked.js';
import { createMarkdown } from '../src/markdown.js';
import { shapeDashboard, shapeGpu, overlayHidden, priorityLabel, priorityHint, SECTIONS, SECTION_LABELS, normalizeSection, navGroups, relativeTime, clockTime } from '../src/dashboard.js';
import { candidateHosts } from '../src/folders.js';
import { needsSetup } from '../src/setup.js';
import { REPO_SLUG } from '../src/update-check.js';
import { agentSteps } from '../src/setup-flow.js';
import { renderSetup, clearApiDraft, readSlot, clearSlot } from './setup-view.js';
import { mountModels } from './models-view.js';
import { navIcon } from './nav-icons.js';
import { createFocusView } from './focus-view.js';
import { connectorAction, connectorDisconnectCopy, disconnectControl } from '../src/disconnect.js';
import { CANNED, cannedReply, connectSteps, hubItem, slotOk, EXTRAS } from '../src/ai-onboard.js';
import { SETUP_FLOW_VERSION, isSetupPhase, phaseAfterBrain, backPhase, restorePhase, NO_AI } from '../src/setup-plan.js';
import { brainView, connectCard, chatLock } from '../src/brain-state.js';
import { initialChat, chatReducer, isBusy, isRunning, busyLabel, busyThreads, sendButton, stopTargets, localState, queuedChats, queuedLabel, sentLabel } from '../src/chat.js';
import { stamp, withDayDividers } from '../src/chat-time.js';
import { KIND_ICONS, KIND_LABELS, normThread, normThreads, upsertThread, groupThreads, filterThreads, initSeen, isUnread, markSeen, pruneSeen, unreadCount, pickInitial, neighborThread, afterRemoval, mergeMessages, appendLocal, tagLocal, dropLocal, dropFailed, markSent, isDoubleSend, todoChip, okThreadId, editTarget, dropFrom } from '../src/threads.js';
import { PRIORITIES, mergeRecentDone, newTodoBody, overlayTodos, descriptionPatch, isDoing, patchToday, isToday } from '../src/todos.js';
import { createClickSorter, toggleOpen, dropTarget, autoScrollDelta, reorderLocal, isNoopMove, keyMove, detailView, SOURCE_LABELS, dueChip, LONG_PRESS, MOVE_SLOP } from '../src/todo-rows.js';
import { openEdit, fillDescription, editKey, editPatch } from '../src/todo-edit.js';
import { originPlan, todoPlan } from '../src/origin.js';
import { trashModel, commitTrash, trashItemOf, todoBodyOf, confirmReducer, isConfirming, confirmKey, isTrashKey, createUndo, readTrashOpen, writeTrashOpen, overTrash, CONFIRM_TEXT, UNDO_MS } from '../src/todo-trash.js';
import { BACKLOG, rulesChip, overlayRules, hitsLabel, readBacklogOpen, writeBacklogOpen, isCollapsed } from '../src/todo-rules.js';
import { attachSlashMenu } from './slash-menu.js';
import { createAttachTray } from './attach-tray.js';
import { attachUrl, chipView, attachSummary } from '../src/attachments.js';
import { cleanModels } from '../src/session.js';
import { normalizeActions, upsertAction, placeActions, cardView, decideResult, aroundAnswer, foldedPermission, foldApprovals } from '../src/actions.js';
import { normalizePermissionRules, ruleUsage, withoutPending } from '../src/permissions.js';
import { normAgents, agentStrip, agentCard, canStopAgent, placeAgents, agentsSig, normSessions, sessionCard, placeSessions, sessionsSig, sessionsPlaceSig } from '../src/agents.js';
import { characterAssets, okCharacter, appName, START_CHARACTER } from '../src/character.js';
import { applyCharacters } from '../src/character-registry.js';
import { createNodeCache, pendingShape, planRender, createPoller } from '../src/render-sched.js';
import { who, whoId, setWho, onWho } from './who.js';
import { normWorktrees, worktreeCard, openTarget, placeWorktrees, worktreesSig, worktreesPlaceSig } from '../src/worktrees.js';

const cy = window.cy;
const $ = (id) => document.getElementById(id);

if (new URLSearchParams(location.search).get('vibrancy') === '1') document.body.classList.add('vibrant');

const brand = $('brand-img');
// 사이드바 아이콘: 고른 캐릭터(눈 뜬 기본 표정) → 번들 png → svg. 캐릭터는 데몬 state(메인이 'character' 로 알린다)
let character = START_CHARACTER;
let wantChar = START_CHARACTER; // 데몬이 고른 id 그대로(사용자 캐릭터는 목록을 받은 뒤에 안다)
let BRAND_SRCS = [];
let brandAt = 0;
function setBrand(id) {
  wantChar = id;
  character = okCharacter(id);
  setWho(character);
  $('brand-name').textContent = appName(character);
  const conn = $('conn'); // 켜짐·꺼짐 글(연결 상태는 클래스로 — connected 변수는 아래에서 선언된다)
  if (conn) { conn.textContent = `${who()} ${conn.classList.contains('off') ? '꺼짐' : '켜짐'}`; conn.title = conn.textContent; }
  const a = characterAssets(character);
  BRAND_SRCS = [a.retina ? a.open.replace(/\.png$/, '@2x.png') : a.open, ...a.stills.slice(1)];
  brandAt = 0;
  brand.src = BRAND_SRCS[0];
}
brand.addEventListener('error', () => { if (brandAt < BRAND_SRCS.length - 1) brand.src = BRAND_SRCS[++brandAt]; });
setBrand(START_CHARACTER);
cy.getCharacter?.().then((id) => { if (typeof id === 'string' && id !== character) setBrand(id); }).catch(() => {});
cy.onCharacter?.((p) => { if (typeof p?.id === 'string' && p.id !== character) setBrand(p.id); });
// 사용자 캐릭터·고친 대사(src/character-registry.js): 받을 때마다 다시 그린다(이름·그림·정해진 말)
const takeCharacters = (data) => { if (data && applyCharacters(data)) setBrand(wantChar); };
cy.getCharacters?.().then(takeCharacters).catch(() => {});
cy.onCharacters?.(takeCharacters);

// ---- 마크다운: marked(원시 HTML 막음) → DOMPurify ----
const toHtml = createMarkdown(Marked);
const PURIFY = {
  ALLOWED_URI_REGEXP: /^(?:https?|slack):/i,
  FORBID_TAGS: ['style', 'img', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio'],
  FORBID_ATTR: ['style'],
};
function md(el, src) {
  el.classList.add('md');
  el.innerHTML = DOMPurify.sanitize(toHtml(src), PURIFY);
  return el;
}
// 링크는 전부 메인에서 외부로 연다(메인이 스킴 한 번 더 확인)
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  cy.openLink(a.getAttribute('href'));
});

// 작은 DOM 헬퍼: h('div.card', {onclick}, '글자', child)
function h(sel, props, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
// 집중하기: 할 일 목록의 [집중하기] · 맨 아래 「오늘 집중」 · 주·월 기록(focus-view.js)
const focusView = createFocusView({ h, cy });
$('focus-slot').append(focusView.bar('header')); // 머리의 [집중하기]: 어느 화면에서든(상태는 focus-view 하나)

// replaceChildren 에 null 을 넣으면 화면에 "null" 글자가 찍힌다
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((c) => c != null && c !== false));
}

// ---- 상태 ----
let raw = null; // 마지막 /dashboard 응답
let flash = null; // { id, until } — 잠깐 강조할 할 일 줄(할 일 id) 또는 제안('proposal:<id>')
let vm = shapeDashboard(null);
let error = null;
let connected = false;
// 이 컴퓨터의 Claude Code·Codex(모르면 있다고 본다)
let caps = { claude: null, codex: null, agy: null };
const hasCoder = () => (caps.code ?? caps.claude) !== false; // 코드 고치기(main 이 데몬 features.code 를 붙여 준다)
let section = 'overview';
try { section = normalizeSection(localStorage.getItem('section')) ?? 'overview'; } catch { /* 저장소 없음 */ }
let setupPhase = 'name'; // name·brain·ai-key·extras·connect·done (setup-plan.js — 키·토큰은 저장하지 않는다)
let setupName = ''; // 데몬 설정 user.name
let setupRepos = []; // 데몬 설정 repoRoots
let setupReadSessions = false; // 데몬 설정 readSessions(이 맥의 Claude Code·Codex 작업 기록 읽기: 새 설치는 꺼짐)
let detected = { claude: null, codex: null, agy: null }; // 이 맥에서 찾은 Claude Code·Codex(로그인까지)
// 뇌(말 거는 AI) 연결 상태 — main 이 GET /status 로 알려 준다(brain-state.js brainView). 모르면 막지 않는다
let brain = { ready: true, known: false, connected: [] };
let connectCardHidden = false; // AI 연결 안내 카드를 숨겼나(state.json connectCardHidden)
let setupCursor = 0;
let setupLink = '';
let keyStatus = '';
let keyNote = ''; // 키는 맞지만 알릴 말(Genspark 무료 플랜 → 크레딧 필요)
let gskFound = false; // gsk login 한 Genspark 키가 이 맥에 있나
let afterConnect = ''; // 'claudecode'·'codexcli': 그 도구 연결을 마치면 시사의 AI로 쓴다
let setupCalendars = []; // 연결된 캘린더(main calendar-list: 가린 이름만, 주소 없음)
// 이 Mac 의 캘린더·미리알림 상태(GET /apple/status). 설치 화면이 보이는 동안 허락 창을 기다리면(pending) 2초,
// 데몬이 안 닿으면 10초 간격으로 다시 묻고, 화면을 떠나거나 창이 숨겨지면 멈춘다
let setupApple = null;
const panelShown = () => document.visibilityState !== 'hidden';
const appleWatch = createPoller(async () => {
  let r;
  try { r = await cy.appleStatus(); } catch { r = null; }
  const next = r?.ok ? r.data : setupApple; // 데몬이 다시 켜지는 중이면 예전 값 그대로
  if (JSON.stringify(next) !== JSON.stringify(setupApple)) { setupApple = next; setupKey = ''; if (section === 'setup') renderSetupView(false); }
  return r?.ok ? next : null;
}, (res) => (section !== 'setup' || !panelShown() ? null : res === null ? 10_000 : res?.pending ? 2000 : null));
function loadApple() { appleWatch.stop(); appleWatch.start(); }
let setupSlotError = null; // 저장하려다 막힌 칸 값({ id, value, text }, 예: 이미 연결된 캘린더)
let cannedOpen = false; // 채팅: AI가 있을 때 ＋ 로 연 정해진 답 버튼 줄(renderChatLock)
let sisa = { provider: '', hasKey: false, persona: '', canned: {}, done: {}, connected: [], chatModels: {}, codeModel: 'default' };
// 예전 화면 위치(ai-offer·agent·pick·walk)는 불러오지 않는다(restorePhase 가 처음으로)
try {
  setupPhase = restorePhase(localStorage.getItem('setupPhase'));
  const cursor = Number(localStorage.getItem('setupCursor'));
  if (Number.isInteger(cursor) && cursor >= 0) setupCursor = cursor;
  const link = localStorage.getItem('setupLink');
  if (typeof link === 'string') setupLink = link;
  if (localStorage.getItem('setupFlowVersion') !== SETUP_FLOW_VERSION) {
    setupPhase = 'name';
    setupCursor = 0;
    localStorage.setItem('setupFlowVersion', SETUP_FLOW_VERSION);
    localStorage.removeItem('setupDone');
  }
} catch { /* 저장소 없음 */ }
let setupKey = '';

function saveSetup() {
  try {
    localStorage.setItem('setupPhase', setupPhase);
    localStorage.setItem('setupCursor', String(setupCursor));
    localStorage.setItem('setupLink', setupLink);
  } catch { /* 무시 */ }
}

// 뇌 고르기 화면에 들어갈 때: 이 맥의 Claude Code·Codex 로그인 확인 + 데몬 설정(이름·레포 폴더)
async function detectAgents() {
  const one = async (who) => { try { return !!(await cy.agentLogin(who))?.loggedIn; } catch { return null; } };
  const [c, x, g] = await Promise.all([one('claude'), one('codex'), one('agy')]);
  if (c === detected.claude && x === detected.codex && g === detected.agy) return;
  detected = { claude: c, codex: x, agy: g };
  setupKey = '';
  if (section === 'setup') renderSetupView(false);
}
async function loadSetupSettings() {
  let r = null;
  try { r = await cy.setupLoad?.(); } catch { /* 데몬이 꺼져 있으면 빈 칸 */ }
  if (!r?.ok) return;
  setupName = r.name || '';
  setupRepos = Array.isArray(r.repoRoots) ? r.repoRoots : [];
  setupReadSessions = r.readSessions === true;
  setupKey = '';
  if (section === 'setup') renderSetupView(false);
}
async function saveSetupSettings(patch) {
  let r = null;
  try { r = await cy.setupSave?.(patch); } catch { /* 아래 */ }
  if (r?.ok) {
    if (typeof r.name === 'string') setupName = r.name;
    if (Array.isArray(r.repoRoots)) setupRepos = r.repoRoots;
    if (typeof r.readSessions === 'boolean') setupReadSessions = r.readSessions;
  }
  return !!r?.ok;
}

function stepsNow() {
  if (setupPhase === 'connect') {
    return (setupLink === 'claude' || setupLink === 'codex' || setupLink === 'agy') ? agentSteps(setupLink) : connectSteps(setupLink);
  }
  return [];
}

// 연결된 캘린더 목록을 새로. 바뀌었을 때만 다시 그린다
async function loadCalendars() {
  let r = null;
  try { r = await cy.calendarList?.(); } catch { /* 다음에 다시 */ }
  const items = Array.isArray(r?.items) ? r.items : [];
  if (JSON.stringify(items) === JSON.stringify(setupCalendars)) return;
  setupCalendars = items;
  setupKey = '';
  if (section === 'setup') renderSetupView(false);
}

function clampSetupCursor() {
  const n = stepsNow().length;
  if (n === 0) return;
  if (setupCursor < 0) setupCursor = 0;
  else if (setupCursor >= n) setupCursor = n - 1;
}
let setupAsked = false;
let chat = initialChat();

// ---- 탭 ----
// 사이드바는 SECTIONS 에서 만든다: 위쪽은 자주 쓰는 화면, 맨 아래는 설정. 설치는 머리의 [설치] 단추로 연다
const nav = $('nav');
const navBottom = $('nav-bottom');
const badges = {};
const navGroup = navGroups(SECTIONS);
for (const s of SECTIONS) badges[s] = h('span.badge');
badges.setup = $('setup-badge'); // 머리의 [설치] 단추 위
for (const [box, ids] of [[nav, navGroup.main], [navBottom, navGroup.bottom]]) {
  for (const s of ids) box.append(h('button', { type: 'button', role: 'tab', dataset: { section: s }, onclick: () => goto(s) }, navIcon(s), h('span', { text: SECTION_LABELS[s] }), badges[s]));
}
const navButtons = () => [...nav.children, ...navBottom.children];
$('open-setup').addEventListener('click', () => openSetup());

// ---- 설정 화면: 안쪽 탭(AI·캐릭터·알림·연결·작업 규칙·이 앱). settings.js 는 처음 열 때 불러온다 ----
const SETTINGS_TABS = ['ai', 'char', 'notify', 'conn', 'rules', 'app'];
let settingsTab = 'ai';
try { const t = localStorage.getItem('settingsTab'); if (SETTINGS_TABS.includes(t)) settingsTab = t; } catch { /* 저장소 없음 */ }
let settingsMod = null;
function showSettingsTab(t) {
  if (SETTINGS_TABS.includes(t)) settingsTab = t;
  try { localStorage.setItem('settingsTab', settingsTab); } catch { /* 무시 */ }
  for (const b of $('set-tabs').children) b.setAttribute('aria-selected', String(b.dataset.tab === settingsTab));
  for (const p of $('sec-settings').querySelectorAll('.set-pane')) p.hidden = p.dataset.tab !== settingsTab;
  if (settingsTab === 'ai') loadSisa();
  settingsMod?.tabShown(settingsTab);
}
for (const b of $('set-tabs').children) b.addEventListener('click', () => showSettingsTab(b.dataset.tab));
async function enterSettings() {
  showSettingsTab(settingsTab);
  if (settingsMod) { settingsMod.refresh(); return; }
  settingsMod = await import('./settings.js'); // 처음 불러올 때 스스로 데몬에서 읽어 온다
  settingsMod.setNav({ setup: () => openSetup('extras'), aiTab: () => showSettingsTab('ai'), connectionsChanged: loadSoon });
}

function goto(s) {
  const prevSection = section;
  if (s === 'models') settingsTab = 'ai'; // 예전 「모델」 탭
  section = normalizeSection(s) ?? section;
  if (!SECTIONS.includes(section)) section = 'overview';
  try { localStorage.setItem('section', section); } catch { /* 무시 */ }
  for (const b of navButtons()) b.setAttribute('aria-selected', String(b.dataset.section === section));
  $('open-setup').classList.toggle('on', section === 'setup');
  for (const x of SECTIONS) $(`sec-${x}`).hidden = x !== section;
  $('content').classList.toggle('fill', section === 'chat');
  $('content').classList.toggle('chat-on', section === 'chat');
  $('content').classList.toggle('setup-on', section === 'setup'); // 설치: 버튼 줄은 맨 아래 고정, 내용만 스크롤
  $('title').textContent = SECTION_LABELS[section];
  if (section !== 'setup') { appleWatch.stop(); stopLoginWatch(); }
  if (dirtySecs.has(section)) renderAll(); // 숨어 있는 동안 밀린 그리기
  if (section === 'setup') {
    renderSetupView(true);
    loadSetupSettings();
    if (setupPhase === 'brain') detectAgents();
  }
  if (section === 'settings') enterSettings();
  if (section === 'chat') {
    flushChat();
    scrollChat(true);
    renderChatLock();
    afterThreadsChanged(); // 보고 있는 대화는 읽음
    if (brain.ready !== false) $('chat-input').focus();
    requestAnimationFrame(() => autosize()); // 숨어 있는 동안 못 잰 입력창 높이(모듈 초기화 뒤에 돈다)
  } else if (isListSection() && todosStale && !todoInputFocused()) {
    renderTodos(); // 입력 중이라 미뤄둔 다시 그리기가 남아 있으면 지금
  }
}

// 사이드바에는 SECTIONS 에 있는 탭만 보인다
function renderNav() {
  for (const b of navButtons()) b.hidden = !SECTIONS.includes(b.dataset.section);
}

function renderBadges() {
  const { stats } = vm;
  badges.projects.textContent = vm.projects.length || '';
  badges.todos.textContent = stats.openTodos || '';
  badges.todos.classList.toggle('hot', stats.p1Todos > 0);
  badges.overview.textContent = stats.pendingProposals || '';
  const broken = vm.connectors.filter((c) => c.mode !== 'off' && !c.ready).length;
  badges.setup.className = !broken && needsSetup(vm.connectors) ? 'badge dot' : 'badge';
  badges.setup.classList.toggle('hot', broken > 0);
  badges.setup.textContent = broken || '';
  // 채팅: 답하는 중이면 점, 아니면 안 읽은 대화 수
  const unread = seenLoaded ? unreadCount(seen, threads, section === 'chat' ? selectedId : null) : 0;
  badges.chat.className = isBusy(chat) ? 'badge dot' : 'badge';
  badges.chat.textContent = isBusy(chat) ? '' : unread || '';
}

// ---- 데이터 ----
let loading = false;
let again = false;
async function load() {
  if (loading) { again = true; return; }
  loading = true;
  let r;
  try { r = await cy.getDashboard(); } catch { r = { ok: false }; }
  loading = false;
  if (r?.ok && r.data && typeof r.data === 'object') {
    raw = r.data;
    error = null;
  } else {
    error = r?.error && !r?.status ? `${who()}에 연결되지 않았어요.` : `대시보드를 못 가져왔어요 (HTTP ${r?.status ?? '?'})`;
  }
  renderAll();
  if (again) { again = false; load(); }
}

let loadTimer = null;
const loadSoon = () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 250); };


// 구역별 그리기: 보이는 구역만 지금 그리고 나머지는 dirtySecs 에 두었다가 들어갈 때(goto)·창이 다시 보일 때 그린다
const SECTION_RENDERERS = { overview: () => renderOverview(), research: () => renderResearch(), projects: () => renderProjects(), todos: () => renderTodos(), settings: () => renderSettingsConnectors() };
const dirtySecs = new Set();
function renderAll() {
  const todos = raw ? overlayTodos(raw.todos, pendingOps) : null;
  vm = shapeDashboard(raw ? { ...raw, todos, projects: overlayHidden(raw.projects, hidePending) } : null, Date.now());
  if (openId && todos && !todos.some((t) => t.id === openId)) openId = null; // 끝났거나 지워진 할 일은 접는다
  $('banner').hidden = !error || section === 'setup';
  $('banner').textContent = error ?? '';
  $('updated').textContent = vm.generatedAt ? `${relativeTime(vm.generatedAt)} 갱신` : '';
  renderNav();
  maybeOpenSetup();
  renderSetupView(false);
  const plan = planRender(Object.keys(SECTION_RENDERERS), section, !panelShown());
  for (const s of plan.dirty) dirtySecs.add(s);
  for (const s of plan.now) { dirtySecs.delete(s); SECTION_RENDERERS[s](); } // 할 일 화면은 맨 위 「오늘」 묶음까지
  renderBadges();
  renderThreadHead(); // 할 일 대화의 할 일 칩
}

// 잠깐 띄우는 오류(연결 오류가 있으면 그게 먼저)
let bannerTimer = null;
function setBanner(text) {
  if (error) return;
  clearTimeout(bannerTimer);
  $('banner').hidden = false;
  $('banner').textContent = text;
  bannerTimer = setTimeout(() => { if (!error) $('banner').hidden = true; }, 5000);
}

// ---- 개요 ----
function stat(num, label, sub, hot, live) {
  return h(`div.card.stat${hot ? '.hot' : ''}`, null, h('div.num', { text: String(num), dataset: live ? { focusToday: '' } : undefined }), h('div.label', { text: label }), sub ? h(`div.sub${hot ? '.hot' : ''}`, { text: sub }) : null);
}

// 개요 맨 위 인사: 시간대 인사 + 오늘 날짜
function greeting() {
  const now = new Date();
  const hr = now.getHours();
  const hello = hr < 5 ? '늦은 시간이에요' : hr < 12 ? '좋은 아침이에요' : hr < 18 ? '좋은 오후예요' : '좋은 저녁이에요';
  return h('div.greet', null, h('h1.greet-hello', { text: hello }), h('span.greet-date', { text: now.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }) }));
}

// 오늘 일정 한 줄: 시각 · 제목(회의 링크가 있으면 눌러서 열기) · 끝난 건 흐리게
function meetingRow(m) {
  return h(`div.meeting${m.past ? '.past' : ''}`, null,
    h('span.mt-time', { text: m.endTime ? `${m.time}–${m.endTime}` : m.time }),
    h('span.mt-title', { text: m.subject }),
    m.link ? h('a.small', { href: m.link, text: '참여' }) : null);
}

const PROPOSAL_LABEL = { pending: '대기', approved: '승인', held: '보류', running: '진행 중', done: '완료', failed: '실패' };
const PROPOSAL_CHIP = { pending: 'accent', running: 'warn', done: 'ok', failed: 'err' };

const briefMd = createNodeCache(); // 브리핑 마크다운은 글이 같으면 다시 파싱하지 않는다
function renderOverview() {
  const { stats, briefing, today, proposals, meetings } = vm;
  const el = $('sec-overview');
  const nextMeeting = meetings.find((m) => !m.past);
  const openToday = (today?.items ?? []).filter((it) => !it.done);
  el.replaceChildren(...[ // null(제안 없음 등)은 빼야 'null' 글자로 안 찍힘
    greeting(),
    h('div.stats', null,
      stat(meetings.length, '오늘 일정', nextMeeting ? `다음 ${nextMeeting.time} ${nextMeeting.subject}` : meetings.length ? '모두 끝났어요' : null),
      stat(stats.openTodos, '이번 주 할 일', stats.p1Todos ? `P1 ${stats.p1Todos}개` : 'P1 없음', stats.p1Todos > 0),
      stat(focusView.todayText(), '오늘 집중', null, false, true),
      stat(stats.pendingProposals, '대기 중 제안', null)),
    connected ? null : h('div.card.empty', { text: `${who()}가 꺼져 있어요. 켜지면 여기 채워져요.` }),
    researchSummaryCard(),
    meetings.length ? h('h2', { text: '오늘 일정' }) : null,
    meetings.length ? h('div.card.meetings', null, meetings.map(meetingRow)) : null,
    h('h2', null, h('span', { text: '오늘 할 일 ' }),
      h('span.chip.click', { text: openToday.length ? `남은 ${openToday.length}개` : '아직 없음', role: 'button', onclick: () => goto('todos') })),
    openToday.length
      ? h('div.card.today-short', null,
        openToday.slice(0, 5).map((it) => h('button.today-item', { type: 'button', onclick: () => goto('todos') },
          h('span.ti-dot', { 'aria-hidden': 'true' }), h('span.ti-title', { text: it.title }))),
        openToday.length > 5 ? h('div.muted.small.ti-more', { text: `외 ${openToday.length - 5}개` }) : null)
      : null,
    h('h2', null, h('span', { text: '최근 브리핑 ' }),
      h('button.ghost.small', { type: 'button', text: '지금 브리핑', onclick: async (ev) => {
        const b = ev.currentTarget; b.disabled = true; b.textContent = '브리핑 중…';
        const r = await cy.briefingNow().catch(() => ({ ok: false }));
        b.textContent = r?.ok ? '시작했어요' : '연결 안 됨';
        setTimeout(() => { b.disabled = false; b.textContent = '지금 브리핑'; }, 4000);
      } })),
    briefing
      ? h('div.card', null,
        h('div.row.briefing-head', null, h('span.chip.accent', { text: `${briefing.time} · ${briefing.rel}` }), briefing.bubble ? h('span.muted', { text: briefing.bubble }) : null),
        briefMd.get('briefing', briefing.md || briefing.bubble, () => md(h('div'), briefing.md || briefing.bubble)))
      : h('div.card.empty', { text: '아직 브리핑이 없어요.' }),
    proposals.length ? h('h2', { text: '제안' }) : null,
    proposals.length
      ? h('div.card', null, proposals.map((p) => h(`div.proposal${flash?.id === `proposal:${p.id}` && Date.now() < flash.until ? '.flash' : ''}`, { dataset: { id: p.id } },
        h(`span.chip.${PROPOSAL_CHIP[p.status] ?? 'x'}`, { text: PROPOSAL_LABEL[p.status] ?? p.status }),
        h('span.t', { text: p.title, title: p.result || p.title }),
        p.repo ? h('span.muted.small', { text: p.repo }) : null,
        /^https:\/\//.test(p.result) ? h('a', { href: p.result, text: 'PR' }) : null)))
      : null,
    permissionsSection(),
  ].filter((c) => c != null && c !== false));
  briefMd.end();
}

// ---- 연구 카드(#40) — 실험 서버·연구 노트를 연결했을 때만 개요 맨 위에. 설정 토글 없이 연결이 곧 켜짐 ----
// GPU 는 [GPU 보기]를 누를 때만 서버에 묻는다(패널을 열 때마다 ssh 하지 않게). 받은 건 다시 그려도 남긴다
let gpu = { loading: false, at: '', hosts: null, err: '' };
async function loadGpu() {
  if (gpu.loading) return;
  gpu = { ...gpu, loading: true, err: '' };
  renderResearch();
  let r;
  try { r = await cy.researchGpu(); } catch { r = { ok: false }; }
  gpu = r?.ok && Array.isArray(r.data?.hosts) ? { loading: false, at: str(r.data.at), hosts: shapeGpu(r.data.hosts), err: '' } : { ...gpu, loading: false, err: `가져오지 못했어요 — ${why(r)}` };
  renderResearch();
}
const str = (v) => (typeof v === 'string' ? v : '');
// 실험 줄 [물어보기]: 새 대화에 질문을 채워 두고 보내기는 사용자가
function askAbout(text) {
  newChat();
  chatInput.value = text;
  autosize();
}
async function openNote(day, btn) {
  btn.disabled = true;
  const r = await cy.researchNoteOpen(day).catch(() => ({ ok: false }));
  btn.disabled = false;
  if (!r?.ok) btn.textContent = '못 열었어요';
}
// 막대 채움: CSP(style-src 'self')가 style 속성은 막지만 CSSOM 은 된다
function barFill(pct) {
  const el = h('span');
  el.style.width = `${pct}%`;
  return el;
}
function gpuBlock() {
  const head = h('div.row.gpu-head', null,
    h('span.muted.small', { text: gpu.hosts ? `GPU · ${relativeTime(gpu.at)}` : 'GPU' }), h('span.spacer'),
    h('button.ghost.small', { type: 'button', text: gpu.loading ? '가져오는 중…' : gpu.hosts ? '다시 보기' : 'GPU 보기', disabled: gpu.loading, onclick: loadGpu }));
  const rows = (gpu.hosts ?? []).map((x) => h('div.gpu-host', null,
    h('div.gpu-hostname', null, h('span', { text: x.host }), x.ok ? null : h('span.muted', { text: ` · ${x.error}` })),
    ...x.gpus.map((g) => h('div.gpu-row', null,
      h('div.gpu-line', null,
        h('span.gpu-name', { text: `GPU${g.idx} ${g.name}`, title: g.name }),
        h('span.gpu-bar', { title: `사용률 ${g.util}%`, role: 'img', 'aria-label': `사용률 ${g.util}%` }, barFill(g.util)),
        h('span.gpu-num', { text: `${g.util}% · ${g.mem} · ${g.temp}°C` })),
      ...g.procs.map((p) => h('div.gpu-proc.muted.small', { text: `${p.mem}${p.etime ? ` · ${p.etime}째` : ''} · ${p.cmd}`, title: `pid ${p.pid} · ${p.cmd}` })))),
    x.ok && !x.gpus.length ? h('div.muted.small', { text: 'GPU 가 보이지 않아요' }) : null));
  return h('div.gpu', null, head, gpu.err ? h('div.result.err.small', { role: 'status', text: gpu.err }) : null, ...rows);
}
const jobBusy = new Set();
async function forgetJob(id) {
  if (jobBusy.has(id)) return;
  jobBusy.add(id);
  renderResearch();
  const r = await cy.researchJobForget(id).catch(() => ({ ok: false }));
  jobBusy.delete(id);
  if (r?.ok || r?.status === 404) vm.research.jobs = vm.research.jobs.filter((j) => j.id !== id);
  renderResearch();
}
function tmuxBlock(t) {
  return h('div.tmux-host', null,
    h('div.gpu-hostname', null, h('span', { text: `${t.host} · tmux` }), h('span.muted', { text: ` · ${t.rel} 확인` })),
    t.sessions.length
      ? t.sessions.map((x) => h('div.job-row', null,
        h(`span.chip${x.chip ? `.${x.chip}` : ''}`, { text: x.label }),
        h('div.job-main', null,
          h('div.job-name', { text: x.name, title: x.path }),
          h('div.muted.small.job-sub', { text: [x.time, x.path].filter(Boolean).join(' · '), title: x.path }))))
      : h('div.muted.small', { text: '내 tmux 세션이 없어요' }));
}
// 서버 실험: 서버별 tmux 세션 + usagi-run 기록 + GPU
function researchSection() {
  const r = vm.research;
  if (!r) return null;
  const out = [h('h2', null, h('span', { text: '서버 실험 ' }), r.hosts.length ? h('span.muted.small', { text: r.hosts.join(', ') }) : null)];
  if (r.hosts.length || r.jobs.length) {
    out.push(h('div.card.research-jobs', null,
      h('div.muted.small.research-hint', { text: '끝·실패는 usagi-run 으로 돌린 작업의 종료 기록이에요. tmux 는 지금 돌고 있는지만 보여요. 여러 사람이 쓰는 서버(jobDirs 설정)는 내 폴더에서 연 세션만 보여요.' }),
      ...r.tmux.map(tmuxBlock),
      h('div.gpu-hostname', null, h('span', { text: 'usagi-run 기록' })),
      r.jobs.length
        ? r.jobs.map((j) => h('div.job-row', { dataset: { id: j.id } },
          h(`span.chip.${j.chip}`, { text: j.label }),
          h('div.job-main', null,
            h('div.job-name', { text: `${j.name}${j.host ? ` @${j.host}` : ''}`, title: j.detail || j.name }),
            h('div.muted.small.job-sub', { text: [j.time, j.files.length ? `바뀐 파일 ${j.files.join(', ')}` : ''].filter(Boolean).join(' · '), title: j.detail })),
          h('button.ghost.small', { type: 'button', text: '물어보기', title: j.ask, onclick: () => askAbout(j.ask) }),
          j.forgettable ? h('button.ghost.small', { type: 'button', text: '기록 지우기', title: '이 기록만 우사기에서 지워요(서버 파일은 이미 정리됐어요)', disabled: jobBusy.has(j.id), onclick: () => forgetJob(j.id) }) : null))
        : h('div.muted.small', { text: '아직 usagi-run 으로 돌린 실험이 없어요. 서버에서 명령 앞에 usagi-run -- 을 붙이면 여기 보여요.' }),
      r.hosts.length ? gpuBlock() : null));
  }
  if (r.note) {
    const y = r.note.yesterday;
    out.push(h('h2', null, h('span', { text: '오늘 연구 노트' })));
    out.push(h('div.card.research-note', null,
      h('div.row', null,
        h('span', { text: r.note.day }), h('span.spacer'),
        r.note.exists
          ? h('button.ghost.small', { type: 'button', text: '열기', onclick: (ev) => openNote(r.note.day, ev.currentTarget) })
          : h('span.muted.small', { text: '오늘 한 일이 생기면 만들어져요' })),
      h('div.muted.small', { text: `Tine 의 그날 일지(저널)에 「오늘 한 일」로 써요.` }),
      y && (y.lines.length || y.next.length)
        ? h('div.note-sum', null,
          h('div.muted.small', { text: `어제(${y.day}) 요약` }),
          h('ul', null, ...y.lines.map((l) => h('li', { text: l })), ...y.next.map((l) => h('li.next', { text: `다음: ${l}` }))))
        : null));
  }
  return out;
}
function renderResearch() {
  const kids = [...(researchSection() ?? []), ...(directivesSection() ?? [])].filter((k) => k != null); // null 을 넣으면 'null' 글자가 찍힌다
  $('sec-research').replaceChildren(...(kids.length ? kids : [h('div.card.empty', { text: '연결된 실험 서버(sshHosts·jobHosts)나 Slack 이 아직 없어요. 설정의 연결에서 켜면 여기 보여요.' })]));
}
// 개요의 연구 한 줄 요약 → 연구 탭
function researchSummaryCard() {
  const r = vm.research, d = vm.directives;
  if (!r && !d) return null;
  const running = (r?.jobs.filter((j) => j.state === 'running').length ?? 0) + (r?.tmux.reduce((n, t) => n + t.sessions.filter((x) => x.running).length, 0) ?? 0);
  const parts = [r ? `도는 실험 ${running}` : '', d?.from.length ? `새 지시 ${d.open.length}` : '', r?.note ? '오늘 연구 노트' : ''].filter(Boolean);
  return h('h2', null, h('span', { text: '연구 ' }), h('span.chip.click', { text: parts.join(' · '), role: 'button', onclick: () => goto('research') }));
}

// ---- Slack 지시사항(#41) — Slack 을 연결했을 때만. 지시자를 고르고, 지시마다 [할 일로]·[괜찮아요] ----
let dirEdit = false; // 지시자 바꾸기 열림
const dirBusy = new Set();
async function decideDirective(id, decision) {
  if (dirBusy.has(id)) return;
  dirBusy.add(id);
  renderResearch();
  const r = await cy.directiveDecide(id, decision).catch(() => ({ ok: false }));
  dirBusy.delete(id);
  if (r?.ok) { vm.directives.open = vm.directives.open.filter((x) => x.id !== id); loadSoon(); }
  renderResearch();
}
async function setDirectiveFrom(ids) {
  const r = await cy.directiveFrom(ids).catch(() => ({ ok: false }));
  if (r?.ok) { dirEdit = false; loadSoon(); }
}
function directivesSection() {
  const d = vm.directives;
  if (!d) return null;
  const picking = !d.from.length || dirEdit;
  const head = h('h2', null, h('span', { text: '지시사항 ' }),
    d.from.length ? h('span.muted.small', { text: `${d.from.map((p) => p.name).join(', ')} · DM·멘션·채널 ` }) : null,
    d.from.length ? h('button.ghost.small', { type: 'button', text: dirEdit ? '닫기' : '바꾸기', onclick: () => { dirEdit = !dirEdit; renderResearch(); } }) : null);
  const picker = picking ? h('div.card.dir-pick', null,
    h('div.small', { text: d.from.length ? '지시를 줄 사람(누르면 빼거나 넣어요)' : '지시를 줄 사람을 골라 주세요. 그 사람이 나에게 보낸 DM, 나를 멘션한 글, 내가 들어간 채널에 쓴 글을 따로 모아요.' }),
    h('div.row.dir-chips', null,
      ...d.from.map((p) => h('button.chip.accent.click', { type: 'button', text: `✓ ${p.name}`, onclick: () => setDirectiveFrom(d.from.filter((x) => x.id !== p.id).map((x) => x.id)) })),
      ...d.candidates.map((p) => h('button.chip.click', { type: 'button', text: `+ ${p.name} · DM ${p.count} · 채널 ${p.channel}`, onclick: () => setDirectiveFrom([...d.from.map((x) => x.id), p.id]) }))),
    !d.candidates.length && !d.from.length ? h('div.muted.small', { text: '최근 30일 DM·채널 글이 아직 없어요. Slack 을 읽기 시작하면 여기 사람이 나와요.' }) : null) : null;
  const list = d.from.length ? (d.open.length
    ? h('div.card.dir-list', null, d.open.map((x) => h('div.dir-row', { dataset: { id: x.id } },
      h('span.chip.accent', { text: x.where }),
      h('div.dir-main', null,
        h('div.dir-text', { text: x.text, title: x.text }),
        h('div.muted.small', null, h('span', { text: `${x.who} · ${x.rel}` }), x.link ? h('a', { href: '#', text: ' · Slack', onclick: (ev) => { ev.preventDefault(); cy.openLink(x.link); } }) : null)),
      h('div.dir-acts', null,
        h('button.primary.small', { type: 'button', text: '할 일로', disabled: dirBusy.has(x.id), onclick: () => decideDirective(x.id, 'todo') }),
        h('button.ghost.small', { type: 'button', text: '괜찮아요', disabled: dirBusy.has(x.id), onclick: () => decideDirective(x.id, 'dismiss') })))))
    : h('div.card.empty.small', { text: '아직 정하지 않은 지시가 없어요.' })) : null;
  return [head, picker, list];
}

// ---- 권한([항상 허용]으로 저장한 도구 규칙) — 개요 아래. 지우면 다음부터 다시 묻는다 ----
let permRules = [];
let permLoaded = false;
const permRemoving = new Set();
let permMsg = null;
async function loadPermissions() {
  let r;
  try { r = await cy.permissions(); } catch { r = { ok: false }; }
  if (r?.ok && Array.isArray(r.data?.rules)) { permRules = normalizePermissionRules(r.data.rules); permLoaded = true; renderOverview(); }
}
async function removePermission(rule) {
  if (permRemoving.has(rule.id)) return;
  permRemoving.add(rule.id);
  permMsg = null;
  renderOverview();
  let r;
  try { r = await cy.permissionDelete(rule.id); } catch { r = { ok: false }; }
  permRemoving.delete(rule.id);
  if (r?.ok || r?.status === 404) permRules = permRules.filter((x) => x.id !== rule.id);
  else permMsg = `지우지 못했어요 — ${why(r)}`;
  renderOverview();
}
function permissionsSection() {
  const rules = withoutPending(permRules, permRemoving);
  return h('section.perm-sec', null,
    h('h2', null, h('span', { text: '권한 ' }), h('span.muted.small', { text: '항상 허용한 도구 — 나머지 쓰기는 매번 승인 카드로 물어봐요' })),
    permMsg ? h('div.result.err', { role: 'status', text: permMsg }) : null,
    rules.length
      ? h('div.card.perm-list', null, rules.map((r) => h('div.perm-row', { dataset: { id: r.id } },
        h('span.perm-icon', { text: r.kind.icon, title: r.kind.name }),
        h('span.perm-label', { text: r.label, title: r.scope || r.tool }),
        h('span.muted.small', { text: ruleUsage(r) }),
        h('span.spacer'),
        h('button.ghost.small.perm-del', { type: 'button', text: '지우기', 'aria-label': `권한 지우기: ${r.label}`, onclick: () => removePermission(r) }))))
      : h('div.card.empty.small', { text: permLoaded ? '항상 허용한 도구가 없어요. 승인 카드에서 [항상 허용]을 누르면 여기 생겨요.' : '불러오는 중…' }));
}

// 연결 카드(설정 > 연결): 기능마다 이름 · 상태 칩 · 맞는 주 동작(꺼져 있으면 [연결하기], 켜져 있으면 [연결 해제]).
// 준비 안 된 건 이유와 [설정 안내]. [연결 해제]는 그 자리에서 한 번 더 묻는다(다시 그려도 열어 둔 확인은 그대로)
let confirmingCap = '';
let connNote = ''; // 방금 끊은 결과(다시 그려도 잠깐 남긴다)
let connNoteTimer = null;
function connectorChip(c) {
  if (c.mode === 'off') return h('span.chip', { text: '연결 안 됨' });
  return h(`span.chip.${c.ready ? 'ok' : 'warn'}`, { text: `${c.ready ? '연결됨' : '준비 안 됨'} · ${c.modeLabel}` });
}
// 설치 탭 「더 연결하기」에 있는 연결(Slack·캘린더)은 거기로, 메일·이슈는 연결 안내 문서(GitHub)로
const howToConnect = (c) => (c.cap === 'slack' || c.cap === 'calendar' ? openSetup('extras') : cy.openLink(`https://github.com/${REPO_SLUG}/blob/main/${c.doc}`));
function connectorActions(c) {
  if (connectorAction(c) === 'connect') {
    return [h('button.primary.small.conn-connect', { type: 'button', text: '연결하기', onclick: () => howToConnect(c) })];
  }
  const copy = connectorDisconnectCopy(c.cap, c.server);
  return [
    c.ready ? null : h('button.ghost.setup-jump', { type: 'button', text: '설정 안내', onclick: () => howToConnect(c) }),
    disconnectControl(document, {
      ...copy,
      open: confirmingCap === c.cap,
      onOpen: () => { confirmingCap = c.cap; },
      onClose: () => { if (confirmingCap === c.cap) confirmingCap = ''; },
      copy: (text) => cy.copyText(text),
      onConfirm: async () => {
        const r = await cy.connectorDisconnect(c.cap);
        if (r?.ok) {
          connNote = [copy.done, r.note].filter(Boolean).join(' ');
          clearTimeout(connNoteTimer);
          connNoteTimer = setTimeout(() => { connNote = ''; renderAll(); }, 20_000);
          loadSoon();
          settingsMod?.refreshRows(); // 위쪽 연결 상태 줄도 함께
        }
        return r;
      },
    }),
  ];
}
function renderConnectors(list) {
  if (!list?.length) return null; // 예전 데몬: 필드가 없으면 카드도 없다
  return [
    h('h2', { text: '기능별 연결' }),
    h('div.card.connectors', null, list.map((c) => h(`div.conn-row${c.ready ? '' : '.not-ready'}`, { dataset: { cap: c.cap } },
      h('div.conn-head', null, h('span.conn-label', { text: c.label }), connectorChip(c),
        c.ready && c.detail ? h('span.muted.small.conn-detail', { text: c.detail }) : null,
        h('span.spacer'),
        ...connectorActions(c)),
      c.ready || c.mode === 'off' ? null : h('div.conn-hint.muted.small', null,
        h('span', { text: !c.detail || c.detail === '연결 안 됨' ? '연결 안 됨' : `연결 안 됨. ${c.detail}` }))))),
    connNote ? h('p.small.conn-note', { role: 'status', text: connNote }) : null,
    h('p.muted.small.conn-foot', { text: `연결 해제는 ${who()} 설정에서만 지워요. Claude Code에 등록한 MCP 서버(claude mcp add)는 그대로 남아요.` }),
  ];
}

function renderSettingsConnectors() {
  fill($('set-connectors'), renderConnectors(vm.connectors));
}

// ---- 설치 마법사 ----
function openSetup(phase) {
  if (isSetupPhase(phase)) setupPhase = phase;
  else if (!isSetupPhase(setupPhase) || setupPhase === 'done') setupPhase = 'extras';
  saveSetup();
  setupKey = '';
  goto('setup');
}

let copyTimer = null;
let copyBtn = null;
async function copySetup(text, btn) {
  let r;
  try { r = await cy.copyText(text); } catch { r = { ok: false }; }
  if (copyBtn && copyBtn !== btn) copyBtn.textContent = copyBtn.dataset.label || '복사';
  copyBtn = btn;
  btn.textContent = r?.ok ? '복사됨' : '복사 실패';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { if (copyBtn === btn) btn.textContent = btn.dataset.label || '복사'; }, 1200);
}

let agentLoginState = { loggedIn: false, installed: null };
// 로그인 안내 화면이 보이는 동안만, 이전 확인이 끝난 2초 뒤에 다시 확인한다(로그인되면·화면을 떠나면·창이 숨겨지면 멈춤)
let loginWatchFor = ''; // 지금 확인 중인(또는 로그인을 확인한) 도구
let loginDone = false;
const loginWatch = createPoller(async () => {
  const who = loginWatchFor;
  let r = { loggedIn: false, installed: false };
  try { r = (await cy.agentLogin(who)) || r; } catch { /* 확인 실패는 로그인 전으로 둔다 */ }
  if (who !== loginWatchFor) return null; // 그 사이 다른 도구로 바뀜
  const next = {
    loggedIn: !!r.loggedIn,
    installed: typeof r.installed === 'boolean' ? r.installed : agentLoginState.installed,
  };
  if (next.loggedIn) loginDone = true;
  if (next.loggedIn !== agentLoginState.loggedIn || next.installed !== agentLoginState.installed) {
    agentLoginState = next;
    setupKey = '';
    renderSetupView(false);
  }
  return next.loggedIn;
}, (loggedIn) => (loggedIn || !panelShown() ? null : 2000));
function stopLoginWatch() {
  loginWatch.stop();
  loginWatchFor = '';
  loginDone = false;
}

function codingAgent() {
  if (setupPhase === 'connect' && (setupLink === 'claude' || setupLink === 'codex' || setupLink === 'agy')) return setupLink;
  return '';
}

function watchAgentLogin() {
  const who = codingAgent();
  const step = who && section === 'setup' ? agentSteps(who)[setupCursor] : null;
  if (step?.gate !== 'login') { stopLoginWatch(); return; }
  if (!panelShown()) { loginWatch.stop(); return; } // 창이 다시 보이면 renderSetupView 가 이어 간다
  if (who !== loginWatchFor) { loginWatch.stop(); loginWatchFor = who; loginDone = false; }
  if (!loginDone) loginWatch.start();
}

function keyFail(error) {
  const e = String(error || '');
  if (/^(Genspark|그 모델은 Genspark|gsk login)/.test(e)) return e; // Genspark 는 llm-check.js 의 말 그대로(무엇을 할지 들어 있다)
  if (/credit|balance|billing|quota|크레딧/i.test(e) && !/RESOURCE_EXHAUSTED/.test(e)) {
    return '키는 맞을 수 있지만 **크레딧이 없습니다.** 결제 크레딧을 산 뒤 다시 **확인**을 누르세요.';
  }
  if (/권한이 모자랍니다/.test(e)) return e; // OpenAI 제한 키: 어디서 무엇을 켜야 하는지 그대로(llm-check.js)
  if (/RESOURCE_EXHAUSTED|429|rate.?limit/i.test(e)) {
    return '키는 맞지만 **지금은 한도가 찼습니다.** 조금 뒤에 **확인**을 다시 누르세요.';
  }
  if (/API_KEY_INVALID|API key not valid|invalid|incorrect|authentication|unauthorized|401|400/i.test(e)) {
    return '**키가 맞지 않습니다.** 앞에서 복사한 키를 다시 붙이세요. 앞뒤에 빈칸이 들어가지 않았는지도 보세요.';
  }
  if (/fetch failed|network|ENOTFOUND|ECONN/i.test(e)) return '**인터넷에 연결되지 않았습니다.** 연결을 확인하고 다시 누르세요.';
  return '**확인하지 못했습니다.** 키를 다시 복사해서 붙이고 **확인**을 누르세요.';
}

// 캐릭터를 바꾸면 설치 화면(그림·말)도 다시
onWho(() => { if (section === 'setup') renderSetupView(false); });

// 「더 연결하기」 항목의 연결됨 표시: 앱이 기억한 표시(sisa done)가 아니라 지금 설정 — 붙인 캘린더 주소의 종류·Slack 연결
function extrasDone() {
  const slack = (vm.connectors || []).find((c) => c.cap === 'slack');
  return {
    gcal: setupCalendars.some((c) => c.kind === 'gcal'),
    outlook: setupCalendars.some((c) => c.kind !== 'gcal'),
    slack: !!slack && slack.mode !== 'off',
  };
}

function renderSetupView(resetScroll) {
  if (section !== 'setup') {
    stopLoginWatch();
    return;
  }
  clampSetupCursor();
  const key = `${whoId()}|${setupPhase}|${setupName}|${setupRepos.join(',')}|${setupReadSessions}|${JSON.stringify(detected)}|${JSON.stringify(brain)}|${(sisa.connected || []).join(',')}|${setupLink}|${setupCursor}|${keyStatus}|${keyNote}|${gskFound}|${JSON.stringify(sisa.done)}|${agentLoginState.loggedIn}|${agentLoginState.installed}|${JSON.stringify(setupCalendars)}|${JSON.stringify(setupApple)}|${JSON.stringify(setupSlotError)}|${JSON.stringify(vm.connectors)}|${JSON.stringify(vm.research?.hosts)}|${!!vm.research?.note}`;
  if (!resetScroll && key === setupKey && $('sec-setup').childElementCount) {
    watchAgentLogin();
    return;
  }
  setupKey = key;
  if (setupPhase === 'extras' || setupPhase === 'done') { loadCalendars(); if (!setupApple) loadApple(); }
  const top = resetScroll ? 0 : ($('sec-setup').querySelector('.setup-scroll')?.scrollTop ?? 0);
  const redraw = (scroll) => { setupKey = ''; renderSetupView(scroll); };
  renderSetup($('sec-setup'), {
    phase: setupPhase,
    cursor: setupCursor,
    login: agentLoginState,
    link: setupLink,
    keyStatus,
    done: extrasDone(),
    connected: sisa.connected,
    connectors: vm.connectors,
    research: vm.research,
    name: setupName,
    detected,
    current: sisa.provider,
    repos: setupRepos,
    readSessions: setupReadSessions,
    brain,
    coder: hasCoder(),
    onName: async (name) => {
      if (name !== setupName) await saveSetupSettings({ user: { name: name || null } });
      setupPhase = 'brain';
      saveSetup();
      redraw(true);
      detectAgents();
    },
    onPickBrain: async (id) => {
      if (id === NO_AI) {
        // AI 없이 쓰기: 로컬 뇌로 정하고(정해진 말·할 일·오늘 표·회의 알림) 마법사는 그대로 이어 간다
        try { await cy.sisaSkip(); } catch { /* 설정에서 다시 고를 수 있다 */ }
        await loadSisa();
        setupPhase = phaseAfterBrain(NO_AI);
        saveSetup();
        redraw(true);
        return;
      }
      if (id === 'claudecode' || id === 'codexcli' || id === 'agycli') {
        const who = id === 'codexcli' ? 'codex' : id === 'agycli' ? 'agy' : 'claude';
        let r = { loggedIn: false };
        try { r = (await cy.agentLogin(who)) || r; } catch { /* 로그인 전으로 본다 */ }
        if (r.loggedIn) {
          let ok = false;
          try { ok = !!(await cy.sisaUseCli(who))?.ok; } catch { /* 아래에서 연결 안내로 */ }
          if (ok) {
            await loadSisa();
            setupPhase = phaseAfterBrain(id, { loggedIn: true });
            saveSetup();
            redraw(true);
            return;
          }
        }
        afterConnect = id;
        setupLink = who;
        setupPhase = 'connect';
        setupCursor = 0;
        agentLoginState = { loggedIn: false, installed: null };
        saveSetup();
        redraw(true);
        return;
      }
      clearApiDraft();
      keyStatus = '';
      keyNote = '';
      setupLink = id;
      setupPhase = phaseAfterBrain(id);
      saveSetup();
      redraw(true);
      if (id === 'genspark') {
        try { gskFound = !!(await cy.gskFound?.())?.found; } catch { gskFound = false; }
        redraw(false);
      }
    },
    onSkipBrain: () => {
      setupPhase = phaseAfterBrain('skip');
      saveSetup();
      redraw(true);
    },
    keyNote,
    gskFound,
    onUseGsk: async () => {
      let r = { ok: false, error: '확인에 실패했습니다.' };
      try { r = (await cy.sisaUseGsk()) || r; } catch { /* 아래 문구 */ }
      keyNote = r.ok && r.warn ? r.warn : '';
      if (r.ok) {
        keyStatus = 'ok';
        try { sisa = { ...sisa, ...(await cy.sisaGet()) }; } catch { sisa = { ...sisa, provider: 'genspark', hasKey: true }; }
      } else keyStatus = keyFail(r.error);
      redraw(false);
    },
    onCheckKey: async (apiKey) => {
      let r = { ok: false, error: '확인에 실패했습니다.' };
      try { r = (await cy.sisaCheck(setupLink, apiKey)) || r; } catch { /* 아래 문구 */ }
      keyNote = r.ok && r.warn ? r.warn : '';
      if (r.ok) {
        keyStatus = 'ok';
        try { sisa = { ...sisa, ...(await cy.sisaGet()) }; } catch { sisa = { ...sisa, provider: setupLink, hasKey: true }; }
      } else keyStatus = keyFail(r.error);
      redraw(false);
    },
    onKeyNext: () => {
      if (keyStatus !== 'ok') return;
      setupPhase = 'extras';
      keyStatus = '';
      saveSetup();
      redraw(true);
    },
    onOpenExtra: (id) => {
      if (!EXTRAS.includes(id) || !hubItem(id)) return;
      if (id === 'gcal' || id === 'outlook') { clearSlot(id); setupSlotError = null; } // 하나 더 추가할 때 앞 주소가 남지 않게
      setupLink = id;
      afterConnect = '';
      setupPhase = 'connect';
      setupCursor = 0;
      agentLoginState = { loggedIn: false, installed: null };
      saveSetup();
      redraw(true);
    },
    // 더 연결하기의 [연결 해제]: 그 커넥터를 끄고(구글·Outlook 은 캘린더 하나) 「연결됨」 표시도 뗀다
    servers: Object.fromEntries((vm.connectors || []).filter((c) => c.server).map((c) => [c.cap, c.server])),
    onCopyText: (text) => cy.copyText(text),
    // 연결된 캘린더: 하나 더 추가(같은 안내를 다시) · 하나 빼기(그 주소만, 마지막이면 캘린더 연결 해제)
    calendars: setupCalendars,
    apple: setupApple,
    onAppleConnect: async (o) => { await cy.appleConnect(o).catch(() => null); loadApple(); },
    onAppleDisconnect: async (o) => { await cy.appleDisconnect(o).catch(() => null); setTimeout(loadApple, 1500); },
    onOpenPrivacy: (kind) => cy.openPrivacy(kind),
    slotError: setupSlotError,
    onAddCalendar: (id) => {
      if (id !== 'gcal' && id !== 'outlook') return;
      clearSlot(id);
      setupSlotError = null;
      setupLink = id;
      afterConnect = '';
      setupPhase = 'connect';
      setupCursor = 0;
      saveSetup();
      redraw(true);
    },
    onRemoveCalendar: async (id) => {
      let r;
      try { r = await cy.calendarRemove(id); } catch { r = { ok: false }; }
      if (r?.ok) {
        try {
          const got = await cy.sisaGet();
          if (got && typeof got === 'object') sisa = { ...sisa, ...got, done: got.done || {} };
        } catch { /* 다음에 다시 읽는다 */ }
        loadSoon();
        setTimeout(() => { setupCalendars = Array.isArray(r.items) ? r.items : setupCalendars; redraw(false); }, 1500); // 뺐다는 글을 잠깐 보여 주고 목록을 다시
      }
      return r;
    },
    onDisconnectExtra: async (_id, cap) => {
      let r;
      try { r = await cy.connectorDisconnect(cap); } catch { r = { ok: false }; }
      if (r?.ok) {
        try {
          const got = await cy.sisaGet();
          if (got && typeof got === 'object') sisa = { ...sisa, ...got, done: got.done || {} };
        } catch { /* 다음에 다시 읽는다 */ }
        loadSoon();
        setTimeout(() => redraw(false), 1500); // 끊었다는 글을 잠깐 보여 주고 목록을 다시
      }
      return r;
    },
    onAddRepo: async (dir) => {
      if (setupRepos.includes(dir)) return;
      await saveSetupSettings({ repoRoots: [...setupRepos, dir] });
      redraw(false);
    },
    onPickFolder: cy.pickFolder ? async () => {
      let dir = null;
      try { dir = await cy.pickFolder(); } catch { /* 취소 */ }
      if (typeof dir === 'string' && dir && !setupRepos.includes(dir)) {
        await saveSetupSettings({ repoRoots: [...setupRepos, dir] });
        redraw(false);
      }
    } : null,
    onRemoveRepo: async (dir) => {
      await saveSetupSettings({ repoRoots: setupRepos.filter((x) => x !== dir) });
      redraw(false);
    },
    onToggleSessions: async (on) => {
      await saveSetupSettings({ readSessions: !!on });
      redraw(false);
    },
    // 마법사를 마치지 않고 넘어가기: 아무것도 읽지 않은 채로 시작(설정·이 탭에서 언제든 다시)
    onSkipSetup: async () => {
      await saveSetupSettings({ onboarded: true });
      try { localStorage.setItem('setupDone', '1'); } catch { /* 무시 */ }
      setupPhase = 'done';
      saveSetup();
      goto('overview');
    },
    onFinishExtras: async () => {
      await saveSetupSettings({ onboarded: true }); // 이제부터 데몬이 고른 것만 읽고 정리를 시작한다
      try { localStorage.setItem('setupDone', '1'); } catch { /* 무시 */ }
      setupPhase = 'done';
      saveSetup();
      redraw(true);
    },
    onTour: () => {
      try { localStorage.setItem('setupDone', '1'); } catch { /* 무시 */ }
      cy.startTour?.();
    },
    onClose: () => {
      try { localStorage.setItem('setupDone', '1'); } catch { /* 무시 */ }
      goto('overview');
    },
    onOpen: (url) => { try { cy.openLink(url); } catch { /* 무시 */ } },
    onPrev: () => {
      if (setupCursor > 0) setupCursor -= 1;
      saveSetup();
      redraw(true);
    },
    onList: () => {
      setupPhase = afterConnect ? 'brain' : 'extras';
      afterConnect = '';
      setupCursor = 0;
      keyStatus = '';
      saveSetup();
      redraw(true);
    },
    onNext: async () => {
      if (setupPhase === 'connect') {
        const steps = stepsNow();
        const step = steps[setupCursor];
        if (step?.gate === 'blocked') return;
        if (step?.gate === 'login' && !agentLoginState.loggedIn) return;
        if (step?.slots?.some((s) => !slotOk(s.id, readSlot(s.id)))) return;
        if (setupCursor < steps.length - 1) {
          setupCursor += 1;
          saveSetup();
          redraw(true);
          return;
        }
        const url = (setupLink === 'gcal' || setupLink === 'outlook' || setupLink === 'slack') ? readSlot(setupLink) : ''; // Slack 은 사용자 토큰
        let mark = null;
        try { mark = await cy.sisaMark(setupLink, url); } catch { /* 표시만 남긴다 */ }
        if (mark?.duplicate) {
          // 같은 주소는 한 번만: 그 칸에 머물며 알린다(칸을 고치면 사라진다)
          setupSlotError = { id: setupLink, value: url, text: mark.error || '이미 연결된 캘린더예요.' };
          redraw(false);
          return;
        }
        setupSlotError = null;
        if (setupLink === 'slack') clearSlot('slack'); // 토큰은 화면에 남기지 않는다
        if ((afterConnect === 'claudecode' && setupLink === 'claude') || (afterConnect === 'codexcli' && setupLink === 'codex') || (afterConnect === 'agycli' && setupLink === 'agy')) {
          afterConnect = '';
          try { await cy.sisaUseCli(setupLink); } catch { /* 목록에서 다시 고르면 된다 */ }
          await loadSisa();
        }
        try {
          const got = await cy.sisaGet();
          if (got && typeof got === 'object') sisa = { ...sisa, ...got, hasKey: !!got.hasKey, done: got.done || {} };
        } catch { /* 목록은 돌아간다 */ }
        sisa.done = { ...(sisa.done || {}), [setupLink]: true };
        // 뇌 고르기에서 설치 안내로 들어왔으면 다음(더 연결하기)으로, 더 연결하기에서 왔으면 그 목록으로
        setupPhase = 'extras';
        setupCursor = 0;
        keyStatus = '';
        saveSetup();
        redraw(true);
        return;
      }
    },
    onBack: () => {
      setupPhase = backPhase({ phase: setupPhase, afterConnect: !!afterConnect });
      if (setupPhase === 'brain') detectAgents();
      if (setupPhase !== 'connect') afterConnect = '';
      setupCursor = 0;
      keyStatus = '';
      saveSetup();
      redraw(true);
    },
    onCopy: copySetup,
  });
  const sc = $('sec-setup').querySelector('.setup-scroll');
  if (sc) sc.scrollTop = top;
  watchAgentLogin();
}

function maybeOpenSetup() {
  if (setupAsked || !needsSetup(vm.connectors)) return;
  setupAsked = true;
  try { if (localStorage.getItem('setupDone') === '1') return; } catch { /* 저장소 없으면 연다 */ }
  if (section === 'overview') openSetup('name');
}

// ---- 작업 폴더 ----
// 숨기기: 줄의 '숨기기' 버튼 → 낙관적으로 아래 '숨긴 작업 폴더'로, 실패하면 되돌림. 숨긴 건 집계·에이전트 맥락에서도 빠진다
const hidePending = new Map(); // path → hidden (응답 대기 중)
let projMsg = null;
let hiddenOpen = false;
try { hiddenOpen = localStorage.getItem('hiddenProjectsOpen') === '1'; } catch { /* 저장소 없음 */ }

async function setHidden(p, hide) {
  if (!p.path || hidePending.has(p.path)) return;
  hidePending.set(p.path, hide);
  projMsg = null;
  renderAll();
  let r;
  try { r = await cy.projectHide(p.path, hide); } catch { r = { ok: false }; }
  hidePending.delete(p.path);
  if (r?.ok) {
    if (raw && Array.isArray(raw.projects)) raw = { ...raw, projects: raw.projects.map((x) => (x?.path === p.path ? { ...x, hidden: hide } : x)) };
    loadSoon();
  } else {
    projMsg = { ok: false, text: `${hide ? '숨기기' : '다시 보이기'} 실패 — ${why(r)}` };
  }
  renderAll();
}

function toggleHiddenGroup() {
  hiddenOpen = !hiddenOpen;
  try { localStorage.setItem('hiddenProjectsOpen', hiddenOpen ? '1' : '0'); } catch { /* 무시 */ }
  renderProjects();
}

const openRows = new Set(); // 펼친 줄(path)
let pickFor = null; // 서버를 모르는 폴더에서 VS Code 를 누른 줄 { path, hosts }

async function openFolder(p, how, host) {
  const r = await cy.folderOpen(p.path, how, host).catch(() => null);
  pickFor = null;
  projMsg = r?.ok ? null : { ok: false, text: `${how === 'code' ? 'VS Code' : 'Finder'} 로 열지 못했어요 — ${r?.error || '다시 시도해 주세요'}` };
  renderProjects();
}

// 서버 이름을 모르는 폴더: ssh User 가 맞는 서버를 후보로 보여 주고 고르게 한다
async function pickHost(p) {
  const r = await cy.folderHosts().catch(() => null);
  const hosts = candidateHosts(p.dir, r?.hosts || []);
  if (!hosts.length) {
    projMsg = { ok: false, text: '어느 서버의 폴더인지 몰라서 VS Code 로 열 수 없어요. ~/.ssh/config 에 이 폴더의 계정(/home/<계정>/)으로 접속하는 서버가 있어야 해요' };
    return renderProjects();
  }
  projMsg = null;
  pickFor = { path: p.path, hosts };
  renderProjects();
}

const WHERE_CHIP = {
  server: (p) => ({ text: p.host, accent: true, title: `서버 ${p.host} 의 작업 기록` }),
  mac: () => ({ text: '이 Mac', title: '이 Mac 의 작업 기록·git' }),
  unknown: () => ({ text: '서버(이름 모름)', accent: true, title: '이 Mac 에 없는 폴더예요 — VS Code 원격 세션 기록 같은 서버 폴더로 보여요' }),
};

function renderProjects() {
  const el = $('sec-projects');
  const hidden = vm.hiddenProjects;
  const kids = [h('p.muted.small.proj-intro', { text: '최근 7일 동안 Claude Code·Codex 로 작업한 폴더와 커밋이 있는 레포예요. 서버 폴더는 ssh 로 작업 기록만 받아 와요. 줄을 누르면 마지막 요청과 최근 커밋이 펼쳐지고, VS Code 로 바로 열 수 있어요.' })];
  if (projMsg) kids.push(h(`div.result.${projMsg.ok ? 'ok' : 'err'}`, { role: 'status', text: projMsg.text }));
  if (!vm.projects.length) kids.push(h('div.empty', { text: error && !raw ? '불러오지 못함' : hidden.length ? '숨긴 작업 폴더만 있음' : '최근 작업 폴더 없음' }));
  else kids.push(projectRows());
  if (hidden.length) {
    kids.push(h('div.hidden-projects', null,
      h('button.ghost.hidden-toggle', { type: 'button', 'aria-expanded': String(hiddenOpen), onclick: toggleHiddenGroup },
        h('span.caret', { text: hiddenOpen ? '▾' : '▸' }), h('span', { text: `숨긴 작업 폴더 (${hidden.length})` })),
      hiddenOpen
        ? h('div.card.hidden-list', null, hidden.map((p) => h('div.hidden-row', null,
          h('span.name', { text: p.name }),
          p.dir ? h('span.path.mono', { text: p.host ? `${p.host} · ${p.dir}` : p.dir, title: p.path }) : null,
          h('span.spacer'),
          h('button.ghost', { type: 'button', text: '다시 보이기', 'aria-label': `다시 보이기: ${p.name}`, onclick: () => setHidden(p, false) }))))
        : null));
  }
  fill(el, ...kids);
}

function projectRows() {
  return h('div.card.proj-list', null, vm.projects.map((p) => {
    const open = openRows.has(p.path);
    const chip = WHERE_CHIP[p.where](p);
    const toggle = () => { if (open) openRows.delete(p.path); else openRows.add(p.path); renderProjects(); };
    return h('article.proj', null,
      h('div.proj-head', null,
        h('button.proj-toggle', { type: 'button', 'aria-expanded': String(open), 'aria-label': `${p.name} ${open ? '접기' : '펼치기'}`, onclick: toggle },
          h('span.caret', { text: open ? '▾' : '▸', 'aria-hidden': 'true' }),
          h('span.proj-main', null,
            h('span.proj-line', null,
              h('span.name', { text: p.name }), p.branch ? h('span.chip.mono', { text: p.branch }) : null,
              h(`span.chip.src${chip.accent ? '.accent' : ''}`, { text: chip.text, title: chip.title }),
              h('span.meta', null,
                h('span', null, '마지막 활동 ', h('b', { text: p.lastActiveRel || '—', title: p.lastActive })),
                h('span', { title: '24시간 안에 갱신된 작업 기록 수' }, '24h 세션 ', h('b', { text: String(p.sessions24h) })),
                // 서버는 깃을 ssh 로 돌리지 않아 0 이 거짓이 되므로 보이지 않는다
                p.where === 'mac' ? h('span', { title: '오늘 이 Mac 의 레포에서 한 커밋 수' }, '오늘 커밋 ', h(`b${p.commitsToday ? '.today' : ''}`, { text: String(p.commitsToday) })) : null)),
            p.lastTitle ? h('span.proj-title', { text: p.lastTitle, title: p.lastTitle }) : null)),
        h('span.proj-actions', null,
          h('button.ghost', { type: 'button', text: 'VS Code', title: p.where === 'mac' ? 'VS Code 로 이 폴더 열기' : 'VS Code Remote-SSH 로 서버 폴더 열기', 'aria-label': `VS Code 로 열기: ${p.name}`, onclick: () => (p.where === 'unknown' ? pickHost(p) : openFolder(p, 'code')) }),
          p.where === 'mac' ? h('button.ghost', { type: 'button', text: 'Finder', 'aria-label': `Finder 로 열기: ${p.name}`, onclick: () => openFolder(p, 'finder') }) : null,
          h('button.ghost.hide-btn', { type: 'button', text: '숨기기', title: '이 작업 폴더 숨기기 — 집계와 에이전트 맥락에서도 빠져요', 'aria-label': `숨기기: ${p.name}`, onclick: () => setHidden(p, true) }))),
      pickFor?.path === p.path
        ? h('div.proj-pick', null, h('span.muted.small', { text: '어느 서버예요?' }),
          pickFor.hosts.map((host) => h('button.ghost', { type: 'button', text: host, onclick: () => openFolder(p, 'code', host) })))
        : null,
      open
        ? h('div.proj-body', null,
          p.dir ? h('div.path.mono', { title: p.path }, h('bdi', { text: p.dir })) : null,
          p.lastPrompt ? h('div.prompt', { text: p.lastPrompt, title: p.lastPrompt }) : null,
          p.recentCommits.length
            ? h('ul.commits', null, p.recentCommits.map((c) => h('li', null,
              h('span.sha.mono', { text: c.sha }), h('span.subj', { text: c.subject, title: c.subject }), h('span.when', { text: c.rel }))))
            : null)
        : null);
  }));
}

// ---- 할 일 ----
// 줄: 한 번 누르면 아래에 설명·원본(펼침), 두 번 누르면 그 자리에서 제목·설명 고치기, 꾹 눌러 끌면 순서·우선순위.
// 변경은 낙관적으로: pendingOps 를 서버 목록 위에 겹쳐 그리고, 실패하면 빼서 되돌린다.
let pendingOps = [];
let opSeq = 0;
let openId = null; // 펼친 할 일(한 번에 하나)
const details = new Map(); // id → { status: 'loading'|'ok'|'error', data?, error? } — GET /todos/:id/detail
let refocusId = null; // 다시 그린 뒤 키보드 포커스를 돌려줄 줄
let recentDone = []; // 이 창에서 방금 완료한 것 — 되돌리기용
let todoMsg = null; // { ok, text }
let todosStale = false;
let addPriority = 2;
let addDraft = '';

const why = (r) => (typeof r?.data?.error === 'string' ? r.data.error : r?.status ? `HTTP ${r.status}` : `${who()} 연결 확인`);

// 서버 호출 + 낙관적 반영. 성공하면 commit 으로 raw 에 반영, 실패하면 겹침만 빼서 원래대로
// op 하나 또는 여러 개. failText 가 null 이면 목록에 오류를 띄우지 않는다
async function mutate(op, call, failText, commit) {
  const ops = Array.isArray(op) ? op : [op];
  for (const o of ops) o.seq = ++opSeq;
  pendingOps.push(...ops);
  todoMsg = null;
  renderAll();
  let r;
  try { r = await call(); } catch { r = { ok: false }; }
  pendingOps = pendingOps.filter((x) => !ops.includes(x));
  if (r?.ok) {
    if (raw) commit?.(r);
    loadSoon();
  } else if (failText) {
    todoMsg = { ok: false, text: `${failText} — ${why(r)}` };
  }
  renderAll();
  return r;
}

const rawTodos = () => (raw && Array.isArray(raw.todos) ? raw.todos : []);
const setRawTodos = (xs) => { raw = { ...raw, todos: xs }; };
const visibleTodos = () => overlayTodos(rawTodos(), pendingOps);

// 끌기·Alt 키로 순서·우선순위 바꾸기
function moveTodo(id, priority, beforeId) {
  if (isNoopMove(visibleTodos(), id, priority, beforeId)) return;
  mutate({ kind: 'reorder', id, priority, beforeId }, () => cy.todoReorder(id, priority, beforeId ?? null), '순서 바꾸기 실패',
    () => setRawTodos(reorderLocal(rawTodos(), id, priority, beforeId)));
}

function addTodo() {
  const body = newTodoBody(addDraft, addPriority);
  if (!body) return;
  addDraft = '';
  const input = $('todo-add-input');
  if (input) input.value = '';
  mutate({ kind: 'add', tempId: `tmp:${opSeq + 1}`, body }, () => cy.todoAdd(body), '추가 실패', (r) => {
    if (typeof r.data?.id !== 'string') return;
    setRawTodos([{ id: r.data.id, source: 'user', userEdited: false, ...body }, ...rawTodos()]);
  }).then((r) => {
    if (r?.ok) return;
    addDraft = body.title;
    renderTodos();
  });
}

// 줄의 '오늘' 토글: 할 일을 오늘 할 일로 고르거나 뺀다(할 일은 그대로)
function toggleToday(t) {
  const date = vm.today?.date;
  if (!date) return;
  const on = isToday(t, date);
  mutate({ kind: 'edit', id: t.id, patch: { today: on ? null : date }, rule: true }, () => cy.todoEdit(t.id, { today: !on }), '오늘 할 일 바꾸기 실패', () => {
    setRawTodos(rawTodos().map((x) => {
      if (x.id !== t.id) return x;
      const { today: _drop, ...rest } = x;
      return on ? rest : { ...x, today: date };
    }));
    raw = { ...raw, today: patchToday(raw.today, t.id, on ? null : { title: t.title, priority: t.priority, source: t.source, done: false }) };
  });
}

// skipped = 안 해도 돼서 닫기: 같은 끝난 칸으로 가되 「안 함」 표시가 붙는다
function completeTodo(t, skipped = false) {
  const item = { id: t.id, title: t.title, source: t.source, priority: t.priority, link: t.linkRaw || undefined, note: t.note || undefined, userEdited: t.userEdited, ...(skipped ? { skipped: true } : {}) };
  mutate({ kind: 'remove', id: t.id }, () => (skipped ? cy.todoEdit(t.id, { status: 'done', skipped: true }) : cy.todoDone(t.id)), skipped ? '닫기 실패' : '완료 처리 실패', () => {
    setRawTodos(rawTodos().filter((x) => x.id !== t.id));
    raw = { ...raw, today: patchToday(raw.today, t.id, { done: true }) }; // 오늘 할 일이면 '오늘 끝냄'으로
    recentDone = [item, ...recentDone.filter((x) => x.id !== t.id)].slice(0, 5);
  });
}

function reopenTodo(item) {
  recentDone = recentDone.filter((x) => x.id !== item.id);
  mutate({ kind: 'add', tempId: item.id, body: item }, () => cy.todoEdit(item.id, { status: 'open' }), '되돌리기 실패', () => {
    setRawTodos([item, ...rawTodos().filter((x) => x.id !== item.id)]);
    raw = { ...raw, today: patchToday(raw.today, item.id, { done: false }) };
  }).then((r) => { if (!r?.ok) { recentDone = [item, ...recentDone]; renderTodos(); } });
}

// 자동 완료 되돌리기: 다시 열고, 이 할 일은 앞으로 자동으로 끝내지 않는다(서버가 기억)
const reverting = new Set();
function revertAuto(item) {
  reverting.add(item.id);
  const body = { id: item.id, title: item.title, source: item.source, priority: item.priority, link: item.link || undefined, userEdited: false };
  mutate({ kind: 'add', tempId: item.id, body }, () => cy.todoRevert(item.id), '되돌리기 실패', () => {
    setRawTodos([body, ...rawTodos().filter((x) => x.id !== item.id)]);
    raw = { ...raw, recentDone: (raw.recentDone ?? []).filter((x) => x.id !== item.id) };
    todoMsg = { ok: true, text: `"${item.title}" 다시 열었어요. 이건 앞으로 자동으로 끝내지 않아요.` };
  }).finally(() => { reverting.delete(item.id); renderTodos(); });
}

function doneRow(t) {
  return h('div.todo.is-done', { dataset: { id: t.id } },
    h('span.t', { text: t.title, title: t.auto && t.reason ? t.reason : null }),
    t.skipped ? h('span.chip.skipped', { text: '안 함', title: '안 해도 돼서 닫았어요' }) : null,
    t.auto ? h('span.chip.ok.auto', { text: '자동', title: t.reason ? `Slack 대화를 보고 자동 완료: ${t.reason}` : 'Slack 대화를 보고 자동 완료' }) : null,
    t.doneRel ? h('span.muted', { text: t.doneRel }) : null,
    t.auto && t.evidence ? h('button.ghost', { type: 'button', text: '근거', title: '근거 메시지 열기', onclick: () => cy.openLink(t.evidence) }) : null,
    h('button.ghost', { type: 'button', text: '되돌리기', onclick: () => (t.auto ? revertAuto(t) : reopenTodo(t)) }));
}

// ---- 휴지통: 줄의 휴지통 버튼·Delete 키·끌어 놓기 → 그 자리 확인 → 휴지통으로(5초 되돌리기). 맨 아래 '휴지통 (N)' ----
let trashPending = []; // todo-trash.js trashModel 의 pending(응답 대기 중)
let confirmState = null; // 그 자리 확인(todo-trash.js confirmReducer)
let focusConfirm = false; // 다음 그리기에서 확인 버튼에 포커스
let trashOpen = readTrashOpen(globalThis.localStorage);
const trashing = new Map(); // id → 휴지통으로 옮기는 요청(되돌리기는 이게 끝난 뒤 restore)

function setConfirm(action) {
  const prev = confirmState;
  confirmState = confirmReducer(confirmState, action);
  if (action.type === 'ask') focusConfirm = true;
  else if (prev?.kind === 'trash') refocusId = prev.id; // 취소하면 그 줄로 포커스
  renderTodos();
}
const askTrash = (t) => { if (t && !t.pending) setConfirm({ type: 'ask', kind: 'trash', id: t.id }); };

function trashTodo(t) {
  const item = trashItemOf(t), body = todoBodyOf(t);
  const op = { kind: 'trash', item };
  confirmState = null;
  if (openId === t.id) openId = null;
  if (todoEditing?.id === t.id) todoEditing = null;
  // 키보드로 지웠으면 다음 줄로 포커스(mutate 가 바로 다시 그린다)
  const ids = listGroups().flatMap((g) => g.items.map((x) => x.id));
  const i = ids.indexOf(t.id);
  if (listSec().contains(document.activeElement)) refocusId = ids[i + 1] ?? ids[i - 1] ?? null;
  trashPending.push(op);
  undo.show(body);
  const job = mutate({ kind: 'remove', id: t.id }, () => cy.todoDelete(t.id), '휴지통으로 옮기기 실패', () => {
    setRawTodos(rawTodos().filter((x) => x.id !== t.id));
    raw = commitTrash(raw, op);
    raw = { ...raw, today: patchToday(raw.today, t.id, null) };
  }).then((r) => { if (!r?.ok && undo.current?.id === t.id) undo.close(); return r; })
    .finally(() => { trashPending = trashPending.filter((x) => x !== op); trashing.delete(t.id); renderTodos(); });
  trashing.set(t.id, job);
}

// 되살리기: body 가 있으면(방금 지운 것 되돌리기) 열린 목록에 바로 다시 보인다. 없으면(휴지통 줄) 응답을 보고 넣는다
async function restoreTodo(id, title, body = null) {
  const op = { kind: 'restore', id };
  trashPending.push(op);
  if (confirmState?.id === id) confirmState = null;
  renderTodos();
  await trashing.get(id);
  const r = await mutate(body ? { kind: 'add', tempId: id, body } : [], () => cy.todoRestore(id), '되살리기 실패', (res) => {
    raw = commitTrash(raw, op);
    const td = res.data?.todo;
    if (td?.status === 'done') return;
    const back = body ?? { id, title: td?.title ?? title, source: td?.source ?? '', priority: td?.priority ?? 2, ...(td?.link ? { link: td.link } : {}), ...(td?.note ? { note: td.note } : {}), userEdited: false };
    setRawTodos([back, ...rawTodos().filter((x) => x.id !== id)].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)));
    if (!body) todoMsg = { ok: true, text: `"${title}" 되살렸어요` };
  });
  trashPending = trashPending.filter((x) => x !== op);
  if (r?.ok && body) refocusId = id;
  renderTodos();
}

function purgeTodo(id) {
  const op = { kind: 'purge', id };
  trashPending.push(op);
  confirmState = null;
  mutate([], () => cy.todoPurge(id), '영구 삭제 실패', () => { raw = commitTrash(raw, op); })
    .finally(() => { trashPending = trashPending.filter((x) => x !== op); renderTodos(); });
}

function emptyTrash() {
  const op = { kind: 'empty' };
  trashPending.push(op);
  confirmState = null;
  mutate([], () => cy.todoTrashEmpty(), '휴지통 비우기 실패', () => { raw = commitTrash(raw, op); })
    .finally(() => { trashPending = trashPending.filter((x) => x !== op); renderTodos(); });
}

function toggleTrash() {
  trashOpen = !trashOpen;
  writeTrashOpen(globalThis.localStorage, trashOpen);
  renderTodos();
}

// 그 자리 확인: "휴지통으로 옮길까요? [옮기기] [취소]" — Enter 확인, Esc 취소(창 닫기로 안 번짐)
function confirmBox(kind, onYes, extra) {
  const c = CONFIRM_TEXT[kind];
  const cancel = () => setConfirm({ type: 'cancel' });
  return h('span.inline-confirm', {
    role: 'group', 'aria-label': c.q,
    onkeydown: (e) => {
      const k = confirmKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === 'confirm') onYes(); else cancel();
    },
    onclick: (e) => e.stopPropagation(),
  },
  h('span.q', { text: extra ? `${c.q} ${extra}` : c.q }),
  h('button.danger.yes', { type: 'button', text: c.yes, onclick: onYes }),
  h('button.ghost.no', { type: 'button', text: '취소', onclick: cancel }));
}

const TRASH_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M2.5 4.5h11M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6M6.8 7v4.5M9.2 7v4.5"/></svg>';
// ▶ (진행중) 토글: 누르면 켜고, 켜져 있으면 끈다(비서가 진척을 봤어도 끔으로 고정)
function doingButton(t) {
  const on = isDoing(t);
  return h(`button.ghost.row-doing${on ? '.on' : ''}`, {
    type: 'button', disabled: t.pending, 'aria-pressed': String(on),
    title: on ? '진행중 표시 끄기' : '진행중으로 표시', 'aria-label': `${on ? '진행중 끄기' : '진행중으로'}: ${t.title}`,
    onclick: () => mutate({ kind: 'edit', id: t.id, patch: { doing: !on }, rule: true }, () => cy.todoEdit(t.id, { doing: !on }), '진행중 표시 실패'),
  }, navIcon(on ? 'pause' : 'play'));
}

// 「안 해도 됨」: 할 필요가 없어서 닫는다(끝난 칸에 「안 함」 표시)
function skipButton(t) {
  return h('button.ghost.row-skip', {
    type: 'button', text: '안 해도 됨', disabled: t.pending, title: '할 필요가 없어서 닫기 (끝난 칸에 「안 함」으로 남아요)',
    'aria-label': `안 해도 됨: ${t.title}`, onclick: () => completeTodo(t, true),
  });
}

// '오늘' 토글: 켜져 있으면 맨 위 「오늘」 묶음에 올라가 있다, 누르면 고르기·빼기
function todayButton(t) {
  const date = vm.today?.date;
  if (!date) return null;
  const on = isToday(t, date);
  return h(`button.ghost.row-today${on ? '.on' : ''}`, {
    type: 'button', text: '오늘', disabled: t.pending, 'aria-pressed': String(on),
    title: on ? '오늘에서 빼기(할 일은 남아요)' : '오늘 할 일로 고르기', 'aria-label': `${on ? '오늘 할 일에서 빼기' : '오늘 할 일로'}: ${t.title}`,
    onclick: () => toggleToday(t),
  });
}

function trashButton(t) {
  const b = h('button.ghost.row-trash', { type: 'button', title: '휴지통으로 (Delete)', 'aria-label': `휴지통으로: ${t.title}`, disabled: t.pending, onclick: () => askTrash(t) });
  b.innerHTML = TRASH_ICON;
  return b;
}

// 맨 아래 '휴지통 (N)' — 접힘 기억. 끄는 중엔 비어 있어도 놓을 칸으로 보인다
function trashGroup() {
  const m = trashModel(raw?.trash, raw?.trashCount, trashPending);
  if (confirmState?.kind === 'purge' && !m.items.some((x) => x.id === confirmState.id)) confirmState = null;
  if (confirmState?.kind === 'empty' && !m.count) confirmState = null;
  if (!m.count && !dragGroups) return null;
  const head = h('h2.trash-head', {
    role: 'button', tabindex: '0', 'aria-expanded': String(trashOpen), title: trashOpen ? '접기' : '펼치기',
    onclick: toggleTrash, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTrash(); } },
  }, h('span.caret', { text: trashOpen ? '▾' : '▸' }), h('span', { text: '휴지통' }), h('span.chip', { text: String(m.count) }));
  let body = null;
  if (trashOpen && m.items.length) {
    body = h('div.card.todos.trash-list', null,
      m.items.map(trashRow),
      h('div.trash-foot', null,
        m.count > m.items.length ? h('span.muted.small', { text: `최근 ${m.items.length}개만 보여요` }) : h('span.muted.small', { text: '30일 지나면 저절로 지워져요' }),
        isConfirming(confirmState, 'empty')
          ? confirmBox('empty', emptyTrash, `${m.count}개를 영구 삭제해요.`)
          : h('button.ghost.danger-text', { type: 'button', text: '휴지통 비우기', onclick: () => setConfirm({ type: 'ask', kind: 'empty' }) })));
  } else if (dragGroups) {
    body = h('div.card.todos.drop-empty.trash-drop', null, h('div.muted.small', { text: '여기로 끌어 놓으면 휴지통으로' }));
  }
  return h('div.group.trash', null, head, body);
}

function trashRow(t) {
  return h('div.todo.trashed', { dataset: { id: t.id } },
    h('span.t', { text: t.title }),
    h(`span.chip.prio.p${t.priority}`, { text: t.priorityLabel, title: '원래 우선순위' }),
    t.ago ? h('span.muted.small.ago', { text: t.ago, title: t.trashedAt }) : null,
    isConfirming(confirmState, 'purge', t.id)
      ? confirmBox('purge', () => purgeTodo(t.id))
      : [h('button.ghost', { type: 'button', text: '되살리기', onclick: () => restoreTodo(t.id, t.title) }),
        h('button.ghost.danger-text', { type: 'button', text: '영구 삭제', onclick: () => setConfirm({ type: 'ask', kind: 'purge', id: t.id }) })]);
}

// 되돌리기 토스트(5초). ⌘Z 로도
const undoToast = h('div.undo-toast', { role: 'status', 'aria-live': 'polite', hidden: true });
document.body.append(undoToast);
const undo = createUndo({ ms: UNDO_MS, onChange: renderUndo });
function renderUndo(item) {
  undoToast.hidden = !item;
  document.body.classList.toggle('has-undo', !!item); // 맨 아래 줄(휴지통 비우기 등)을 가리지 않게 여백
  if (!item) { undoToast.replaceChildren(); return; }
  const title = item.title.length > 22 ? `${item.title.slice(0, 21)}…` : item.title;
  undoToast.replaceChildren(
    h('span.msg', { text: `'${title}' 휴지통으로 옮겼어요` }),
    h('button.undo', { type: 'button', text: '되돌리기', onclick: undoTrash }),
    h('span.bar')); // 5초(UNDO_MS) 줄어드는 막대 — panel.css
}
function undoTrash() {
  const item = undo.take();
  if (item) restoreTodo(item.id, item.title, item);
}
document.addEventListener('keydown', (e) => {
  if (!undo.current || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
  e.preventDefault();
  undoTrash();
});
// 확인 밖을 누르면 취소
document.addEventListener('mousedown', (e) => {
  if (!confirmState || e.target.closest?.('.inline-confirm')) return;
  confirmState = null;
  renderTodos();
}, true);

// 추가 입력칸에서 한글 조합 중이거나 끄는 중이면 다시 그리지 않는다(조합·끌기 보호). 끝나면 그때 그림.
// 추가 입력칸은 값을 addDraft 에 들고 있으니 다시 그린 뒤 포커스만 되돌린다.
const todosSec = $('sec-todos');
const isListSection = () => section === 'todos';
const listSec = () => todosSec;
const listGroups = () => vm.todoGroups;
const listTodos = () => visibleTodos();
const ADD_INPUTS = ['todo-add-input'];
let composing = false;
todosSec.addEventListener('compositionstart', () => { composing = true; });
todosSec.addEventListener('compositionend', () => { composing = false; if (todosStale) setTimeout(renderTodos, 0); });
todosSec.addEventListener('focusout', () => setTimeout(() => { if (todosStale && !todoInputFocused()) renderTodos(); }, 0));
function todoInputFocused() {
  const a = document.activeElement;
  if (!a || !todosSec.contains(a) || (a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA')) return false;
  return composing || !ADD_INPUTS.includes(a.id);
}

function renderTodos() {
  if (todoInputFocused() || drag) { todosStale = true; return; }
  todosStale = false;
  const sec = listSec();
  const addFocused = ADD_INPUTS.includes(document.activeElement?.id) ? document.activeElement.id : null;
  const rowFocus = refocusId ?? (sec.contains(document.activeElement) ? document.activeElement?.closest?.('.todo.row')?.dataset.id : null);
  refocusId = null;
  if (confirmState?.kind === 'trash' && !findTodo(confirmState.id)) confirmState = null; // 지워졌거나 끝난 줄
  todosSec.replaceChildren(...todoListKids());
  const yes = (focusConfirm || sec.contains(document.activeElement) || document.activeElement === document.body) && confirmState ? sec.querySelector('.inline-confirm .yes') : null;
  focusConfirm = false;
  if (yes) yes.focus();
  else if (addFocused) $(addFocused)?.focus();
  else if (rowFocus) sec.querySelector(`.todo.row[data-id="${CSS.escape(rowFocus)}"]`)?.focus();
}

function todoListKids() {
  // 끄는 동안엔 빈 우선순위 칸도 보여서 거기로 옮길 수 있게
  const groups = dragGroups ? withEmptyGroups(vm.todoGroups) : vm.todoGroups;
  const kids = [addForm(), rulesBar()];
  if (todoMsg) kids.push(h(`div.result.${todoMsg.ok ? 'ok' : 'err'}`, { role: 'status', text: todoMsg.text }));
  if (!raw && error) kids.push(h('div.empty', { text: '불러오지 못함' }));
  // 맨 위 「오늘」은 비어도 보인다(고르는 법 안내)
  if (!groups.some((g) => g.priority === 0)) kids.push(todoGroup({ priority: 0, label: priorityLabel(0), hint: priorityHint(0), items: [] }));
  kids.push(...groups.map(todoGroup));
  const done = mergeRecentDone(recentDone, vm.recentDone, [...reverting]);
  if (done.length) {
    kids.push(h('div.group.done', null,
      h('h2', null, h('span', { text: '최근 완료' })),
      h('div.card.todos', null, done.map(doneRow))));
  }
  const trash = trashGroup(); // 휴지통이 비면 null — replaceChildren 에 넘기면 "null" 글자가 찍힌다
  if (trash) kids.push(trash);
  kids.push(focusView.foot('todos')); // 오늘 집중 N → 누르면 주·월 기록
  return kids;
}

function withEmptyGroups(groups) {
  const out = [...groups];
  for (const p of [1, 2, 3, BACKLOG]) if (!out.some((g) => g.priority === p)) out.push({ priority: p, label: priorityLabel(p), items: [] });
  return out.sort((a, b) => a.priority - b.priority);
}

// 묶음 이름 + 기준 한 줄
const groupHead = (g, ...more) => [h('span', { text: g.label }), h('span.chip', { text: String(g.items.length) }), g.hint ? h('span.group-hint', { text: g.hint }) : null, ...more];

// 우선순위 묶음. 맨 위 「오늘」(0)은 오늘로 고른 일 + 접힌 「오늘 끝냄」. 백로그(P4)는 기본 접힘(기억) — 접혀 있어도 끌어 놓을 칸은 남는다
function todoGroup(g) {
  if (g.priority === 0) return todayGroup(g);
  const collapsed = isCollapsed(g.priority, backlogOpen);
  const head = g.priority === BACKLOG
    ? h('h2.backlog-head', {
      role: 'button', tabindex: '0', 'aria-expanded': String(!collapsed), title: collapsed ? '펼치기' : '접기',
      onclick: toggleBacklog, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBacklog(); } },
    }, h('span.caret', { text: collapsed ? '▸' : '▾' }), ...groupHead(g))
    : h('h2', null, ...groupHead(g));
  const body = collapsed
    ? h('div.card.todos.drop-empty.collapsed', null, g.items.length ? null : h('div.muted.small', { text: '끌어 놓기' }))
    : h(`div.card.todos${g.items.length ? '' : '.drop-empty'}`, null, g.items.length ? g.items.map(todoRow) : h('div.muted.small', { text: '끌어 놓기' }));
  return h(`div.group.p${g.priority}`, { dataset: [1, 2, 3, BACKLOG].includes(g.priority) ? { priority: String(g.priority) } : null }, head, body);
}

let todayDoneOpen = false;
function todayGroup(g) {
  const done = vm.todayDone;
  const kids = [h('div.group.today', null,
    h('h2', null, ...groupHead(g)),
    h(`div.card.todos${g.items.length ? '' : '.drop-empty'}`, null,
      g.items.length ? g.items.map(todoRow) : h('div.muted.small', { text: '아직 고른 일이 없어요. 아래 줄에 마우스를 올리고 「오늘」을 눌러 골라 보세요.' })))];
  if (done.length) {
    const toggle = () => { todayDoneOpen = !todayDoneOpen; renderTodos(); };
    kids.push(h('div.group.done', null,
      h('h2.backlog-head', {
        role: 'button', tabindex: '0', 'aria-expanded': String(todayDoneOpen), title: todayDoneOpen ? '접기' : '펼치기',
        onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
      }, h('span.caret', { text: todayDoneOpen ? '▾' : '▸' }), h('span', { text: '오늘 끝냄' }), h('span.chip', { text: String(done.length) })),
      todayDoneOpen ? h('div.card.todos', null, done.map(doneRow)) : null));
  }
  return h('div.today-block', null, ...kids);
}

let backlogOpen = readBacklogOpen(globalThis.localStorage);
function toggleBacklog() {
  backlogOpen = !backlogOpen;
  writeBacklogOpen(globalThis.localStorage, backlogOpen);
  renderTodos();
}

// ---- 할 일 규칙: '규칙 N' 칩 → 짧은 목록(글·적용 횟수·켜기/끄기·지우기) ----
let rulesOpen = false;
const rulePending = new Map(); // id → { enabled } | 'delete' (응답 대기)
const visibleRules = () => overlayRules(vm.todoRules, rulePending);

function rulesBar() {
  const rules = visibleRules();
  const chip = h(`button.chip.rules-chip${rulesOpen ? '.on' : ''}`, {
    type: 'button', text: rulesChip(rules), 'aria-expanded': String(rulesOpen),
    title: '할 일 규칙',
    onclick: () => { rulesOpen = !rulesOpen; renderTodos(); },
  });
  const bar = h('div.todo-tools', null, chip, vm.stats.backlogTodos ? h('span.muted.small', { text: `언젠가 ${vm.stats.backlogTodos}개` }) : null);
  if (!rulesOpen) return bar;
  const list = rules.length
    ? rules.map((r) => h(`div.rule-row${r.enabled ? '' : '.off'}`, { dataset: { id: r.id } },
      h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `규칙 켜기: ${r.text}`, title: r.enabled ? '끄기' : '켜기', onchange: () => toggleRule(r) }),
      h('div.rule-main', null, h('span.rule-text', { text: r.text }), h('span.muted.small', { text: [r.summary, hitsLabel(r.hits)].filter(Boolean).join(' · ') })),
      h('button.ghost.rule-del', { type: 'button', text: '✕', title: '규칙 지우기', 'aria-label': `규칙 지우기: ${r.text}`, onclick: () => deleteRule(r) })))
    : [h('div.muted.small', { text: '규칙 없음' })];
  return h('div.todo-tools-wrap', null, bar, h('div.card.rules-list', null, list));
}

async function ruleCall(r, pending, call, failText) {
  rulePending.set(r.id, pending);
  renderTodos();
  let res;
  try { res = await call(); } catch { res = { ok: false }; }
  rulePending.delete(r.id);
  if (!res?.ok) todoMsg = { ok: false, text: `${failText} — ${why(res)}` };
  else loadSoon();
  renderTodos();
}
const toggleRule = (r) => ruleCall(r, { enabled: !r.enabled }, () => cy.todoRuleEdit(r.id, { enabled: !r.enabled }), '규칙 바꾸기 실패');
const deleteRule = (r) => ruleCall(r, 'delete', () => cy.todoRuleDelete(r.id), '규칙 지우기 실패');

function addForm() {
  const input = h('input', { id: 'todo-add-input', type: 'text', placeholder: '할 일 추가 — Enter', 'aria-label': '새 할 일' });
  input.value = addDraft;
  input.addEventListener('input', () => { addDraft = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    addTodo();
  });
  return h('div.todo-add', null,
    input,
    prioritySelect(addPriority, (p) => { addPriority = p; }),
    h('button.primary', { type: 'button', text: '추가', onclick: () => addTodo() }));
}

function prioritySelect(value, onChange) {
  const sel = h('select.prio', { 'aria-label': '우선순위' }, PRIORITIES.map((p) => h('option', { value: String(p.value), text: p.label })));
  sel.value = String(value);
  sel.addEventListener('change', () => onChange(Number(sel.value)));
  return sel;
}

// ---- 할 일 줄: 한 번 = 펼침, 두 번 = 제목·설명 고치기, 꾹 눌러 끌기 = 순서·우선순위, Alt+↑↓/1·2·3 = 키보드로 같은 일 ----
const ROW_CONTROLS = 'button, select, input, textarea, a, label, .todo-detail, .inline-confirm';
const findTodo = (id) => vm.todoGroups.flatMap((g) => g.items).find((t) => t.id === id);
const sorter = createClickSorter({
  onSingle: (id) => toggleDetail(id),
  onDouble: (id) => startTodoEdit(id),
});
let suppressClick = false; // 끌기를 끝낸 직후의 click 은 무시

function toggleDetail(id) {
  openId = toggleOpen(openId, id);
  refocusId = id;
  if (openId) loadDetail(openId);
  renderTodos();
}

async function loadDetail(id, force = false) {
  const cur = details.get(id);
  if (cur && (cur.status === 'loading' || (cur.status === 'ok' && !force))) return;
  details.set(id, { status: 'loading' });
  let r;
  try { r = await cy.todoDetail(id); } catch { r = { ok: false }; }
  details.set(id, r?.ok && r.data ? { status: 'ok', data: r.data } : { status: 'error', error: r?.status === 404 ? '이 할 일을 못 찾았어요.' : `설명을 못 불러왔어요 — ${why(r)}` });
  if (details.get(id)?.status === 'ok') fillEditDesc(id, details.get(id).data?.description);
  if (openId === id) renderTodos();
}

function todoRow(t) {
  if (todoEditing?.id === t.id) return todoEditRow(t);
  const open = openId === t.id;
  const confirming = isConfirming(confirmState, 'trash', t.id);
  const flashing = flash?.id === t.id && Date.now() < flash.until;
  const row = h(`div.todo.row${t.pending ? '.pending' : ''}${open ? '.open' : ''}${confirming ? '.confirming' : ''}${flashing ? '.flash' : ''}`, {
    dataset: { id: t.id }, tabindex: '0', role: 'button', 'aria-expanded': String(open),
    'aria-label': `${t.title} — Enter 설명, Shift+Enter 제목·설명 고치기, Alt+↑↓ 순서, Alt+1~4 우선순위(오늘 꼭·이번 주·나중에·언젠가), Delete 휴지통`,
    title: '눌러서 설명 · 두 번 눌러 제목·설명 고치기 · 꾹 눌러 끌어서 순서·우선순위',
    onclick: (e) => {
      if (suppressClick) { suppressClick = false; return; }
      if (t.pending || e.target.closest(ROW_CONTROLS)) return;
      sorter.click(t.id, e.clientX);
    },
    onkeydown: (e) => onRowKey(t, e),
    onpointerdown: (e) => onRowPointerDown(t, e),
  },
  h('input.check', { type: 'checkbox', 'aria-label': `완료: ${t.title}`, title: '완료', disabled: t.pending, onchange: () => completeTodo(t) }),
  // (진행중): 사용자가 ▶ 로 켠 것, 아니면 작업 세션을 보니 하는 중(todo-progress.ts 가 진척을 남김) → 제목 앞
  h('span.t', null, isDoing(t) ? h('span.doing', { text: '(진행중) ', title: t.progress ? `진행: ${t.progress}` : '직접 진행중으로 표시' }) : null, t.title),
  t.source ? h(`span.chip.src-${t.source}`, { text: SOURCE_LABELS[t.source] ?? t.source }) : null,
  dueBadge(t),
  confirming ? null : todayButton(t),
  confirming ? null : doingButton(t),
  confirming ? null : skipButton(t),
  confirming ? confirmBox('trash', () => trashTodo(t)) : trashButton(t));
  return open ? h('div.todo-wrap', null, row, todoDetailView(t)) : row;
}

// 마감 칩(「10/21 마감」·「오늘 마감」·「지남」). 마감이 없으면 null
function dueBadge(t) {
  const d = t.due && dueChip(t.due);
  return d ? h(`span.chip.due.due-${d.kind}`, { text: d.text, title: '미리알림 마감' }) : null;
}

function onRowKey(t, e) {
  if (e.target !== e.currentTarget || e.isComposing || e.keyCode === 229) return;
  const digit = /^Digit([1234])$/.exec(e.code)?.[1]; // 맥에서 Alt+1 은 key 가 '¡'. 4 = 백로그
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || digit)) {
    e.preventDefault();
    if (t.pending) return;
    const m = keyMove(listTodos(), t.id, digit ?? e.key);
    if (m) { refocusId = t.id; moveTodo(t.id, m.priority, m.beforeId); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) startTodoEdit(t.id); else toggleDetail(t.id);
  } else if (isTrashKey(e)) {
    e.preventDefault();
    askTrash(t);
  }
}

// 이 할 일에 적용된 할 일 규칙(있으면)
const ruleLine = (t) => (t.appliedRule ? h('div.applied-rule.muted.small', { title: '할 일 규칙이 우선순위·메모를 정했어요' }, h('span', { text: `📏 규칙: ${t.appliedRule.text}` })) : null);
// 어디까지 됐는지(데몬이 작업 세션을 읽고 남긴 한 줄 — 사용자 메모와 따로)
const progressLine = (t) => (t.progress ? h('div.applied-rule.muted.small', { title: '작업 세션을 보고 비서가 남긴 진척' }, h('span', { text: `⏳ 진행: ${t.progress}` })) : null);

// 펼친 설명: 링크가 있으면 설명을 눌러 원본으로. 원본(Slack 메시지·커밋·메일·세션) 블록
function todoDetailView(t) {
  const d = details.get(t.id);
  if (!d || d.status === 'loading') {
    return h('div.todo-detail', null,
      ruleLine(t),
      progressLine(t),
      t.description ? h('p.desc', { text: t.description }) : null,
      h('div.detail-loading.muted.small', null, h('span.spin'), h('span', { text: t.description ? '원본 찾는 중…' : '설명 만드는 중…' })));
  }
  if (d.status === 'error') {
    return h('div.todo-detail', null, h('span.muted', { text: d.error }), h('button.ghost', { type: 'button', text: '다시', onclick: () => loadDetail(t.id, true).then(renderTodos) }));
  }
  const v = detailView(d.data);
  const s = v.source;
  return h('div.todo-detail', null,
    ruleLine(t),
    progressLine(t),
    descNode(t, v.description || t.description || '', v.link),
    s ? h('div.origin', null,
      h('div.origin-head', null,
        h(`span.chip.src-${s.kind}`, { text: s.kindLabel }),
        s.meta.length ? h('span.muted.small', { text: s.meta.join(' · ') }) : null,
        s.permalink ? h('a.small', { href: s.permalink, text: '원본 보기' }) : null),
      s.excerpt ? h(s.quote ? 'blockquote.excerpt' : 'p.excerpt', { text: s.excerpt }) : null)
      : null);
}

// ---- 그 자리 고치기: 줄을 두 번 누르면(Shift+Enter 도) 제목·설명을 바로 고친다. AI 없이, 뇌 연결과 상관없이 같다 ----
// 펼친 설명을 두 번 눌러도 같은 편집기(설명 칸에 포커스). 설명을 한 번 누르면(링크 있으면) 원본 열기
let todoEditing = null; // todo-edit.js 상태(null = 안 고침)
const descSorter = createClickSorter({
  onSingle: (_id, link) => { if (link) cy.openLink(link); },
  onDouble: (id) => startTodoEdit(id, 'desc'),
});

function descNode(t, text, link) {
  return h(`p.desc${link ? '.link' : ''}${text ? '' : '.empty'}`, {
    text: text || '설명 없음',
    title: link ? '원본 열기 · 두 번 눌러 제목·설명 고치기' : '두 번 눌러 제목·설명 고치기',
    role: link ? 'link' : 'button', tabindex: '0',
    onclick: (e) => { e.stopPropagation(); descSorter.click(t.id, link); },
    onkeydown: (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      if (link && !e.shiftKey) cy.openLink(link); else startTodoEdit(t.id, 'desc');
    },
  });
}

function startTodoEdit(id, focus = 'title') {
  const t = findTodo(id);
  if (!t || t.pending) return;
  if (todoEditing && todoEditing.id !== id) finishTodoEdit(true);
  sorter.cancel();
  cancelPress();
  if (todoEditing?.id !== id) todoEditing = openEdit(t, details.get(id));
  if (!todoEditing) return;
  const a = document.activeElement;
  if (a && a !== document.body && listSec().contains(a)) a.blur(); // 줄 안 칸(체크 등)에 포커스가 있으면 다시 그리지 않으니까
  loadDetail(id); // 설명이 아직 없으면 불러온다(오면 안 건드린 설명만 채움)
  renderTodos();
  const box = listSec().querySelector(`.todo-edit[data-id="${CSS.escape(id)}"]`);
  const el = box?.querySelector(focus === 'desc' ? 'textarea.edit-desc' : 'input.edit-title');
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

// 상세가 편집 중에 왔다: 설명 칸을 안 건드렸으면 그 값으로 채운다(다시 그리지 않고 칸만)
function fillEditDesc(id, description) {
  if (todoEditing?.id !== id) return;
  const next = fillDescription(todoEditing, description);
  if (next === todoEditing) return;
  todoEditing = next;
  for (const ta of document.querySelectorAll(`.todo-edit[data-id="${CSS.escape(id)}"] textarea.edit-desc`)) { ta.value = next.desc; growDesc(ta); }
}

const growDesc = (ta) => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 320)}px`; };

// 편집기: 줄과 펼친 설명 자리에 제목 칸 + 설명 칸. 끌기·한 번 누르기·키보드 이동은 붙이지 않는다
function todoEditRow(t) {
  const s = todoEditing;
  const title = h('input.edit-title', { type: 'text', 'aria-label': `제목 고치기: ${t.title}`, placeholder: '제목' });
  title.value = s.title;
  const desc = h('textarea.edit-desc', { rows: '2', 'aria-label': '설명 고치기', placeholder: '설명' });
  desc.value = s.desc;
  const box = h('div.todo.todo-edit', { dataset: { id: t.id } },
    title, desc,
    h('div.edit-hint.muted.small', { text: 'Enter 저장 · 설명 줄바꿈은 Shift+Enter · Esc 취소' }));
  title.addEventListener('input', () => { if (todoEditing?.id === t.id) todoEditing = { ...todoEditing, title: title.value }; });
  desc.addEventListener('input', () => {
    if (todoEditing?.id === t.id) todoEditing = { ...todoEditing, desc: desc.value, descTouched: true };
    growDesc(desc);
  });
  const onKey = (field) => (e) => {
    const k = editKey(e, field); // 한글 조합 중엔 null
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    finishTodoEdit(k === 'save', true);
  };
  title.addEventListener('keydown', onKey('title'));
  desc.addEventListener('keydown', onKey('desc'));
  // 바깥을 누르거나 포커스가 빠지면 저장. 두 칸 사이 이동, 다른 앱으로 잠깐 간 건 그대로
  box.addEventListener('focusout', () => setTimeout(() => {
    if (todoEditing?.id !== t.id || box.contains(document.activeElement)) return;
    finishTodoEdit(true);
  }, 0));
  box.addEventListener('mousedown', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault(); }); // 안내 글·빈 곳을 눌러도 포커스 그대로
  requestAnimationFrame(() => growDesc(desc));
  return box;
}

function finishTodoEdit(save, refocus = false) {
  const s = todoEditing;
  if (!s) return;
  todoEditing = null;
  const t = findTodo(s.id);
  if (refocus) refocusId = s.id; // 키보드로 끝냈으면 그 줄로 포커스
  if (document.activeElement?.closest?.('.todo-edit')) document.activeElement.blur(); // 칸에 포커스가 있으면 다시 그리지 않으니까
  if (save && t) saveTodoEdit(t, s);
  renderTodos();
}

// 낙관적: 목록·펼친 설명을 바로 바꾸고, 실패하면 되돌린다. 바뀐 필드만 보낸다
function saveTodoEdit(t, s) {
  const { patch, notice } = editPatch(t, s);
  if (patch) {
    const prev = details.get(t.id);
    if ('description' in patch && prev?.status === 'ok') details.set(t.id, { status: 'ok', data: { ...prev.data, description: patch.description } });
    mutate({ kind: 'edit', id: t.id, patch }, () => cy.todoEdit(t.id, patch), '고치기 실패', () => {
      setRawTodos(rawTodos().map((x) => (x.id === t.id ? { ...x, ...patch, userEdited: true } : x)));
    }).then((res) => { if (!res?.ok && prev) { details.set(t.id, prev); renderTodos(); } });
  }
  if (notice) todoMsg = { ok: false, text: notice }; // 빈 제목: 원래 제목 그대로(mutate 가 지운 뒤에 단다)
}

// ---- 꾹 눌러 끌기 ----
let press = null; // { id, x, y, timer }
let drag = null; // { id, ghost, line, target, raf, y }
let dragGroups = false;

function onRowPointerDown(t, e) {
  if (e.button !== 0 || t.pending || e.target.closest(ROW_CONTROLS)) return;
  cancelPress();
  press = { id: t.id, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, timer: setTimeout(() => startDrag(press?.x, press?.y), LONG_PRESS) };
}
function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function startDrag(x, y) {
  const id = press?.id;
  cancelPress();
  const t = id && findTodo(id);
  if (!t) return;
  sorter.cancel();
  window.getSelection()?.removeAllRanges();
  dragGroups = true;
  renderTodos(); // 빈 우선순위 칸까지 그린 뒤 고정
  const row = listSec().querySelector(`.todo.row[data-id="${CSS.escape(id)}"]`);
  if (!row) { dragGroups = false; return; }
  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true);
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
  const line = h('div.drop-line');
  document.body.append(ghost, line);
  document.body.classList.add('dragging-todo');
  row.classList.add('drag-src');
  drag = { id, ghost, line, target: null, raf: 0, y, x, offY: y - rect.top };
  moveDrag(y, x);
}

function dropGroups() {
  return [...listSec().querySelectorAll('.group[data-priority]')].map((g) => {
    const card = g.querySelector('.card.todos').getBoundingClientRect();
    const head = g.getBoundingClientRect();
    return {
      priority: Number(g.dataset.priority), top: head.top, bottom: head.bottom, left: card.left, width: card.width,
      rows: [...g.querySelectorAll('.todo.row')].map((r) => { const b = r.getBoundingClientRect(); return { id: r.dataset.id, top: b.top, bottom: b.bottom }; }),
    };
  });
}

function moveDrag(y, x) {
  if (!drag) return;
  drag.y = y;
  if (x != null) drag.x = x;
  drag.ghost.style.top = `${y - drag.offY}px`;
  // 휴지통 묶음 위면 휴지통으로(놓으면 확인)
  const tg = listSec().querySelector('.group.trash');
  const hot = !!tg && overTrash(drag.x, y, tg.getBoundingClientRect());
  tg?.classList.toggle('drop-hot', hot);
  if (hot) {
    drag.target = { trash: true };
    drag.line.hidden = true;
    const box = $('content').getBoundingClientRect();
    if (autoScrollDelta(y, box) && !drag.raf) drag.raf = requestAnimationFrame(scrollTick);
    return;
  }
  const groups = dropGroups();
  const tgt = dropTarget(y, groups, drag.id);
  drag.target = tgt;
  const g = tgt && groups.find((x) => x.priority === tgt.priority);
  drag.line.hidden = !g;
  if (g) Object.assign(drag.line.style, { top: `${tgt.y - 1}px`, left: `${g.left + 6}px`, width: `${g.width - 12}px` });
  // 가장자리 근처면 자동 스크롤
  const box = $('content').getBoundingClientRect();
  if (autoScrollDelta(y, box) && !drag.raf) drag.raf = requestAnimationFrame(scrollTick);
}
function scrollTick() {
  if (!drag) return;
  drag.raf = 0;
  const content = $('content');
  const d = autoScrollDelta(drag.y, content.getBoundingClientRect());
  if (!d) return;
  content.scrollTop += d;
  moveDrag(drag.y);
}

function finishDrag(commit) {
  if (!drag) return;
  const { id, target, ghost, line, raf } = drag;
  cancelAnimationFrame(raf);
  ghost.remove();
  line.remove();
  document.body.classList.remove('dragging-todo');
  drag = null;
  dragGroups = false;
  refocusId = id;
  renderTodos();
  if (commit && target?.trash) askTrash(findTodo(id));
  else if (commit && target) moveTodo(id, target.priority, target.beforeId);
}

document.addEventListener('pointermove', (e) => {
  if (drag) { e.preventDefault(); moveDrag(e.clientY, e.clientX); return; }
  if (press) {
    press.x = e.clientX; press.y = e.clientY;
    if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > MOVE_SLOP) cancelPress();
  }
});
document.addEventListener('pointerup', () => {
  if (drag) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); finishDrag(true); } else cancelPress();
});
document.addEventListener('pointercancel', () => { if (drag) finishDrag(false); else cancelPress(); });

// ---- 채팅: 대화 목록(스레드) + 선택한 대화 ----
const chatLog = $('chat-log');
const chatInput = $('chat-input');
// 첨부: 📎 · 대화 쪽에 끌어다 놓기 · ⌘V(스크린샷·파일). 붙이자마자 데몬에 올린다(보낼 때는 id 만)
let attErrTimer = null;
function showAttError(msg) {
  const el = $('chat-att-err');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(attErrTimer);
  attErrTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
const tray = createAttachTray({
  tray: $('chat-tray'), input: chatInput, drop: $('th-main'), pick: $('chat-attach'),
  upload: (name, mime, bytes) => (cy.chatAttach ? cy.chatAttach(name, mime, bytes) : Promise.resolve({ ok: false })),
  onChange: () => renderSendButton(),
  onError: showAttError,
});
if (!cy.chatAttach) $('chat-attach').hidden = true;
const chatSec = $('sec-chat');
const thList = $('th-list');
const thSearch = $('th-search');
const thTitle = $('th-title');
const thTitleInput = $('th-title-input');
const thTodo = $('th-todo');
const thArchiveToggle = $('th-archive-toggle');

let threads = []; // 보관 안 한 스레드(최근 순)
let archived = null; // 보관함 보기일 때만 목록
let showArchived = false;
let selectedId = null; // null = 새 대화(첫 말을 보내면 스레드가 생김)
let messages = []; // 선택한 스레드의 말
// 고치는 중인 내 말(✏️ — 아래 "말 고치기")
let editingMsg = null; // { key: 'n:<순번>' | 'q:<chatId>', kind: 'sent'|'queued', n?, chatId?, text, el?, saving?, error? }
let moreAbove = false;
let thQuery = '';
let rowMode = null; // { id, mode: 'rename' | 'delete' | 'archive' | 'unarchive' }
let listOpen = false; // 좁은 창에서 목록 펼침
let threadsLoaded = false;
const drafts = new Map(); // 스레드별 입력 중인 글(null 키 = 새 대화)
let seen = {};
let seenLoaded = false;
let msgSeq = 0;
let loadedUpdated = null; // 선택한 스레드를 마지막으로 불러올 때의 updated
// 대화 속 서브에이전트(아래 "대화 속 서브에이전트")
const chatAgentsEl = $('chat-agents');
let agents = []; // 선택한 대화의 서브에이전트(시작 순)
let agentsFor = null; // agents 를 받은 대화 id
let agentsSeq = 0;
let agentsDoneOpen = false; // "에이전트 N개 끝남 ▸" 펼침
let agentsTimer = null;
const agentCardEls = new Map(); // runId/toolUseId → 대화 속 카드(진행만 바뀌면 그 카드만 고친다)
// 대화 속 작업 세션 카드(같은 응답의 sessions — 채팅이 넘긴 수정 run). 진행 줄·경과만 바뀌면 그 카드만 고친다
let sessions = [];
const sessionCardEls = new Map(); // runId → 카드
// 대화 속 워크트리 카드(같은 응답의 worktrees — 한 답이 판 워크트리들). 토큰·상태만 바뀌면 그 카드만 고친다
let worktrees = [];
const wtCardEls = new Map(); // 첫 줄 key → { el, keys }

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
};
function saveSeen() { store.set('threadSeen', JSON.stringify(seen)); }
const allThreads = () => (showArchived ? archived ?? [] : threads);
const currentThread = () => threads.find((t) => t.id === selectedId) ?? archived?.find((t) => t.id === selectedId) ?? null;

// ---- 확인 카드(회의 응답 등): 답 아래에 [실행]/[취소]. 누르기 전엔 아무것도 보내지 않는다 ----
let threadActions = []; // 선택한 대화의 카드
const actionLocal = new Map(); // id → 'confirming' | 'cancelling' | { error }

// 머지 승인 카드(채팅에서 시킨 PR 머지): PR 머리·링크, 대상(base ← head)·검사·충돌·리뷰, ✓ 머지 / ✗ 안 함.
// 캐릭터 말풍선과 같은 결정 — 어디서 누르든 결과(머지됨 + 머지 커밋 / 안 함 / 실패 이유)로 접힌다
function mergeCardEl(a, v, opts) {
  const rows = v.rows.length ? h('dl.ac-fields.merge-rows', null, v.rows.flatMap((r) => [h('dt', { text: r.label }), h(`dd.t-${r.tone}${r.code ? '.code' : ''}`, { text: r.value, title: r.value })])) : null;
  const prLink = v.url ? h('button.link.ac-pr', { type: 'button', text: 'PR 보기 ↗', title: v.url, onclick: () => cy.openLink(v.url) }) : null;
  const commit = v.link ? h('button.link.ac-commit', { type: 'button', text: '머지 커밋 ↗', title: v.link, onclick: () => cy.openLink(v.link) }) : null;
  if (opts.fold && foldedPermission(a) && !actionLocal.get(a.id)) {
    return h(`details.action-card.merge.folded.s-${v.state}`, { dataset: { id: a.id } },
      // 접힌 줄에서도 PR 로 바로(머지한 뒤에도) — 누르면 펼치지 않고 PR 을 연다
      h('summary', null, h('span.ac-fold-head', { text: v.head }), v.status ? h(`span.ac-status.${v.tone}`, { text: v.status }) : null,
        v.url ? h('button.link.ac-pr', { type: 'button', text: 'PR ↗', title: v.url, onclick: (e) => { e.preventDefault(); e.stopPropagation(); cy.openLink(v.url); } }) : null,
        timeEl(a.created)),
      rows, h('div.ac-links', null, prLink, commit));
  }
  return h(`div.action-card.merge.s-${v.state}`, { dataset: { id: a.id } },
    h('div.ac-kind', { text: '머지 승인' }),
    h('div.ac-head', null, h('span', { text: v.head }), timeEl(a.created)),
    v.sub ? h('div.ac-sub', null, h('span', { text: v.sub }), prLink) : prLink,
    rows,
    v.blocked ? h('div.ac-blocked', { role: 'note', text: `✋ ${v.blocked}` }) : null,
    v.question ? h('div.ac-q', { text: v.question }) : null,
    v.buttons.length ? h('div.ac-acts', null, v.buttons.map((b) => h(`button.${b.primary ? 'primary' : 'ghost'}.ac-${b.decision}`,
      { type: 'button', text: b.label, title: b.title ?? '', disabled: v.disabled || !!b.disabled, onclick: () => decideAction(a, b.decision) }))) : null,
    v.status ? h(`div.ac-status.${v.tone}`, { role: 'status' }, h('span', { text: v.status }), commit) : null);
}

function actionCard(a, opts = {}) {
  const local = actionLocal.get(a.id) ?? null;
  const v = cardView(a, local);
  if (v.merge) return mergeCardEl(a, v, opts);
  // 결정이 끝난 도구 승인은 한 줄로 접기(채팅) — 줄줄이 쌓여 답을 가리지 않게
  if (opts.fold && foldedPermission(a) && !local) {
    return h(`details.action-card.perm.folded.s-${v.state}`, { dataset: { id: a.id } },
      h('summary', null, h('span.ac-fold-head', { text: `🔐 ${v.head}` }), v.status ? h(`span.ac-status.${v.tone}`, { text: v.status }) : null, timeEl(a.created)),
      v.fields.length ? h('dl.ac-fields', null, v.fields.flatMap((f) => [h('dt', { text: f.label }), h('dd', { text: f.value, title: f.value })])) : null,
      v.body ? h(`pre.ac-body.${v.bodyKind}`, { text: v.body }) : null);
  }
  return h(`div.action-card.s-${v.state}${v.permission ? '.perm' : ''}`, { dataset: { id: a.id } },
    v.permission ? h('div.ac-kind', { text: '🔐 승인 요청' }) : null,
    h('div.ac-head', null, h('span', { text: v.head }), timeEl(a.created)),
    v.question ? md(h('div.ac-q'), v.question) : null,
    v.fields.length ? h('dl.ac-fields', null, v.fields.flatMap((f) => [h('dt', { text: f.label }), h('dd', { text: f.value, title: f.value })])) : null,
    v.body ? h(`pre.ac-body.${v.bodyKind}`, { text: v.body }) : null,
    v.comment ? h('div.ac-comment', { text: `메모: ${v.comment}` }) : null,
    v.buttons.length ? h('div.ac-acts', null, v.buttons.map((b) => h(`button.${b.primary ? 'primary' : b.danger ? 'ghost.danger' : 'ghost'}.ac-${b.decision}`,
      { type: 'button', text: b.label, title: b.title ?? '', disabled: v.disabled, onclick: () => decideAction(a, b.decision) }))) : null,
    v.status ? h(`div.ac-status.${v.tone}`, { role: 'status', text: v.status }) : null);
}

// 승인 카드 여럿: 결정이 끝난 도구 승인이 2개 이상이면 한 줄 묶음(「🔐 셸 명령 14번 허용 · 1번 취소 ▸」, 펼치면 하나씩) + 나머지는 그대로
const groupOpen = new Set(); // 펼친 묶음(첫 카드 id) — 다시 그려도 펼친 채
function pushApprovals(items, cards) {
  if (!cards?.length) return;
  const f = foldApprovals(cards.filter((a) => !actionLocal.get(a.id)));
  const busy = cards.filter((a) => actionLocal.get(a.id));
  if (f.group) {
    const key = f.group[0].id;
    const el = h('details.action-group', { dataset: { id: key }, ...(groupOpen.has(key) ? { open: true } : {}) },
      h('summary', null, h('span.ac-fold-head', { text: f.summary }), timeEl(f.group[0].created)),
      f.group.map((a) => actionCard(a, { fold: true })));
    el.addEventListener('toggle', () => { if (el.open) groupOpen.add(key); else groupOpen.delete(key); });
    items.push(el);
  }
  for (const a of [...f.rest, ...busy]) items.push(actionCard(a, { fold: true }));
}

function updateAction(a) {
  if (!a) return;
  if (a.threadId && a.threadId === selectedId) threadActions = upsertAction(threadActions, a);
  if (a.type === 'tool_permission' && a.status === 'done' && /항상 허용/.test(a.result?.message ?? '')) loadPermissions();
}

async function decideAction(a, decision) {
  if (['confirming', 'cancelling', 'always'].includes(actionLocal.get(a.id))) return;
  actionLocal.set(a.id, decision === 'confirm' ? 'confirming' : decision === 'always' ? 'always' : 'cancelling');
  renderChat();
  let r;
  try { r = await cy.actionDecide(a.id, decision); } catch { r = { ok: false }; }
  const out = decideResult(a, decision, r);
  if (out.error) actionLocal.set(a.id, { error: out.error }); else actionLocal.delete(a.id);
  updateAction(out.action);
  renderChat();
}

function onActionEvent(p) {
  const a = normalizeActions([p?.action])[0];
  if (!a) return;
  if (actionLocal.get(a.id) && a.status !== 'pending') actionLocal.delete(a.id);
  const before = threadActions;
  updateAction(a);
  if (before !== threadActions) renderChat();
}

// progress: thinking/step 이벤트 — 대화 상태의 모양이 그대로면 「답하는 중」 글만 고치고 끝낸다.
// view=false: 다른 대화의 이벤트라 이 대화 화면은 그대로
function dispatchChat(action, { view = true, progress = false } = {}) {
  const shape = pendingShape(chat);
  chat = chatReducer(chat, action);
  if (chat.replies.length) chat = chatReducer(chat, { type: 'consumed' }); // 패널은 대화 목록으로 다 보여줌
  if (progress && view && pendingShape(chat) === shape && patchTyping()) return;
  if (view) renderChat();
  renderThreadList();
  renderBadges();
}

// 진행 표시(「답하는 중」 글)만 고친다. 그 자리가 없으면 false
function patchTyping() {
  if (!chatShown()) { chatDirty = true; return true; }
  const span = chatLog.querySelector('.typing > span');
  if (!span || !selectedId || !isRunning(chat, selectedId)) return false;
  span.textContent = busyLabel(chat, selectedId);
  return true;
}

async function loadThreads() {
  let r;
  try { r = await cy.chatThreads(false); } catch { return; }
  if (!r?.ok || !Array.isArray(r.data?.threads)) return;
  threads = normThreads(r.data.threads);
  if (!seenLoaded) {
    let stored = null;
    try { stored = JSON.parse(store.get('threadSeen') ?? 'null'); } catch { stored = null; }
    seen = initSeen(stored, threads);
    seenLoaded = true;
    saveSeen();
  } else {
    seen = pruneSeen(seen, [...threads, ...(archived ?? [])]);
  }
  if (!threadsLoaded) {
    threadsLoaded = true;
    if (selectedId === null && !pendingOpen) selectThread(pickInitial(threads, store.get('thread')), { keepList: true });
  }
  if (showArchived) await loadArchived();
  afterThreadsChanged();
}
let threadsTimer = null;
const loadThreadsSoon = () => { clearTimeout(threadsTimer); threadsTimer = setTimeout(loadThreads, 200); };

async function loadArchived() {
  let r;
  try { r = await cy.chatThreads(true); } catch { return; }
  if (r?.ok && Array.isArray(r.data?.threads)) archived = normThreads(r.data.threads);
}

// 목록이 바뀐 뒤: 선택한 스레드가 바뀌었으면(새 답·시스템 줄) 말을 다시, 읽음 처리, 그리기
function afterThreadsChanged() {
  const cur = currentThread();
  if (selectedId && cur && cur.updated !== loadedUpdated) loadMessages({ ifStale: true });
  if (cur && section === 'chat' && document.visibilityState !== 'hidden') {
    const next = markSeen(seen, cur);
    if (next !== seen) { seen = next; saveSeen(); }
  }
  renderThreadList();
  renderThreadHead();
  renderBadges();
}

// 보낸 말의 미리보기 blob: 주소 해제 — next(남는 말들)와 입력창 칩이 아직 쓰는 주소는 남긴다
function releaseBlobs(prev, next) {
  const keep = new Set(tray.items().map((a) => a.localUrl));
  for (const m of next) for (const a of m.attachments ?? []) keep.add(a.localUrl);
  for (const m of prev) for (const a of m.attachments ?? []) if (a.localUrl?.startsWith('blob:') && !keep.has(a.localUrl)) { URL.revokeObjectURL(a.localUrl); keep.add(a.localUrl); }
}

// 같은 스레드의 최신 말 조회는 하나만 돈다. 도는 동안 온 요청은 끝난 뒤 한 번만 더(ifStale: 그때도 목록보다 뒤처졌을 때만)
let msgJob = null; // { id, again: null | 'stale' | 'force', promise }
function loadMessages(opts = {}) {
  if (opts.older) return loadMessagesNow(selectedId, opts);
  const id = selectedId;
  if (!id) return undefined;
  if (msgJob?.id === id) {
    msgJob.again = opts.ifStale ? msgJob.again ?? 'stale' : 'force';
    return msgJob.promise;
  }
  const job = { id, again: null };
  msgJob = job;
  job.promise = (async () => {
    try {
      for (;;) {
        job.again = null;
        await loadMessagesNow(id);
        const cur = currentThread();
        if (id !== selectedId || !(job.again === 'force' || (job.again === 'stale' && cur && cur.updated !== loadedUpdated))) break;
      }
    } finally { if (msgJob === job) msgJob = null; }
  })();
  return job.promise;
}

async function loadMessagesNow(id, opts = {}) {
  if (!id || id !== selectedId) return;
  const seq = ++msgSeq;
  const before = opts.older ? messages.find((m) => m.n != null)?.n : undefined;
  let r;
  try { r = await cy.chatThreadMessages(id, before); } catch { r = { ok: false }; }
  if (seq !== msgSeq || id !== selectedId) return;
  if (r?.ok && Array.isArray(r.data?.messages)) {
    const prev = messages;
    messages = mergeMessages(messages, r.data.messages, { older: !!opts.older });
    releaseBlobs(prev, messages);
    if (Array.isArray(r.data.actions)) for (const a of r.data.actions) threadActions = upsertAction(threadActions, a);
    moreAbove = !!r.data.more;
    if (r.data.thread) {
      const t = normThread(r.data.thread);
      if (t && !t.archived) threads = upsertThread(threads, t);
      loadedUpdated = t?.updated ?? loadedUpdated;
    }
    renderChat({ keepScroll: !!opts.older });
    renderThreadHead();
  } else if (r?.status === 404) {
    // 다른 데서 지웠다
    threads = threads.filter((t) => t.id !== id);
    selectThread(null);
  }
}

function selectThread(id, opts = {}) {
  const prevId = selectedId;
  drafts.set(prevId, chatInput.value);
  selectedId = id ?? null;
  store.set('thread', selectedId ?? '');
  if (prevId !== selectedId || opts.reload) {
    releaseBlobs(messages, []);
    messages = [];
    threadActions = [];
    moreAbove = false;
    loadedUpdated = null;
    msgSeq++;
    agents = [];
    sessions = [];
    worktrees = [];
    agentsFor = null;
    agentsDoneOpen = false;
    renderAgents();
    if (selectedId) { loadMessages(); loadAgents(); }
  }
  rowMode = rowMode?.id === selectedId ? rowMode : null;
  endTitleEdit(false);
  chatInput.value = drafts.get(selectedId) ?? '';
  autosize();
  if (!opts.keepList) setListOpen(false);
  const t = currentThread();
  if (t) { seen = markSeen(seen, t); saveSeen(); }
  renderChat();
  renderThreadList();
  renderThreadHead();
  renderBadges();
  if (section === 'chat' && !opts.noFocus) chatInput.focus();
}

function newChat() {
  if (section !== 'chat') goto('chat');
  if (showArchived) toggleArchived(false);
  selectThread(null);
  drafts.set(null, '');
  chatInput.value = '';
  autosize();
  chatInput.focus();
}

// 다른 곳(말풍선 등)에서 그 대화를 열어 달라고 할 때 — 목록에 아직 없으면 불러온 뒤
let pendingOpen = null;
async function openThread(id) {
  if (!okThreadId(id)) return;
  pendingOpen = id;
  if (section !== 'chat') goto('chat');
  if (!threads.some((t) => t.id === id)) await loadThreads();
  if (pendingOpen !== id) return;
  pendingOpen = null;
  if (showArchived && !archived?.some((t) => t.id === id)) toggleArchived(false);
  selectThread(id, { reload: true });
}

function toggleArchived(on = !showArchived) {
  showArchived = on;
  thArchiveToggle.setAttribute('aria-pressed', String(on));
  thArchiveToggle.textContent = on ? '← 대화 목록' : '보관함';
  rowMode = null;
  if (on) loadArchived().then(() => renderThreadList());
  renderThreadList();
}

function setListOpen(on) {
  listOpen = !!on;
  chatSec.classList.toggle('list-open', listOpen);
  $('th-toggle').setAttribute('aria-expanded', String(listOpen));
  $('th-scrim').hidden = !listOpen;
}

// 보이는 순서(⌘↑/⌘↓)
function visibleOrder() {
  return groupThreads(filterThreads(allThreads(), thQuery)).flatMap((g) => g.items.map((t) => t.id));
}

function renderThreadList() {
  if (!chatShown()) { chatDirty = true; return; }
  const busy = busyThreads(chat);
  const list = filterThreads(allThreads(), thQuery);
  const kids = [];
  if (showArchived) {
    kids.push(h('div.th-group', { text: `보관함 (${list.length})` }));
    kids.push(...list.map((t) => threadRow(t, busy)));
  } else {
    for (const g of groupThreads(list)) kids.push(h('div.th-group', { text: g.label }), ...g.items.map((t) => threadRow(t, busy)));
  }
  if (!list.length) {
    kids.push(h('div.th-empty', { text: thQuery ? '찾는 대화가 없어요' : showArchived ? '보관한 대화가 없어요' : threadsLoaded ? '아직 대화가 없어요' : '불러오는 중…' }));
  }
  const focused = document.activeElement?.closest?.('.th-row')?.dataset.id;
  const renameFocused = document.activeElement?.classList.contains('th-rename');
  thList.replaceChildren(...kids);
  if (renameFocused) thList.querySelector('.th-rename')?.focus();
  else if (focused) thList.querySelector(`.th-row[data-id="${CSS.escape(focused)}"]`)?.focus();
}

function threadRow(t, busy) {
  const sel = t.id === selectedId;
  const unread = isUnread(seen, t, selectedId);
  const mode = rowMode?.id === t.id ? rowMode.mode : null;
  const icon = h('span.th-icon', { text: KIND_ICONS[t.kind] ?? '💬', title: KIND_LABELS[t.kind] ?? '' }); // 종류 표시는 이모지 그대로(색으로 한눈에 갈린다)
  if (mode === 'delete' || mode === 'archive') {
    const del = mode === 'delete';
    return h('div.th-row.confirm', { dataset: { id: t.id }, role: 'option', 'aria-selected': String(sel) },
      icon,
      h('span.th-ask', { text: del ? `"${t.title}" 지울까요? 되돌릴 수 없어요` : `"${t.title}" 보관할까요?` }),
      h('button.ghost', { type: 'button', text: '취소', onclick: (e) => { e.stopPropagation(); rowMode = null; renderThreadList(); } }),
      h(`button${del ? '.danger' : '.primary'}`, { type: 'button', text: del ? '삭제' : '보관', onclick: (e) => { e.stopPropagation(); del ? deleteThread(t.id) : archiveThread(t.id, true); } }));
  }
  if (mode === 'rename') {
    const input = h('input.th-rename', { type: 'text', value: t.title, 'aria-label': '대화 이름' });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      rowMode = null;
      if (save) renameThread(t.id, input.value);
      else renderThreadList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    requestAnimationFrame(() => { if (input.isConnected && document.activeElement !== input) { input.focus(); input.select(); } });
    return h('div.th-row', { dataset: { id: t.id }, role: 'option', 'aria-selected': String(sel) }, icon, input);
  }
  const act = (label, icon, fn) => h('button', { type: 'button', title: label, 'aria-label': label, onclick: (e) => { e.stopPropagation(); fn(); } }, navIcon(icon));
  return h(`div.th-row${unread ? '.unread' : ''}`, {
    dataset: { id: t.id }, role: 'option', tabindex: '0', 'aria-selected': String(sel), title: t.title,
    onclick: () => selectThread(t.id),
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); selectThread(t.id); } },
  },
  icon,
  h('span.th-text', null, h('span.th-name', { text: t.title }), t.preview ? h('span.th-prev', { text: t.preview.replace(/[*_`#>~]/g, '') }) : null),
  busy.has(t.id) ? h('span.spin.th-busy', { title: '답하는 중' }) : unread ? h('span.th-dot', { title: '새 답', 'aria-label': '새 답' }) : null,
  h('span.th-acts', null,
    act('이름 바꾸기', 'edit', () => { rowMode = { id: t.id, mode: 'rename' }; renderThreadList(); }),
    showArchived ? act('꺼내기', 'undo', () => archiveThread(t.id, false)) : act('보관', 'archive', () => { rowMode = { id: t.id, mode: 'archive' }; renderThreadList(); }),
    act('삭제', 'trash', () => { rowMode = { id: t.id, mode: 'delete' }; renderThreadList(); })));
}

async function renameThread(id, title) {
  const v = String(title ?? '').trim();
  const t = allThreads().find((x) => x.id === id);
  if (!v || !t || v === t.title) { renderThreadList(); renderThreadHead(); return; }
  const patch = (list) => list?.map((x) => (x.id === id ? { ...x, title: v } : x));
  threads = patch(threads); archived = patch(archived); // 바로 보이게
  renderThreadList(); renderThreadHead();
  let r;
  try { r = await cy.chatThreadEdit(id, { title: v }); } catch { r = { ok: false }; }
  if (!r?.ok) { setBanner(`이름을 못 바꿨어요 — ${why(r)}`); loadThreads(); }
}

async function archiveThread(id, on) {
  const order = visibleOrder();
  rowMode = null;
  let r;
  try { r = await cy.chatThreadEdit(id, { archived: on }); } catch { r = { ok: false }; }
  if (!r?.ok) { setBanner(`${on ? '보관' : '꺼내기'} 못 했어요 — ${why(r)}`); renderThreadList(); return; }
  if (on) {
    threads = threads.filter((t) => t.id !== id);
    if (selectedId === id) selectThread(afterRemoval(order, id), { noFocus: true });
  } else {
    archived = archived?.filter((t) => t.id !== id) ?? null;
    if (r.data?.thread) threads = upsertThread(threads, r.data.thread);
  }
  if (showArchived) await loadArchived();
  renderThreadList();
}

async function deleteThread(id) {
  const order = visibleOrder();
  rowMode = null;
  let r;
  try { r = await cy.chatThreadDelete(id); } catch { r = { ok: false }; }
  if (!r?.ok && r?.status !== 404) { setBanner(`못 지웠어요 — ${why(r)}`); renderThreadList(); return; }
  threads = threads.filter((t) => t.id !== id);
  archived = archived?.filter((t) => t.id !== id) ?? null;
  drafts.delete(id);
  if (selectedId === id) selectThread(afterRemoval(order, id), { noFocus: true });
  renderThreadList();
}

// 머리말: 종류 아이콘 · 제목(눌러서 이름 바꾸기) · 할 일 대화면 그 할 일 칩
function renderThreadHead() {
  const t = currentThread();
  $('th-kind').textContent = t ? KIND_ICONS[t.kind] ?? '' : '💬';
  if (thTitleInput.hidden) {
    thTitle.textContent = t ? t.title : '새 대화';
    thTitle.disabled = !t;
    thTitle.title = t ? '눌러서 이름 바꾸기' : '첫 말을 보내면 대화가 생겨요';
  }
  const chip = todoChip(t, rawTodos(), [...recentDone, ...(raw?.recentDone ?? [])]);
  thTodo.hidden = !chip;
  if (chip) {
    thTodo.textContent = chip.gone ? `✅ ${chip.title} (목록에 없음)` : chip.done ? `✔︎ ${chip.title} (끝남)` : `✅ ${chip.title}`;
    thTodo.title = chip.gone ? '이 할 일은 이제 목록에 없어요(지웠거나 오래전에 끝남)' : chip.done ? '끝난 할 일' : '할 일 목록에서 보기';
    thTodo.classList.toggle('gone', !!chip.gone);
    thTodo.classList.toggle('done', !!chip.done);
    thTodo.disabled = !chip.open;
    thTodo.dataset.id = chip.id;
  }
  $('th-sync').hidden = !(t?.cliSync && cy.chatThreadSync);
  chatInput.placeholder = t?.kind === 'todo'
    ? '이 할 일에 대해 — 예: 내일로 미뤄 / 끝났어 (바로 적용돼요 · Shift+Enter 줄바꿈)'
    : '물어보세요 — 예: 오늘 커밋 보여줘 (Shift+Enter 줄바꿈)';
}

function startTitleEdit() {
  const t = currentThread();
  if (!t) return;
  thTitleInput.value = t.title;
  thTitle.hidden = true;
  thTitleInput.hidden = false;
  thTitleInput.focus();
  thTitleInput.select();
}
function endTitleEdit(save) {
  if (thTitleInput.hidden) return;
  const id = selectedId;
  const v = thTitleInput.value;
  thTitleInput.hidden = true;
  thTitle.hidden = false;
  if (save && id) renameThread(id, v);
  renderThreadHead();
}
thTitle.addEventListener('click', startTitleEdit);
thTitleInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') { e.preventDefault(); endTitleEdit(true); chatInput.focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTitleEdit(false); chatInput.focus(); }
});
thTitleInput.addEventListener('blur', () => endTitleEdit(true));
thTodo.addEventListener('click', () => {
  const id = thTodo.dataset.id;
  if (!id || thTodo.disabled) return;
  goto('todos');
  if (openId !== id) toggleDetail(id);
});
$('th-new').addEventListener('click', newChat);
$('th-toggle').addEventListener('click', () => setListOpen(!listOpen));
$('th-scrim').addEventListener('click', () => setListOpen(false));
thArchiveToggle.addEventListener('click', () => toggleArchived());
thSearch.addEventListener('input', () => { thQuery = thSearch.value; renderThreadList(); });
thSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && thSearch.value) { e.preventDefault(); e.stopPropagation(); thSearch.value = ''; thQuery = ''; renderThreadList(); }
  else if (e.key === 'Enter' && !e.isComposing) { const first = visibleOrder()[0]; if (first) selectThread(first); }
});

function nearBottom() {
  return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80;
}
function scrollChat(force) {
  if (force || nearBottom()) requestAnimationFrame(() => { chatLog.scrollTop = chatLog.scrollHeight; });
}

// 작은 시각(18:22). 글자는 ::before(data-t)로만 그려서 선택·복사에 섞이지 않는다("…내용18:22" 안 되게). 올리면 전체 날짜·시각
function timeEl(iso) {
  const t = stamp(iso);
  return t ? h('span.when', { 'data-t': t.text, title: t.title }) : null;
}

// 말풍선 아래 한 줄(시각·상태) — 말풍선 쪽(내 말은 오른쪽, 답은 왼쪽)에 맞춘다
// status: 글 또는 { status, title, tone } — tone: sending|sent(내 말 보낸 상태)
function metaEl(m, status) {
  const st = typeof status === 'string' ? { status } : status;
  return h('div.msg-meta', null,
    m.via === 'cli' ? h('span.via-cli', { text: 'Claude Code', title: '터미널의 Claude Code(claude --resume)에서 이어 간 말을 불러온 거예요' }) : null,
    m.edited ? h('span.edited', { text: '수정됨', title: `${stamp(m.edited)?.title ?? ''} 고쳐서 다시 보낸 말이에요`.trim() }) : null,
    st?.status ? h(`span.st${st.tone ? `.s-${st.tone}` : ''}`, { 'data-s': st.status, ...(st.title ? { title: st.title } : {}) }) : null, timeEl(m.at));
}

// 내 말의 상태 줄: 못 보냄 · 보내는 중(받아들여졌는지·줄 섰는지 아직 모름) · 보냄(모델에 감 — 줄 섰다 갔으면 얼마나 기다렸는지)
// 서버 기록(로컬 사본 아님)은 줄 섰다 간 말만 「대기 N분 뒤 보냄」
function userStatus(m) {
  if (m.local && m.error) return { status: '못 보냄' };
  if (m.canned) return { status: '보냄', tone: 'sent' }; // AI 없이 고른 말: 패널 안에서 바로 답한다
  if (!m.local) return m.queuedAt ? sentStatus(m.queuedAt, m.at) : null;
  const st = localState(chat, m.chatId);
  if (st === 'sending') return { status: '보내는 중', tone: 'sending', title: m.chatId ? '데몬이 받았어요 — 바로 보낼지 줄 설지 확인하는 중' : '데몬에 보내는 중' };
  const p = chat.pending[m.chatId];
  return { ...sentLabel(m.queuedAt ?? p?.queuedAt, m.sentAt ?? p?.sentAt), tone: 'sent' }; // 로컬 사본은 늘 「보냄」까지 — 서버 기록이 오면 조용해진다
}
function sentStatus(queuedAt, sentAt) {
  const s = sentLabel(queuedAt, sentAt);
  return s.status === '보냄' && !queuedAt ? null : { ...s, tone: 'sent' };
}

// 기다리는 말(대기 중): 답하던 게 끝나면 차례대로 간다 — [지금 보내기]는 답하던 걸 멈추고 바로, [취소]는 빼서 입력창으로.
// 데몬 큐(chat.pending 의 queued)로 그린다 — 패널을 닫았다 열어도 같은 자리에. 흐린 점선 풍선 + 아래 상태 줄(차례·무엇을 기다리는지·줄 선 시각)
const queueBusy = new Set(); // 지금 보내기·취소를 누르고 응답을 기다리는 chatId
function queuedRow(p, canEdit = false) {
  const busy = queueBusy.has(p.chatId);
  const l = queuedLabel(p);
  const key = `q:${p.chatId}`;
  return h(`div.msg-row.user.queued${canEdit ? '.editable' : ''}`, { dataset: { chat: p.chatId } },
    queuedAtts(p),
    canEdit && editingMsg?.key === key ? msgEditor() : (p.text || !p.attachments?.length) ? h('div.msg.user.queued', { title: '아직 보내지 않았어요 — 줄 서 있어요' }, h('span', { text: p.text ?? '' })) : null,
    canEdit && editingMsg?.key !== key ? editButton(() => startEdit({ key, kind: 'queued', chatId: p.chatId, text: p.text ?? '' })) : null,
    h('div.msg-meta.q-meta', null,
      h('span.st.s-queued', { 'data-s': l.status, title: l.wait }),
      h('span.q-wait', { text: l.wait, title: l.wait }),
      timeEl(p.queuedAt)),
    h('div.msg-meta.q-actions', null,
      h('button.ghost.small.q-now', { type: 'button', text: '지금 보내기', title: '지금 답하던 걸 멈추고 이 말을 바로 보내요', disabled: busy || !cy.chatNow, onclick: () => sendNowQueued(p.chatId) }),
      h('button.ghost.small.q-cancel', { type: 'button', text: '취소', title: '이 말은 보내지 않아요 (입력창으로 돌려놔요)', disabled: busy, onclick: () => cancelQueued(p.chatId) })));
}

// ---- 첨부(보낸 말의 그림·파일) — 그림은 미리보기(cy-attach://, 보내기 전 사본은 blob:), 누르면 기본 앱으로 연다 ----
function attsEl(list, threadId, { queued = false } = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  return h(`div.msg-atts${queued ? '.queued' : ''}`, null, list.map((a) => {
    const v = chipView(a);
    const url = a.file ? attachUrl(threadId, a.file) : null;
    const open = url && cy.openAttachment ? () => cy.openAttachment(threadId, a.file) : null;
    const src = a.kind === 'image' ? (url ?? a.localUrl ?? null) : null;
    if (src) return h('button.msg-att-img', { type: 'button', title: open ? `${v.title}\n눌러서 열기` : v.title, disabled: !open, onclick: open }, h('img', { src, alt: a.name, loading: 'lazy' }));
    return h('button.msg-att-file', { type: 'button', title: open ? `${v.title}\n눌러서 열기` : v.title, disabled: !open, onclick: open },
      h('span.att-icon', { text: v.icon, 'aria-hidden': 'true' }), h('span.att-name', { text: v.name }), h('span.att-size', { text: v.size }));
  }));
}
// 줄 선 말의 첨부: 로컬 사본(미리보기 있음)이 있으면 그것, 없으면 데몬 큐의 이름·크기
function queuedAtts(p) {
  const local = messages.find((m) => m.local && ((p.chatId && m.chatId === p.chatId) || (p.clientId && m.clientId === p.clientId)));
  return attsEl(local?.attachments ?? p.attachments, selectedId, { queued: true });
}

// ---- 말 고치기(✏️) — 이 대화의 마지막 내 말만. 저장하면: 답하는 중이면 멈추고, 그 뒤 답은 걷히고, 고친 글로 다시 답한다(데몬 Chat.edit).
// 줄 선 말이면 글만 바뀐다(차례 그대로). Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소
function editButton(onclick) {
  return h('button.msg-edit', { type: 'button', title: '이 말 고치기 — 고친 글로 다시 답해요', 'aria-label': '이 말 고치기', onclick }, navIcon('edit'));
}
function startEdit(e) {
  if (!cy.chatEdit && e.kind === 'sent') return;
  if (!cy.chatEditQueued && e.kind === 'queued') return;
  editingMsg = { ...e };
  renderChat();
  requestAnimationFrame(() => { const ta = editingMsg?.el?.querySelector('textarea'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } });
}
function endEdit() {
  editingMsg = null;
  renderChat();
  chatInput.focus();
}
// 편집기는 한 번 만들어 다시 그려도 그대로 쓴다(SSE 로 대화가 다시 그려져도 글·커서가 안 날아가게)
function msgEditor() {
  const e = editingMsg;
  if (e.el) { e.el.querySelector('.me-err').textContent = e.error ?? ''; e.el.querySelectorAll('button').forEach((b) => { b.disabled = !!e.saving; }); return e.el; }
  const ta = h('textarea.msg-editor', { rows: 1, 'aria-label': '고칠 말' });
  ta.value = e.text;
  const size = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 220)}px`; };
  ta.addEventListener('input', () => { e.text = ta.value; size(); });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ev.isComposing) { ev.preventDefault(); ev.stopPropagation(); endEdit(); return; }
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    saveEdit();
  });
  e.el = h('div.msg-edit-box', null, ta,
    h('div.me-row', null,
      h('span.me-err'),
      h('span.me-hint', { text: e.kind === 'queued' ? '아직 안 보낸 말이라 글만 바뀌어요' : '저장하면 고친 말로 다시 답해요 — 그 뒤 답은 걷혀요' }),
      h('button.ghost.small', { type: 'button', text: '취소', onclick: endEdit }),
      h('button.primary.small', { type: 'button', text: '저장', onclick: () => saveEdit() })));
  requestAnimationFrame(size);
  return e.el;
}
async function saveEdit() {
  const e = editingMsg;
  if (!e || e.saving) return;
  const text = e.text.trim();
  if (!text) { e.error = '비어 있으면 저장할 수 없어요'; renderChat(); return; }
  const tid = selectedId;
  e.saving = true; e.error = null;
  renderChat();
  let r;
  if (e.kind === 'queued') {
    try { r = await cy.chatEditQueued(e.chatId, text); } catch { r = { ok: false }; }
    if (r?.ok) {
      messages = messages.map((m) => (m.local && m.chatId === e.chatId ? { ...m, text } : m));
      if (editingMsg === e) editingMsg = null;
      renderChat();
      return;
    }
  } else {
    const clientId = newClientId();
    const model = $('chat-model').hidden ? null : $('chat-model').value || null;
    const opts = { clientId, ...(model ? { model } : {}) };
    try { r = await cy.chatEdit(tid, e.n, text, opts); } catch { r = { ok: false }; }
    // 그 턴이 띄운 백그라운드 에이전트가 아직 돈다 — 멈춰도 되는지 묻는다(안 멈추면 옛 물음의 결과가 새 답 뒤에 끼어든다)
    if (r?.status === 409 && r.data?.error === 'agents_running') {
      const n = Array.isArray(r.data.agents) ? r.data.agents.length : 1;
      const names = Array.isArray(r.data.agents) ? r.data.agents.map((a) => `「${a.description}」`).join(', ') : '';
      if (!confirm(`이 답이 띄운 에이전트 ${n}개${names ? `(${names})` : ''}가 아직 돌고 있어요.\n고치면 그 에이전트를 멈춰요. 고칠까요?`)) { e.saving = false; renderChat(); return; }
      try { r = await cy.chatEdit(tid, e.n, text, { ...opts, stopAgents: true }); } catch { r = { ok: false }; }
    }
    if (r?.ok && r.data?.chatId) {
      if (editingMsg === e) editingMsg = null;
      if (selectedId === tid) {
        const at = new Date().toISOString();
        messages = appendLocal(dropFrom(messages, e.n), { role: 'user', text, at, clientId });
        messages = tagLocal(messages, { text, at, clientId }, r.data.chatId);
        dispatchChat({ type: 'accepted', chatId: r.data.chatId, threadId: r.data.threadId, clientId, text, ...(r.data.queued != null ? { queued: r.data.queued } : {}) });
        renderChat();
        scrollChat(true);
        loadMessages();
      }
      return;
    }
  }
  if (editingMsg !== e) return;
  e.saving = false;
  const why = r?.data?.error;
  e.error = why === 'not_latest' || why === 'not_queued' ? '이제 마지막 말이 아니라 고칠 수 없어요' : why === 'agents_running' ? '에이전트가 돌고 있어 고치지 않았어요' : '고치지 못했어요 — 다시 해 보세요';
  renderChat();
  if (why === 'not_latest' || why === 'not_queued') loadMessages();
}

async function sendNowQueued(chatId) {
  if (!chatId || queueBusy.has(chatId) || !cy.chatNow) return;
  queueBusy.add(chatId);
  renderChat();
  try { await cy.chatNow(chatId); } catch { /* 결과는 SSE chat 으로 — 404 면 이미 차례가 왔다 */ }
  queueBusy.delete(chatId);
  renderChat();
}

async function cancelQueued(chatId) {
  if (!chatId || queueBusy.has(chatId) || !cy.chatStop) return;
  queueBusy.add(chatId);
  renderChat();
  try { await cy.chatStop(chatId); } catch { /* 결과는 SSE chat stopped */ }
  queueBusy.delete(chatId);
  renderChat();
}

// ---- 대화 속 서브에이전트(GET /chat/threads/:id/agents) — 입력창 위 "에이전트" 줄 + 대화 속 카드. 누르면 작업 세션 창의 그 Agent 줄 ----
const agentKey = (a) => `${a.runId}/${a.toolUseId}`;
const placeSig = (list) => list.map((a) => `${agentKey(a)}:${a.status}`).join('|'); // 자리·상태가 바뀌면 대화를 다시 그림

async function loadAgents() {
  const id = selectedId;
  if (!id || !cy.chatThreadAgents) return;
  const seq = ++agentsSeq;
  let r;
  try { r = await cy.chatThreadAgents(id); } catch { r = null; }
  if (seq !== agentsSeq || id !== selectedId || !r?.ok) return;
  const next = normAgents(r.data);
  const nextSessions = normSessions(r.data);
  const nextWt = normWorktrees(r.data);
  const prev = agentsFor === id ? agents : [];
  const prevSessions = agentsFor === id ? sessions : [];
  const prevWt = agentsFor === id ? worktrees : [];
  agents = next;
  sessions = nextSessions;
  worktrees = nextWt;
  agentsFor = id;
  const agentsSame = agentsSig(next) === agentsSig(prev);
  if (agentsSame && sessionsSig(nextSessions) === sessionsSig(prevSessions) && worktreesSig(nextWt) === worktreesSig(prevWt)) return;
  if (!agentsSame) renderAgents();
  if (placeSig(next) !== placeSig(prev) || sessionsPlaceSig(nextSessions) !== sessionsPlaceSig(prevSessions) || worktreesPlaceSig(nextWt) !== worktreesPlaceSig(prevWt)) renderChat();
  else {
    for (const a of next) agentCardEls.get(agentKey(a))?.replaceWith(agentCardEl(a));
    refreshSessionCards();
    refreshWorktreeCards(); // 토큰이 늘거나 끝난 줄만 — 대화 전체를 다시 그리지 않는다
  }
}
const loadAgentsSoon = () => { clearTimeout(agentsTimer); agentsTimer = setTimeout(loadAgents, 150); };
const openAgent = (a) => cy.openSession?.(a.runId, a.toolUseId);

// 백그라운드 에이전트(채팅이 넘긴 것)는 카드 옆 [멈추기] — 채팅 답의 [멈추기]와 따로(답은 이미 끝났다)
const agentStopping = new Set();
function agentCardEl(a) {
  const v = agentCard(a);
  const card = h(`button.agent-card.t-${v.tone}${a.background ? '.bg' : ''}`, { type: 'button', title: '작업 세션 창에서 이 에이전트가 한 일 보기', onclick: () => openAgent(a) },
    h('span.ag-title', { text: v.title }),
    h('span.ag-status', null, a.status === 'running' ? h('i.ag-dot') : null, h('span', { text: v.status })),
    v.last ? h('span.ag-last', { text: v.last }) : null,
    v.note ? h('span.ag-note', { text: v.note }) : null,
    v.worktree ? h('span.ag-note.ag-wt', { text: v.worktree, title: '이 에이전트가 일한 워크트리(브랜치 · 경로)' }) : null,
    a.via === 'cli' ? h('span.via-cli', { text: 'Claude Code', title: '터미널의 Claude Code 에서 띄운 에이전트예요' }) : null,
    timeEl(a.startedAt));
  const el = canStopAgent(a) && cy.agentStop
    ? h('div.agent-wrap', null, card, h('button.ghost.small.ag-stop', { type: 'button', text: '멈추기',
      title: '이 에이전트만 멈춰요(채팅은 그대로)', disabled: agentStopping.has(a.toolUseId), onclick: () => stopAgent(a) }))
    : card;
  agentCardEls.set(agentKey(a), el);
  return el;
}
async function stopAgent(a) {
  if (agentStopping.has(a.toolUseId) || !cy.agentStop) return;
  agentStopping.add(a.toolUseId);
  agentCardEls.get(agentKey(a))?.replaceWith(agentCardEl(a));
  try { await cy.agentStop(a.toolUseId); } catch { /* 결과는 SSE agents·threads 로 */ }
  agentStopping.delete(a.toolUseId);
  loadAgentsSoon();
}

// 대화 속 작업 세션 카드(Orca 작업 공간 카드처럼): 머리 = 상태 점 + 레포(아래 흐리게 브랜치), 안쪽 줄 = 스피너(끝나면 ✓/✗/–) ✳ 작업 제목 - 마지막 줄 · 경과.
// 누르면 작업 세션 창이 그 run 을 연다
function sessionCardEl(s) {
  const v = sessionCard(s, { connected });
  const el = h(`button.session-card.t-${v.tone}`, { type: 'button', title: `작업 세션 창에서 보기 — ${s.title} (${v.status})`, onclick: () => cy.openSession?.(s.runId) },
    h('span.ws-head', null,
      h(`i.ws-dot.d-${v.dot}`, { 'aria-hidden': 'true' }),
      h('span.ws-name', { text: v.header }),
      v.sub ? h('span.ws-sub', { text: v.sub }) : null),
    h('span.ws-row', null,
      v.spinning ? h('i.ws-spin', { 'aria-label': '진행 중' }) : h('span.ws-icon', { text: v.icon, 'aria-label': v.status }),
      h('span.ws-mark', { text: '✳', 'aria-hidden': 'true' }),
      h('span.ws-text', null, h('b', { text: v.label }), v.last ? h('span.ws-last', { text: ` - ${v.last}` }) : null),
      h('span.ws-age', { text: v.age, title: v.ageTitle })));
  sessionCardEls.set(s.runId, el);
  return el;
}
// 대화 속 워크트리 카드: 머리 「🌿 워크트리 N개 · N개 진행 중」, 줄마다 (스피너) 제목 · 브랜치 · 「12.3k 토큰…」 / 초록 「완료」·빨강 「실패」·「멈춤」.
// 하나라도 돌면 초록 테두리. 줄을 누르면 작업 세션 창(에이전트면 그 Agent 줄)
function wtCardEl(group) {
  const v = worktreeCard(group);
  const rows = v.rows.map((r, i) => {
    const t = openTarget(group[i]);
    return h(`button.wt-row${r.running ? '.run' : ''}`, { type: 'button', title: r.tip, disabled: !t, onclick: () => { if (t) cy.openSession?.(t.runId, t.toolUseId); } },
      r.running ? h('i.ws-spin', { 'aria-label': '진행 중' }) : null,
      h('span.wt-title', { text: r.title }),
      r.branch ? h('span.wt-branch', { text: r.branch }) : null,
      r.tokens ? h('span.wt-tokens', { text: r.tokens }) : null,
      r.state ? h(`span.wt-state.t-${r.state.tone}`, { text: r.state.text }) : null);
  });
  const el = h(`div.wt-card${v.active ? '.active' : ''}`, null,
    h('div.wt-head', null, h('b', { text: v.head }), h('span.wt-sub', { text: v.sub })), ...rows);
  wtCardEls.set(group[0].key, { el, keys: group.map((w) => w.key) });
  return el;
}
function refreshWorktreeCards() {
  const byKey = new Map((agentsFor === selectedId ? worktrees : []).map((w) => [w.key, w]));
  for (const [, c] of [...wtCardEls]) {
    const group = c.keys.map((k) => byKey.get(k)).filter(Boolean);
    if (group.length) c.el.replaceWith(wtCardEl(group));
  }
}
function refreshSessionCards() {
  for (const s of agentsFor === selectedId ? sessions : []) sessionCardEls.get(s.runId)?.replaceWith(sessionCardEl(s));
}
// 돌고 있는 작업 세션의 경과(5분·1시간)는 30초마다 그 카드만 고친다
setInterval(() => { if (agentsFor === selectedId && sessions.some((s) => s.status === 'running')) refreshSessionCards(); }, 30e3);

// 입력창 위: 돌고 있는 에이전트 한 줄씩(점이 깜빡임) + 끝난 것 "에이전트 N개 끝남 ▸". 돌고 있는 게 없으면 숨김
function renderAgents() {
  const strip = agentsFor === selectedId ? agentStrip(agents, { open: agentsDoneOpen }) : null;
  chatAgentsEl.hidden = !strip;
  if (!strip) { chatAgentsEl.replaceChildren(); return; }
  const rows = strip.running.map((r) => h('button.ag-row.run', { type: 'button', title: `${r.agent.description} — 작업 세션 창에서 보기`, onclick: () => openAgent(r.agent) },
    h('i.ag-dot'), h('span.ag-text', { text: r.text })));
  if (strip.finished) {
    const f = strip.finished;
    rows.push(h('button.ag-toggle', { type: 'button', 'aria-expanded': f.open ? 'true' : 'false', text: `${f.label} ${f.open ? '▾' : '▸'}`,
      onclick: () => { agentsDoneOpen = !agentsDoneOpen; renderAgents(); } }));
    for (const r of f.rows) rows.push(h(`button.ag-row.done.t-${r.tone}`, { type: 'button', title: '작업 세션 창에서 보기', onclick: () => openAgent(r.agent) },
      h('span.ag-icon', { text: r.icon }), h('span.ag-text', { text: r.text })));
  }
  chatAgentsEl.replaceChildren(...rows);
}

// 채팅 화면이 안 보이면(다른 구역·창 숨김) 그리지 않고 표시만 해 두었다가 보일 때 한 번 그린다
let chatDirty = false;
const chatShown = () => section === 'chat' && panelShown();
const mdCache = createNodeCache(); // 안 바뀐 답의 마크다운 DOM 재사용(진행 이벤트마다 다시 파싱하지 않게)
function flushChat() {
  if (!chatDirty || !chatShown()) return;
  chatDirty = false;
  renderChat();
  renderThreadList();
}
function renderChat(opts = {}) {
  if (!chatShown()) { chatDirty = true; return; }
  const stick = nearBottom();
  const prevHeight = chatLog.scrollHeight, prevTop = chatLog.scrollTop;
  const items = [];
  if (moreAbove) items.push(h('button.ghost.chat-more', { type: 'button', text: '이전 말 더 보기', onclick: () => loadMessages({ older: true }) }));
  // 대기 중인 내 말은 맨 아래(답하는 중 표시 밑)로 따로 — 데몬 큐 기준. 그 말의 로컬 사본은 대화 속에 또 그리지 않는다
  const queued = selectedId ? queuedChats(chat, selectedId) : [];
  const qIds = new Set(queued.map((p) => p.chatId)), qClients = new Set(queued.map((p) => p.clientId).filter(Boolean));
  const isQueued = (m) => m.local && !m.error && ((m.chatId && qIds.has(m.chatId)) || (m.clientId && qClients.has(m.clientId)) || localState(chat, m.chatId) === 'queued');
  const shown = messages.filter((m) => !isQueued(m));
  // 카드 자리: 붙은 말 위(승인)·아래(확인 카드), 안 붙었으면 자기 시각 자리 — 새 말보다 아래에 박히지 않게
  const placed = placeActions(threadActions, shown, { moreAbove });
  // 서브에이전트 카드: 띄운 시각 자리(그 뒤 첫 말 앞)에
  const agentAt = placeAgents(agentsFor === selectedId ? agents : [], shown, { moreAbove });
  // 워크트리 카드: 한 답이 판 워크트리들(둘 이상이면 그 수정 run 들의 세션 카드 대신 이 카드 하나)
  const wtAt = placeWorktrees(agentsFor === selectedId ? worktrees : [], shown, { moreAbove });
  // 작업 세션 카드: 채팅에서 시킨 것은 넘긴 답 바로 아래, 그 밖은 시작 시각 자리
  const sessAt = placeSessions((agentsFor === selectedId ? sessions : []).filter((s) => !wtAt.hideRuns.has(s.runId)), shown, { moreAbove });
  const indexOf = new Map(shown.map((m, i) => [m, i]));
  // ✏️ 가 붙는 말: 이 대화의 마지막 내 말 하나(줄 선 말이 있으면 맨 뒤에 줄 선 말)
  const target = selectedId ? editTarget(shown, queued) : null;
  if (editingMsg && !(target && editingMsg.key === (target.kind === 'sent' ? `n:${target.n}` : `q:${target.chatId}`))) editingMsg = null; // 더는 마지막 말이 아니다
  agentCardEls.clear();
  sessionCardEls.clear();
  wtCardEls.clear();
  const sessionsAfter = (i) => {
    for (const s of sessAt.after.get(i) ?? []) items.push(sessionCardEl(s));
    const g = wtAt.after.get(i);
    if (g) items.push(wtCardEl(g));
  };
  for (const it of withDayDividers(shown)) {
    if (it.type === 'day') { items.push(h('div.day-sep', { role: 'separator', 'aria-label': it.label, title: it.title }, h('span', { 'data-t': it.label }))); continue; }
    const m = it.msg;
    const mi = indexOf.get(m);
    if (mi === 0) sessionsAfter(-1);
    pushApprovals(items, placed.before.get(mi) ?? []); // 답이 안 붙은 카드: 자기 시각 자리(이 말 앞)
    for (const a of agentAt.before.get(mi) ?? []) items.push(agentCardEl(a));
    if (m.role === 'system') {
      const sc = aroundAnswer(placed.byMsg.get(m.n)); // 답 없이 끝난 턴의 줄("답을 끝내지 못했어요 …")에 붙은 승인 카드 → 줄 위
      pushApprovals(items, sc.before);
      items.push(h('div.msg.system', null, h('span', { text: m.text }), timeEl(m.at)));
      for (const a of sc.after) items.push(actionCard(a));
      sessionsAfter(mi); continue;
    }
    if (m.role === 'user') {
      const about = m.todoId ? (m.todoTitle || todoTitleOf(m.todoId)) : null;
      const chipOn = m.todoId && m.todoId !== currentThread()?.todoId; // 할 일 대화 안에서 그 할 일 칩은 군더더기
      const status = userStatus(m);
      const key = Number.isInteger(m.n) ? `n:${m.n}` : null;
      const canEdit = !!key && target?.kind === 'sent' && target.n === m.n;
      const bubble = m.text || chipOn || !m.attachments?.length; // 글 없이 첨부만 보낸 말은 첨부만
      items.push(h(`div.msg-row.user${m.local && m.error ? '.error' : ''}${canEdit ? '.editable' : ''}`, null,
        attsEl(m.attachments, selectedId),
        canEdit && editingMsg?.key === key ? msgEditor() : bubble ? h(`div.msg.user${m.local ? '.local' : ''}${m.local && m.error ? '.error' : ''}`, null,
          chipOn ? h('span.about', { text: about ? `할 일: ${about}` : '할 일', title: about ?? m.todoId }) : null, m.text ? h('span', { text: m.text }) : null) : null,
        canEdit && editingMsg?.key !== key ? editButton(() => startEdit({ key, kind: 'sent', n: m.n, text: m.text })) : null,
        metaEl(m, status)));
      sessionsAfter(mi);
      continue;
    }
    const cards = aroundAnswer(placed.byMsg.get(m.n));
    pushApprovals(items, cards.before); // 답을 만드는 동안 난 승인 → 답 위
    items.push(h('div.msg-row.assistant', null,
      h(`div.msg.assistant${m.error ? '.error' : ''}`, null,
        mdCache.get(`${selectedId}|${Number.isInteger(m.n) ? m.n : `${m.at}|${m.clientId ?? ''}`}`, m.text, () => md(h('div'), m.text)),
        m.show ? h('button.go', { type: 'button', text: `${SECTION_LABELS[m.show]} 보기`, onclick: () => goto(m.show) }) : null),
      metaEl(m)));
    for (const a of cards.after) items.push(actionCard(a));
    sessionsAfter(mi);
  }
  pushApprovals(items, placed.orphans); // 그 뒤 말이 없는 카드(지금 도는 턴)만 맨 아래
  for (const a of agentAt.tail) items.push(agentCardEl(a));
  for (const s of sessAt.tail) items.push(sessionCardEl(s));
  for (const g of wtAt.tail) items.push(wtCardEl(g));
  if (!items.length && !queued.length) {
    const t = currentThread();
    items.push(selectedId && t?.count
      ? h('div.chat-hello.muted', { text: '불러오는 중…' })
      : h('div.chat-hello', null, h('b', { text: t?.kind === 'todo' ? '이 할 일에 대해 말해 보세요' : '새 대화' }),
        h('span', { text: t?.kind === 'todo' ? '"내일로 미뤄", "끝났어", "둘로 나눠"처럼 말하면 바로 바꿔요.' : brain.ready === false ? '아래 정해진 말을 눌러 보세요. AI를 연결하면 무엇이든 물어볼 수 있어요.' : `무엇이든 물어보세요. 예: ${hasCoder() ? '"오늘 커밋 보여줘", "P1 할 일 뭐 있어?"' : '"오늘 일정 알려줘", "급한 할 일 뭐 있어?"'} 다른 대화의 내용은 이어지지 않아요.` })));
  }
  if (selectedId && isRunning(chat, selectedId)) items.push(h('div.typing', null, h('i'), h('i'), h('i'), h('span', { text: busyLabel(chat, selectedId) })));
  else if (cannedTyping) items.push(h('div.typing', null, h('i'), h('i'), h('i'), h('span', { text: '입력 중' })));
  for (const p of queued) items.push(queuedRow(p, target?.kind === 'queued' && target.chatId === p.chatId));
  chatLog.replaceChildren(...items);
  mdCache.end();
  renderChatLock();
  renderSendButton();
  if (opts.keepScroll) chatLog.scrollTop = prevTop + (chatLog.scrollHeight - prevHeight);
  else if (stick) scrollChat(true);
}

// 뇌(AI)가 없으면 입력창 대신 연결 안내 카드 + 정해진 말 버튼(로컬로 되는 것은 그대로)
function renderChatLock() {
  const compose = $('chat-compose');
  let box = $('chat-canned');
  if (!box) {
    box = document.createElement('div');
    box.id = 'chat-canned';
    compose.before(box);
  }
  const lock = chatLock(brain, connectCardHidden);
  compose.hidden = lock.locked;
  box.hidden = !lock.locked && !cannedOpen;
  const canned = h('div.canned-row', null, CANNED.map((c) => h('button.ghost', { type: 'button', text: c.label, onclick: () => sayCanned(c) })));
  $('chat-canned-btn')?.classList.toggle('on', cannedOpen);
  if (!lock.locked) { if (cannedOpen) box.replaceChildren(canned); return; } // AI가 있어도 ＋ 로 정해진 답 버튼
  const card = connectCard(brain);
  if (lock.reopen) {
    box.replaceChildren(canned, h('button.link.connect-reopen', { type: 'button', text: card.reopen, onclick: () => setConnectCardHidden(false) }));
    return;
  }
  box.replaceChildren(
    h('div.card.connect-card', null,
      h('button.connect-hide', { type: 'button', text: '×', title: card.hide, 'aria-label': card.hide, onclick: () => setConnectCardHidden(true) }),
      h('h3', { text: card.title }),
      h('ul', null, card.lines.map((l) => md(h('li'), l))),
      h('div.connect-actions', null,
        h('button.primary', { type: 'button', text: card.button, onclick: () => { openSetup('brain'); detectAgents(); } }),
        h('button.ghost', { type: 'button', text: card.hide, onclick: () => setConnectCardHidden(true) }))),
    canned,
  );
}

// AI 연결 안내 카드 숨김: 데스크톱 state.json 에 남긴다(껐다 켜도 그대로)
function setConnectCardHidden(v) {
  connectCardHidden = !!v;
  renderChatLock();
  cy.connectCardSet?.(connectCardHidden).catch(() => {});
}
cy.connectCardGet?.().then((r) => {
  if (r && typeof r.hidden === 'boolean' && r.hidden !== connectCardHidden) { connectCardHidden = r.hidden; renderChatLock(); }
}).catch(() => {});

// main 이 알려 주는 뇌 연결 상태(GET /status · SSE status)
function applyBrain(v) {
  if (!v || typeof v !== 'object') return;
  const was = brain.ready;
  brain = v;
  if (was !== brain.ready) {
    renderChatLock();
    if (section === 'chat') renderChat();
  }
  if (section === 'setup') renderSetupView(false);
  if (section === 'settings' && settingsTab === 'ai') modelsView.update();
}
cy.brain?.().then(applyBrain).catch(() => {});
cy.onBrain?.(applyBrain);

// AI 없이 고른 말: 내 말은 바로 「보냄」, 시사는 1~2초 입력 중(점 세 개)을 보이고 답한다
let cannedTyping = null; // 답을 기다리는 타이머(입력 중 표시)
$('chat-canned-btn')?.addEventListener('click', () => { cannedOpen = !cannedOpen; renderChatLock(); });
function sayCanned(c) {
  if (cannedTyping) return; // 앞 답이 오기 전엔 하나씩
  if (c.id === 'cheer' || c.id === 'dance') cy.localAsk?.(c.id).catch(() => {}); // 캐릭터도 응원·춤 영상
  const openItems = rawTodos();
  const text = cannedReply(c.id, { open: openItems.length, done: vm.recentDone.filter((t) => !t.skipped).length, next: openItems[0]?.title || '', hour: new Date().getHours() }, { override: sisa.canned, character });
  messages = appendLocal(messages, { role: 'user', text: c.label, at: new Date().toISOString(), canned: true });
  cannedTyping = setTimeout(() => {
    cannedTyping = null;
    messages = appendLocal(messages, { role: 'assistant', text, at: new Date().toISOString() });
    renderChat();
    scrollChat(true);
  }, 1000 + Math.round(Math.random() * 800));
  renderChat();
  scrollChat(true);
}

async function loadSisa() {
  try {
    const got = await cy.sisaGet();
    if (got && typeof got === 'object') {
      sisa = {
        provider: got.provider || '',
        hasKey: !!got.hasKey,
        persona: got.persona || '',
        canned: got.canned && typeof got.canned === 'object' ? got.canned : {},
        done: got.done || {},
        connected: Array.isArray(got.connected) ? got.connected : [],
        chatModels: got.chatModels && typeof got.chatModels === 'object' ? got.chatModels : {},
        codeModel: typeof got.codeModel === 'string' ? got.codeModel : 'default',
      };
    }
  } catch { /* 키 없으면 채팅을 막는다 */ }
  renderChatLock();
  if (section === 'chat') renderChat();
  if (section === 'settings' && settingsTab === 'ai') modelsView.show();
}

// 대화 목록의 할 일 칩 제목(기록에 제목이 없을 때)
function todoTitleOf(id) {
  return rawTodos().find((t) => t.id === id)?.title ?? null;
}

// 보내기 ↔ 멈추기: 이 대화가 답하는 중이고 입력창이 비었으면 멈추기
function renderSendButton() {
  const b = sendButton(chat, selectedId, chatInput.value || (tray.has() ? attachSummary(tray.items()) : ''));
  const btn = $('chat-send');
  btn.textContent = b.text;
  btn.title = b.title;
  btn.dataset.mode = b.mode;
  btn.classList.toggle('primary', b.mode === 'send');
  btn.classList.toggle('stop', b.mode === 'stop');
}

// 답하던 것 멈추기(이 대화에서 돌고·기다리는 것 전부). 결과는 SSE chat stopped 로 온다 — 404 면 이미 끝난 것
async function stopChat() {
  const ids = stopTargets(chat, selectedId);
  if (!ids.length || !cy.chatStop) return;
  const btn = $('chat-send');
  btn.disabled = true;
  try { await Promise.all(ids.map((id) => cy.chatStop(id).catch(() => null))); } finally { btn.disabled = false; }
}

// 말 id(clientId): 낙관적 사본 ↔ 데몬 큐·서버 기록을 정확히 짝 맞춘다
const newClientId = () => (globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

// 데몬 큐(GET /chat/queue)로 대기 중·보냄을 되살린다 — 패널을 다시 열거나 다시 연결됐을 때(데몬이 기준)
async function loadQueue() {
  if (!cy.chatQueue) return;
  let r;
  try { r = await cy.chatQueue(); } catch { return; }
  if (r?.ok && r.data) dispatchChat({ type: 'queue', queue: r.data.queue, running: r.data.running });
}

function onSendClick() {
  if ($('chat-send').dataset.mode === 'stop') stopChat();
  else sendChat();
}

let sendingAtts = false; // 첨부가 다 올라가길 기다리는 중(그동안 또 보내지 않게)
async function sendChat() {
  if (brain.ready === false) return;
  const text = chatInput.value.trim();
  if ((!text && !tray.has()) || sendingAtts) return;
  const tid = selectedId;
  // 첨부: 올리는 중인 건 끝날 때까지 기다리고, 못 올린 게 있으면 보내지 않는다(✕ 로 빼고 다시)
  let atts = [];
  if (tray.has()) {
    sendingAtts = true;
    try {
      const st = await tray.ready();
      if (st.failed) { showAttError('못 올린 첨부가 있어요 — ✕ 로 빼고 다시 보내 주세요'); return; }
      atts = tray.take();
    } finally { sendingAtts = false; }
    if (selectedId !== tid) { tray.restore(atts); return; } // 기다리는 사이 다른 대화로 옮겼다
  }
  chatInput.value = '';
  drafts.set(tid, '');
  autosize();
  if (!atts.length && isDoubleSend(messages, text)) return; // 같은 말이 방금 나갔다(Enter 두 번) — 두 번 보내 두 번 답하지 않게
  const at = new Date().toISOString();
  const clientId = newClientId();
  messages = appendLocal(messages, { role: 'user', text, at, clientId, ...(atts.length ? { attachments: atts } : {}) });
  renderChat();
  scrollChat(true);
  let r;
  const model = $('chat-model').hidden ? null : $('chat-model').value || null;
  try { r = await cy.chatSend(text, { threadId: tid, clientId, ...(model ? { model } : {}), ...(atts.length ? { attachments: atts.map((a) => a.id) } : {}) }); } catch { r = { ok: false }; }
  if (r?.ok && r.chatId) {
    messages = tagLocal(messages, { text, at, clientId }, r.chatId); // 대기 중·지금 보내기·취소가 이 말을 찾게
    messages = dropFailed(messages); // 앞서 못 보낸 말·실패 줄은 이제 걷는다
    // queued: POST 응답이 SSE queued 보다 먼저 와도 대기 중으로(예전엔 이때 「보냄」처럼 보였다)
    dispatchChat({ type: 'accepted', chatId: r.chatId, threadId: r.threadId, clientId, text, ...(r.queued != null ? { queued: r.queued } : {}), ...(r.position ? { position: r.position } : {}) });
    if (tid === null && r.threadId && selectedId === null) {
      // 새 대화 → 방금 생긴 스레드로(이미 붙인 내 말은 그대로 두고 서버 기록으로 맞춘다)
      selectedId = r.threadId;
      store.set('thread', selectedId);
      drafts.delete(null);
      loadThreadsSoon();
      renderThreadList();
      renderThreadHead();
    }
  } else {
    if (selectedId !== tid) return;
    messages = messages.map((m) => (m.local && !m.error && m.clientId === clientId ? { ...m, error: true } : m));
    const gone = r?.status === 404;
    if (atts.length) tray.restore(atts); // 첨부는 칩으로 돌려놓는다(다시 보내기)
    const why = r?.status === 400 && typeof r.data?.error === 'string' ? `못 보냈어요: ${r.data.error}` : null; // 첨부 한도·못 찾음 등
    messages = appendLocal(messages, { role: 'assistant', text: gone ? '이 대화를 못 찾았어요. 다른 곳에서 지웠을 수 있어요.' : why ?? `${who()}에 연결되지 않아서 못 보냈어요.`, at: new Date().toISOString(), error: true });
    if (gone) loadThreadsSoon();
    renderChat();
  }
  scrollChat(true);
}

function autosize() {
  // 채팅 탭이 숨어 있으면(display:none) scrollHeight 가 0 이라 재지 않는다 — 보일 때 다시 잰다
  if (!chatInput.offsetParent) { chatInput.style.height = ''; return; }
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight + 2, 260)}px`;
  chatInput.style.overflowY = chatInput.scrollHeight + 2 > 260 ? 'auto' : 'hidden';
}
chatInput.addEventListener('input', () => { autosize(); drafts.set(selectedId, chatInput.value); renderSendButton(); });
// 모델 고르기(작업 세션 창과 같은 목록). 고른 건 이 컴퓨터에 기억, 목록에 없어졌으면 대화 기본값
async function loadChatModels() {
  const sel = $('chat-model');
  const res = await cy.listModels?.().catch(() => null);
  const models = res?.ok ? cleanModels(res.data) : null;
  sel.hidden = !models;
  if (!models) return;
  let saved = null;
  try { saved = localStorage.getItem('chatModel'); } catch { /* 무시 */ }
  sel.replaceChildren(...models.choices.map((c) => h('option', { value: c.id, text: c.label })));
  sel.value = models.choices.some((c) => c.id === saved) ? saved : models.defaults.chat;
}
$('chat-model').addEventListener('change', () => { try { localStorage.setItem('chatModel', $('chat-model').value); } catch { /* 무시 */ } });
loadChatModels();
// `/` 로 시작하면 슬래시 명령 자동완성(열려 있는 동안 Enter 는 넣기 — 아래 보내기보다 먼저 가로챈다)
if (cy.listCommands) attachSlashMenu(chatInput, { listCommands: () => cy.listCommands() });
chatInput.addEventListener('keydown', (e) => {
  // 답하는 중 Esc = 멈추기(패널 닫기보다 먼저)
  if (e.key === 'Escape' && !e.isComposing && selectedId && stopTargets(chat, selectedId).length) {
    e.preventDefault();
    e.stopPropagation();
    stopChat();
    return;
  }
  // 한글 조합 중 Enter 는 보내지 않는다
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  sendChat();
});
$('chat-send').addEventListener('click', onSendClick);


// SSE chat: 진행 표시 + 선택한 대화에 답이 오면 그 대화를 다시(시스템 줄까지). 오류는 서버에 안 남으니 여기만
function onChatEvent(ev) {
  if (ev?.status === 'done' && Array.isArray(ev.actions)) for (const a of ev.actions) updateAction(normalizeActions([a])[0]);
  // 대기 중이던 말이 멈춤(취소) → 데몬은 기록하지 않으니 로컬 사본을 빼고, 입력창이 비었으면 그 말을 돌려놓는다
  if (ev?.status === 'stopped' && localState(chat, ev.chatId) === 'queued') {
    const r = dropLocal(messages, ev.chatId);
    messages = r.messages;
    if (r.dropped && ev.threadId === selectedId && !chatInput.value.trim()) {
      chatInput.value = r.dropped.text;
      drafts.set(selectedId, chatInput.value);
      autosize();
    }
    // 그 말의 첨부(데몬에 올려 둔 그대로)도 칩으로 돌려놓는다
    const back = r.dropped?.attachments ?? chat.pending[ev.chatId]?.attachments;
    if (back?.length && ev.threadId === selectedId) tray.restore(back);
  }
  // 줄 섰던 말이 모델에 감: 같은 풍선을 지금 답하는 자리(맨 아래)로 옮기고 보낸 때를 붙인다(새 풍선 없음)
  if (ev?.status === 'thinking' && ev.threadId === selectedId && ev.queuedAt) {
    const p = chat.pending[ev.chatId];
    messages = markSent(messages, { chatId: ev.chatId, clientId: ev.clientId ?? p?.clientId, text: p?.text, queuedAt: ev.queuedAt, sentAt: ev.sentAt });
  }
  // 말을 고쳤다(다른 창에서 고쳤어도): 그 말부터 뒤는 걷고 다시 불러온다. 줄 선 말이면 그 글만
  if (ev?.status === 'edited' && ev.threadId === selectedId) {
    if (Number.isInteger(ev.n)) { messages = dropFrom(messages, ev.n); loadMessages(); }
    else if (typeof ev.text === 'string') messages = messages.map((m) => (m.local && m.chatId === ev.chatId ? { ...m, text: ev.text } : m));
  }
  const tid = typeof ev?.threadId === 'string' ? ev.threadId : null;
  dispatchChat({ type: 'event', ev }, { view: !(tid && tid !== selectedId), progress: ev?.status === 'thinking' || ev?.status === 'step' });
  if (!tid || !['done', 'error', 'stopped'].includes(ev.status)) return; // stopped: "답을 멈췄어요" 시스템 줄을 다시 불러온다
  if (tid === selectedId) {
    if (ev.status === 'error') { messages = appendLocal(messages, { role: 'assistant', text: ev.text || '답을 못 만들었어요.', at: new Date().toISOString(), error: true }); renderChat(); }
    // 새 답은 맨 아래 — 승인 카드를 보느라 위에 있어도 답으로 내려간다
    Promise.resolve(loadMessages()).finally(() => scrollChat(true));
    loadAgentsSoon();
  }
  loadThreadsSoon();
}

// ↻ 새로고침: 이 대화의 run 들이 터미널 Claude Code 에서 이어 간 말을 불러온다(새 말은 SSE threads 로도 온다)
async function syncThread() {
  const id = selectedId, btn = $('th-sync');
  if (!id || btn.disabled || !cy.chatThreadSync) return;
  btn.disabled = true;
  btn.classList.add('spin');
  try {
    const r = await cy.chatThreadSync(id);
    btn.title = r?.ok
      ? (r.data?.imported ? `터미널에서 이어 간 기록 ${r.data.imported}줄을 불러왔어요` : '새로 불러올 터미널 기록이 없어요')
      : (r?.data?.error || '터미널 기록을 못 불러왔어요');
    if (r?.ok && id === selectedId) { await loadMessages(); loadAgents(); }
  } finally { btn.disabled = false; btn.classList.remove('spin'); }
}
$('th-sync').addEventListener('click', syncThread);

// SSE threads: 하나 바뀜(thread) · 지워짐(deleted)
function onThreadsEvent(p) {
  if (p?.deleted && typeof p.deleted === 'string') {
    const order = visibleOrder();
    threads = threads.filter((t) => t.id !== p.deleted);
    archived = archived?.filter((t) => t.id !== p.deleted) ?? null;
    if (selectedId === p.deleted) selectThread(afterRemoval(order, p.deleted), { noFocus: true });
  } else if (p?.thread) {
    const t = normThread(p.thread);
    if (!t) return;
    if (t.archived) { threads = threads.filter((x) => x.id !== t.id); if (archived) archived = upsertThread(archived, t); }
    else { threads = upsertThread(threads, t); if (archived) archived = archived.filter((x) => x.id !== t.id); }
  }
  afterThreadsChanged();
}

// ---- 이벤트 ----
cy.onChat(onChatEvent);
cy.onThreads?.(onThreadsEvent);
cy.onAgents?.((p) => { if (p?.threadId && p.threadId === selectedId) loadAgentsSoon(); });
cy.onAction?.(onActionEvent);
cy.onDashboard(loadSoon);
// id(선택): 오버레이 말풍선(새 할 일)에서 연 그 할 일을 펼친다
cy.onSection(({ section: s, id } = {}) => {
  if (s === 'chat' && typeof id === 'string' && id) { openThread(id); return; } // 말풍선(호버 답) → 그 대화
  if (s === 'setup' && isSetupPhase(id)) { openSetup(id); if (id === 'brain') detectAgents(); return; } // 연결 안내 말풍선 → 마법사의 그 단계
  if (s === 'settings' && SETTINGS_TABS.includes(id)) settingsTab = id; // 「모델」 탭이던 말풍선은 id 'ai'
  if (normalizeSection(s)) goto(s);
  if (s === 'todos' && typeof id === 'string' && id && openId !== id) toggleDetail(id);
});
// ---- 세션 창 "원래 화면 열기" — 그 대화(채팅 탭) · 할 일(그 줄 펼침) · 제안(개요) ----
let originSeq = 0;
function flashFor(id, ms = 2400) {
  flash = { id, until: Date.now() + ms };
  setTimeout(() => { if (flash?.id === id && Date.now() >= flash.until) { flash = null; renderTodos(); renderOverview(); } }, ms + 50);
}
async function openOriginThread(threadId, note) {
  await openThread(threadId);
  if (note) setBanner(note);
  chatInput.focus();
}
async function openOrigin(origin) {
  const plan = originPlan(origin);
  if (!plan) return;
  const seq = ++originSeq;
  if (plan.action === 'thread') return openOriginThread(plan.threadId);
  if (plan.action === 'proposal') {
    goto('overview');
    flashFor(`proposal:${plan.proposalId}`);
    renderOverview();
    const el = $('sec-overview').querySelector(`.proposal[data-id="${CSS.escape(plan.proposalId)}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
    else setBanner('그 제안은 지금 개요 목록에 없어요(오래됐거나 처리됐을 수 있어요).');
    return;
  }
  // 할 일: 할 일 탭에서 그 줄을 펼쳐 보인다. 없어졌거나 끝났으면 그 할 일의 대화로
  let r;
  try { r = await cy.todoLastAsk(plan.todoId); } catch { r = { ok: false }; }
  if (seq !== originSeq) return;
  const p = todoPlan(origin, r);
  if (!p) return;
  if (p.action === 'thread') return openOriginThread(p.threadId, p.note);
  goto('todos');
  if (p.action === 'todos') { setBanner(p.note); return; }
  if (!findTodo(p.todo.id)) { await load(); if (seq !== originSeq) return; } // 목록이 아직 옛것이면 한 번 새로
  const t = findTodo(p.todo.id);
  if (t?.priority === BACKLOG && !backlogOpen) { backlogOpen = true; writeBacklogOpen(globalThis.localStorage, true); }
  flashFor(p.todo.id);
  if (t && openId !== t.id) toggleDetail(t.id); else renderTodos();
  const row = todosSec.querySelector(`.todo.row[data-id="${CSS.escape(p.todo.id)}"]`);
  if (!t || !row) {
    if (p.threadId) return openOriginThread(p.threadId, '목록에서 그 할 일을 못 찾아서 대화를 열었어요.');
    setBanner('목록에서 그 할 일을 못 찾았어요.');
    return;
  }
  row.scrollIntoView({ block: 'center' });
  row.focus();
}
cy.onOpenOrigin?.(openOrigin);

cy.onConnection(({ connected: c }) => {
  const was = connected;
  connected = !!c;
  const el = $('conn');
  el.textContent = connected ? `${who()} 켜짐` : `${who()} 꺼짐`;
  el.title = el.textContent;
  el.classList.toggle('off', !connected);
  if (connected && !was && section === 'setup') loadSetupSettings(); // 앱이 데몬을 막 띄웠으면 마법사 칸을 채운다
  if (connected && !was) { load(); focusView.load(); loadThreads(); loadPermissions(); loadChatModels(); loadAgents(); loadQueue(); }
  if (!connected) { chat = { ...chat, pending: {} }; renderChat(); renderThreadList(); renderBadges(); }
});

// ↻ 새로고침: 화면 다시 그리기 + 데몬이 슬랙·메일을 지금 다시 읽어 새 할 일을 넣는다(결과는 캐릭터 말풍선)
$('refresh').addEventListener('click', () => { cy.refreshSources?.(); load(); loadThreads(); if (selectedId) { loadMessages(); loadAgents(); } });
$('open-session')?.addEventListener('click', () => cy.openSession?.());
// 이 컴퓨터에 Claude Code 가 없으면(Gemini·GPT 키·로컬) 코드 관련 버튼(작업 세션)은 숨긴다
function applyCaps(c) {
  if (c && typeof c === 'object' && 'claude' in c) caps = { claude: c.claude, codex: c.codex, agy: c.agy, code: c.code };
  for (const id of ['open-session']) { const b = $(id); if (b) b.hidden = !hasCoder(); }
  if (section === 'chat') renderChat();
}
cy.caps?.().then(applyCaps).catch(() => {});
cy.onCaps?.(applyCaps);
$('close').addEventListener('click', () => cy.close());
// 항상 위 고정(#171): 켜짐은 앱이 state.json 에 기억(설정과 같은 cy.settings 의 settings-app-get/set)
const pinBtn = $('panel-pin');
pinBtn.append(navIcon('pin'));
// 아이콘만 있는 단추는 글자 대신 선 그림(CSS 이름표는 data-tip)
for (const [id, icon] of [['th-toggle', 'menu'], ['th-sync', 'refresh'], ['chat-attach', 'clip'], ['chat-canned-btn', 'plus']]) $(id).replaceChildren(navIcon(icon));
function showPin(on) {
  pinBtn.classList.toggle('on', on);
  pinBtn.setAttribute('aria-pressed', String(on));
  const tip = on ? '고정 풀기' : '항상 위에 고정';
  pinBtn.dataset.tip = tip;
  pinBtn.setAttribute('aria-label', tip);
}
cy.settings.getAppPrefs().then((r) => { if (r?.ok) showPin(r.panelPinned === true); }).catch(() => {});
pinBtn.addEventListener('click', async () => {
  const r = await cy.settings.setAppPrefs({ panelPinned: pinBtn.getAttribute('aria-pressed') !== 'true' }).catch(() => null);
  if (r?.ok) showPin(r.panelPinned === true);
});
document.addEventListener('keydown', (e) => {
  if (drag && e.key === 'Escape') { e.preventDefault(); finishDrag(false); return; } // 끌기 취소
  if (e.key === 'Escape' && !e.isComposing) {
    if (section === 'chat' && rowMode) { rowMode = null; renderThreadList(); return; }
    if (section === 'chat' && listOpen) { setListOpen(false); return; }
    cy.close();
  } else if (e.metaKey && e.key === 'w') {
    e.preventDefault();
    cy.close();
  } else if (e.metaKey && !e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    newChat();
  } else if (e.metaKey && section === 'chat' && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing) {
    e.preventDefault();
    const next = neighborThread(visibleOrder(), selectedId, e.key === 'ArrowDown' ? 1 : -1);
    if (next !== selectedId) selectThread(next);
  } else if (e.metaKey && /^[1-5]$/.test(e.key)) {
    e.preventDefault();
    const shown = navGroups(SECTIONS).main; // 사이드바 위쪽 순서대로
    if (shown[Number(e.key) - 1]) goto(shown[Number(e.key) - 1]);
  }
});

// 상대 시각은 1분마다 보이는 구역만 다시 그림(날짜가 바뀌면 할 일 묶음도 그때 다시 나뉨). 창이 숨겨진 동안은 건너뛰고 보일 때 한 번
let timeStale = false;
setInterval(() => {
  if (!raw) return;
  if (!panelShown()) { timeStale = true; return; }
  renderAll();
}, 60_000);
// 창이 숨겨지면 주기 확인을 멈추고, 다시 보이면 밀린 그리기·확인을 이어 간다(focus 는 visibilitychange 가 없는 경우의 대비)
function onPanelVisibility() {
  if (!panelShown()) { appleWatch.stop(); loginWatch.stop(); return; }
  if (raw && (timeStale || dirtySecs.has(section))) { timeStale = false; renderAll(); }
  if (section === 'chat') { flushChat(); afterThreadsChanged(); }
  if (section === 'setup') { renderSetupView(false); if (setupApple?.pending) loadApple(); }
}
document.addEventListener('visibilitychange', onPanelVisibility);
window.addEventListener('focus', onPanelVisibility);

function applySisa(v) {
  sisa = {
    ...sisa,
    provider: v.provider ?? sisa.provider,
    hasKey: !!v.hasKey,
    persona: typeof v.persona === 'string' ? v.persona : sisa.persona,
    canned: v.canned && typeof v.canned === 'object' ? v.canned : sisa.canned,
    connected: Array.isArray(v.connected) ? v.connected : sisa.connected,
    chatModels: v.chatModels && typeof v.chatModels === 'object' ? v.chatModels : sisa.chatModels,
    codeModel: typeof v.codeModel === 'string' ? v.codeModel : sisa.codeModel,
  };
  renderChatLock();
}
// AI·연결을 끊으면 main 이 새 저장 모양을 보낸다
cy.onSisa?.((v) => {
  if (!v || typeof v !== 'object') return;
  applySisa(v);
  if (v.done && typeof v.done === 'object') sisa.done = v.done;
  modelsView.update();
  if (section === 'setup') { setupKey = ''; renderSetupView(false); }
  loadCalendars(); // 설정에서 캘린더를 뺐을 수도 있다
});
const modelsView = mountModels({ section: $('set-ai-models'), voiceSection: $('set-voice'), h, cy, getSisa: () => sisa, onSisa: applySisa, gotoSetup: () => openSetup(), gotoRules: () => showSettingsTab('rules'), getBrain: () => brain });

goto(section);
renderAll();
renderChat();
loadSisa();
renderThreadList();
renderThreadHead();
load();
loadPermissions();
loadThreads();
loadQueue();
