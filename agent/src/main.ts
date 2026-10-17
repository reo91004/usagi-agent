// 데몬 엔트리포인트: 버스 + Slack + 주기 작업(세션·Slack 수집, 프로필 학습, 브리핑)
import { installFileLog, stallLag } from "./log.ts";
import { loadConfig } from "./config.ts";
import { DEFAULT_TODAY_REMINDER } from "./daily-plan.ts";
import { localAsk } from "./local-mode.ts";
import { Store } from "./store.ts";
import { Bus, EXIT_PORT_TAKEN } from "./bus.ts";
import { runs } from "./runs.ts";
import { modelChoices } from "./models.ts";
import { Agent } from "./core.ts";
import { suggestTitle } from "./chat.ts";
import { briefingDue } from "./briefing-sources.ts";
import { loadCommands, SlashCommands } from "./commands.ts";
import { createSlack } from "./slack/app.ts";
import { TodoCanvas, openDm } from "./slack/canvas.ts";
import { SlackIngester } from "./ingest/slack.ts";
import { learnFrom } from "./profile.ts";
import { runAfterSlackIngest } from "./todo-auto.ts";
import { checkProgress } from "./todo-progress.ts";
import { McpHealth, connectorServerUrls, healthNote } from "./mcp-health.ts";
import { Reactions, realMergeAsk } from "./reactions.ts";
import { HOME_DIR } from "./config.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WAIT_SETUP, markFreshInstall, modelWorkAllowed, sessionsAllowed } from "./onboarding.ts";
import { execFile } from "node:child_process";
import { openSpec } from "./plat.ts";
import { CalendarSync, alertDetail } from "./calendar-sync.ts";
import { withRun, asRoutine } from "./runs.ts";
import { KgBackfill } from "./kg/backfill.ts";
import { refineIncremental } from "./kg/refine.ts";
import { connectorStatus, connectorsChanged, resolveConnectors } from "./connectors.ts";
import { phrase, phraseVoice } from "./phrases.ts";
import { probeGh } from "./gh.ts";
import { CliSync } from "./cli-sync.ts";
import { AgentsNotifier, AGENT_LIMITS, agentsForThread, sessionsForThread, threadWorktrees } from "./thread-agents.ts";
import { worktreeRecords } from "./agent-worktrees.ts";
import { Settings } from "./settings.ts";
import { CharacterStore } from "./character-store.ts";
import { START_CHARACTER } from "./characters.ts";
import { jobBubble, jobNodeId, jobProps, pullJobs, type JobDone, type RunningJob } from "./jobs.ts";
import { syncRemoteSessions } from "./ingest/remote-sessions.ts";
import { disconnectConnector } from "./disconnect.ts";
import { CHECK_IDS, Connections, lastRunOf, type CheckId } from "./connections.ts";
import { statusOf } from "./status.ts";
import { featureBrain, mcpBrainNote, NEEDS_CODER, withMcpBrain } from "./feature-brain.ts";
import { cliMcpServers } from "./cli-mcp.ts";
import { mergePr } from "./fixer.ts";
import { askBtw } from "./btw.ts";
import { Focus, dayStart, focusApi, focusDoneText, localDay } from "./focus.ts";
import { collectDay, summarizeDay, writeDay } from "./research-note.ts";
import { notePathFor, researchSummary } from "./research.ts";
import { directivesView } from "./directives.ts";
import { remoteGpuData } from "./remote-fs.ts";
import { brainAuthFailed, brainCreditNeeded, onBrainAuthChange, setCliMcpUrl } from "./providers.ts";
import { mcpHandler, mcpToken, mcpUrl } from "./mcp-http.ts";
import { ctxTools } from "./ctx-tools.ts";
import { briefingHours } from "./calendar.ts";
import { performance } from "node:perf_hooks";

installFileLog();
// 새 설치면 config.json 에 "onboarded": false 를 남긴다: 설치 마법사를 마칠 때까지 아무것도 읽지 않고 모델도 부르지 않는다(onboarding.ts)
try {
  if (markFreshInstall(join(HOME_DIR, "config.json"), process.env, existsSync(process.env.CY_AGENT_DB ?? join(HOME_DIR, "cy.db"))))
    console.log("[onboarding] 새 설치: 설치 마법사를 마칠 때까지 작업 기록·레포를 읽지 않고 모델도 부르지 않아요");
} catch (e: any) { console.warn("[onboarding] 설정 파일에 표시하지 못했어요:", e?.message ?? e); }
// 놓친 거부(예: 틀린 Slack 토큰으로 라이브러리가 뒤에서 던진 오류)로 늘 켜져 있어야 할 데몬이 죽지 않게: 경고만 남긴다
process.on("unhandledRejection", (e: any) => console.warn("[cy-agent] 처리 안 된 오류:", e?.data?.error ?? e?.message ?? e));

const cfg = loadConfig();
// 포트부터 잡는다: cy.db 를 열고 끊긴 턴을 닫기(closeDanglingTurns) 전에. 이미 데몬이 떠 있으면 그 데몬의 턴을 건드리지 않고 여기서 끝낸다.
// 처리기는 아래 bus.listen 이 붙인다(그 사이엔 await 이 없어 요청이 기다릴 일은 거의 없다)
const bus = new Bus();
try {
  await bus.bind(cfg.port);
} catch (e: any) {
  if (e?.code === "EADDRINUSE") {
    console.error(`[cy-agent] 포트 ${cfg.port} 를 이미 다른 데몬이나 프로그램이 쓰고 있어 이 데몬은 끝낼게요 (종료 코드 ${EXIT_PORT_TAKEN})`);
    process.exit(EXIT_PORT_TAKEN);
  }
  throw e;
}
if (!modelWorkAllowed(cfg)) console.log("[onboarding] 설치 마법사를 마치기 전: 브리핑·정리 작업은 쉬어요");
console.log(`[onboarding] 작업 기록(Claude Code·Codex) 읽기: ${sessionsAllowed(cfg) ? "켬" : "끔"} · 레포 폴더 ${cfg.repoRoots.length}개`);
// 커넥터(connectors.ts): 기능별 데이터 원천. 연결 안 된 기능은 조용히 빠진다
const conns = cfg.connectors;
for (const c of connectorStatus(conns)) console.log(`[connectors] ${c.label}: ${c.mode}${c.ready ? "" : " (준비 안 됨)"} · ${c.detail}`);
console.log(`[brain] ${cfg.brain.provider}`);
{ // 뒤에서 하는 정리(끝난 할 일 판정·진행 확인·지식그래프·프로필 학습)를 누가 돌리나 — 시작할 때 한 줄
  const fb = featureBrain(cfg);
  console.log(`[features] 뒤에서 하는 정리: ${fb === "codex" ? "Codex" : fb === "agy" ? "Antigravity" : fb === "claude-code" ? "Claude Code" : cfg.onboarded === false ? "설치 마법사를 마치면 시작" : `안 돎 — ${NEEDS_CODER}`}${cfg.brain.provider !== "claude-code" ? ` · ${mcpBrainNote(cfg.brain.provider)}` : ""}`);
}
// 읽기 전용 GitHub 도구: 설정이 안 정했으면 gh 로그인 여부로(비동기 — 시작을 막지 않는다)
if (cfg.github?.enabled === undefined) probeGh({ bin: cfg.github?.bin }).then((ok) => console.log(`[cy-agent] GitHub(gh) 읽기 도구 ${ok ? "켬" : "끔 — gh auth status 실패"}`));
const store = new Store(cfg.dbPath);
runs.attach(store.db); // 작업 세션 기록(세션 창)을 cy.db 에
bus.activity.bindRuns(runs); // 돌고 있는 run(대화 제외) → 캐릭터 "공부 중"
// 집중하기(포커스 타이머): 기록은 cy.db, 바뀌면 SSE focus · 그만하면 「N분 집중했어요」 말풍선. AI 없이도 돈다
const focus = new Focus(store);
focus.onChange = (v) => bus.focusChanged(v);
focus.onStop = (sec) => { if (sec > 0) bus.bubble({ id: "focus:done", text: focusDoneText(sec), kind: "done", ttlMs: 8000 }); };
focus.startTimer();
// 일정 알림(설정 calendarAlert, 기본 10분 전): 오늘·내일 일정(커넥터 calendar: ICS·MCP, 읽기 전용). 30분마다·깨어날 때 다시 가져온다
const calendar = new CalendarSync(cfg, store, { wrapRun: (fn) => withRun({ kind: "calendar", title: "캘린더 동기화", model: cfg.models.light }, fn) });
calendar.onChange = () => bus.dashboardChanged();
// 터미널 Claude Code 에서 이어 간 대화 불러오기(세션 창 ↻·"Claude Code에서 열기" 뒤 지켜보기). 시작할 땐 아무것도 안 한다
const cliSync = new CliSync({ runs, db: store.db, store, onThread: (id) => bus.threads({ thread: store.thread(id) }), log: (m) => console.log(m) });
// 대화 속 서브에이전트·작업 세션 카드: 바뀌면 ≈1초 모아 SSE agents {threadId} → 패널이 다시 가져온다
new AgentsNotifier(runs, (threadId) => bus.agents(threadId));
let agent!: Agent;
let slack = createSlack(cfg, () => agent);
// 채팅 슬래시 명령 목록: 처음 물을 때 SDK 에서(모델 턴 없이), 10분마다 새로
const commands = new SlashCommands(() => loadCommands());
agent = new Agent(cfg, store, bus, slack?.port, { retitle: suggestTitle, commands, mergePr,
  autoMergeOp: (op, slug) => settings.autoMergeOp(op, slug) }); // 새 대화 제목: 가벼운 모델(답 뒤에 따로) · 자동 머지 레포는 설정 창과 같은 config.json 에
// 캐릭터 반응(그림 말풍선·진행 보고·머지 승인). 하루 한 번 규칙은 reactions.json 에 남는다
const reactions = new Reactions(bus, { logPath: join(HOME_DIR, "reactions.json"), lotsThreshold: Number(process.env.CY_LOTS_THRESHOLD) || 8 });
agent.setReactions(reactions, realMergeAsk(cfg));

const safe = (name: string, fn: () => unknown) => async () => {
  try { await fn(); } catch (e: any) { console.error(`[cy-agent] ${name} 실패:`, e?.data?.error ?? e?.message ?? e); }
};
// 이전 데몬이 답하다 꺼진 턴(배포·재시작)을 닫는다 — 물음만 덩그러니 남지 않게
safe("close-dangling", () => { const k = agent.closeDanglingTurns(); if (k) console.log(`[chat] 끊긴 대화 ${k}개 닫음`); })();

// 오늘 할 일 알림: 설정(todayReminder)대로, 모델 없이 정해진 말로(뇌가 없거나 local 이어도 뜬다)
// 아침 안내(ask)는 예전처럼 패널 '오늘 할 일'도 연다. 오버레이가 붙을 때(앱 첫 실행)와 1분마다 확인
function remindToday(opened = false) {
  const r = agent.dailyPlan().remind(cfg.todayReminder ?? DEFAULT_TODAY_REMINDER, { opened });
  if (!r) return;
  bus.bubble({
    id: `today:${r.plan.date}`,
    text: r.text,
    kind: "todo",
    ttlMs: 60e3,
    open: { section: "today" },
  });
  bus.dashboardChanged();
  if (r.kind === "ask") bus.openPanel("today");
}
bus.onOverlay = () => remindToday(true);
setInterval(() => { try { remindToday(false); } catch (e: any) { console.warn("[today] 알림:", e?.message ?? e); } }, 60e3).unref?.();

// 설정 창: 모델·브리핑 출처(바로 반영 + config.json) · 연결 상태(읽기만). KG 상태는 아래에서 kgBackfill 이 생긴 뒤에 붙는다
// 뇌·이름·레포 폴더를 바꾸면 바로 반영되고(재시작 불필요) 데스크톱에 SSE status 로 알린다
// 커넥터는 시작 때 한 번 정한다(캘린더 동기화·Slack 수집·가드가 붙잡고 있다). 마법사·[연결 해제]가 바꾸면 다시 켜서 반영:
// launchd(install.sh, KeepAlive) 아래면 스스로 끄고 launchd 가 다시 켠다. 손으로 띄운 데몬은 바뀜만 알린다
function reloadConnectors(): { changed: boolean; restarting: boolean } {
  const changed = connectorsChanged(cfg.connectors, resolveConnectors());
  const restarting = changed && process.env.CY_AGENT_SUPERVISED === "1";
  if (changed) console.log(`[connectors] config.json 의 연결이 바뀜, ${restarting ? "다시 시작해요" : "데몬을 다시 켜야 다 반영돼요"}`);
  // Windows 에서 제게 SIGTERM 을 보내면 핸들러 없이 바로 끝나므로 핸들러를 직접 부른다
  if (restarting) setTimeout(() => (process.platform === "win32" ? void shutdown() : process.kill(process.pid, "SIGTERM")), 500);
  return { changed, restarting };
}
// 사용자 캐릭터·기본 캐릭터 대사 고친 것(~/.cy-agent/characters/): Settings 가 config.json character 를 고르기 전에 읽어 둔다
const characterStore = new CharacterStore(join(HOME_DIR, "characters"));
try { characterStore.load(); } catch (e: any) { console.warn("[characters] 사용자 캐릭터를 읽지 못했어요:", e?.message ?? e); }
characterStore.onChange = ({ removedCurrent }) => {
  // 지금 쓰던 캐릭터를 지움 → 기본 캐릭터로(config.json 도). put 이 state 를 다시 보낸다
  if (removedCurrent) settings.put({ character: START_CHARACTER });
  bus.charactersChanged();
  bus.characterChanged(); // 이름·대사가 바뀐 지금 캐릭터도 바로
};
const settings = new Settings(cfg, { onChange: (keys) => {
  if (keys.some((k) => k === "brain" || k === "user" || k === "onboarded")) pushStatus();
  if (keys.includes("onboarded") && modelWorkAllowed(cfg)) setTimeout(() => onboardedNow(), 0); // 마법사를 막 마침 → 첫 정리
  else if (keys.includes("readSessions") && sessionsAllowed(cfg)) setTimeout(() => ingest(), 0);
  if (keys.includes("calendarAlert")) calendar.check(); // 알림 시각을 바로 다시 잡는다
  if (keys.includes("character")) bus.characterChanged(); // 앱 그림·영상을 바로 바꾼다
} });
let kgStatus: (() => { phase: string; reason?: string; step?: string }) | undefined;
const connections = new Connections(cfg, { lastRun: lastRunOf((o) => runs.listRuns(o)), kg: () => kgStatus?.() });
// GET /status: 뇌가 claude-code 인데 로그인 확인 전이면 한 번 확인을 걸고(비동기) 끝나면 SSE status 로 알린다
const status = () => statusOf(cfg, { claude: () => connections.claudeLoggedIn() });
let claudeProbe: Promise<void> | undefined;
const probeClaude = () => (claudeProbe ??= connections.check("claude").then(() => pushStatus()));
function pushStatus() {
  if (cfg.brain.provider === "claude-code" && connections.claudeLoggedIn() === undefined) void probeClaude();
  bus.statusChanged(status());
}
onBrainAuthChange(() => pushStatus()); // API 키가 401·403 을 받음 ↔ 다시 됨 → 데스크톱에 바로
if (cfg.configError) console.error("[config] 안전 모드: 설정 파일을 고칠 때까지 아무것도 읽지 않고 로컬 뇌로 돌아요");

// 맥락 도구 MCP(mcp-http.ts): Codex·agy 뇌의 채팅이 Claude 와 같은 cy 도구를 부른다
const mcpTok = mcpToken();
await bus.listen(cfg.port, {
  mcp: mcpHandler(mcpTok, () => ctxTools(cfg, store, { dashboard: () => agent.dashboard() })),
  approve: (id) => agent.approve(id),
  hold: (id) => agent.hold(id),
  briefing: () => agent.runBriefing(),
  refresh: () => refreshAll(),
  dashboard: async () => ({
    ...(await agent.dashboard()),
    meetings: calendar.enabled ? calendar.upcoming().map(({ webLink: _w, ...m }) => m) : [],
    connectors: withMcpBrain(cfg, connectorStatus(conns), () => cliMcpServers(conns).map((s) => s.name)), // Codex·agy 뇌면 넘길 수 있는 MCP 연결만(채팅에서)
    ...(() => { const r = researchSummary(cfg, store); return r ? { research: r } : {}; })(), // 연구 카드(연구 쪽 연결이 있을 때만)
    ...(conns.slack.mode !== "off" ? { directives: directivesView(store, cfg.directiveFrom ?? []) } : {}), // Slack 지시사항 카드(Slack 을 연결했을 때만)
  }),
  researchGpu: async () => ({ at: new Date().toISOString(), hosts: await remoteGpuData(cfg) }),
  directiveDecide: (id, decision) => agent.directiveDecide(id, decision),
  researchNote: (day) => notePathFor(cfg, day),
  todoDone: (id) => agent.todoDone(id),
  todoAdd: (t) => agent.addTodo(t),
  todoEdit: (id, patch) => agent.editTodo(id, patch),
  todoDelete: (id) => agent.deleteTodo(id),
  todoRestore: (id) => agent.restoreTodo(id),
  todoPurge: (id) => agent.purgeTodo(id),
  todoTrashEmpty: () => agent.emptyTrash(),
  todoRevert: (id) => agent.revertAutoTodo(id),
  todoDetail: (id) => agent.todoDetail(id),
  todoLastAsk: (id) => agent.lastAsk(id),
  todoReorder: (id, priority, beforeId) => agent.reorderTodo(id, priority, beforeId),
  projectHide: (id) => agent.hideProject(id),
  projectUnhide: (id) => agent.unhideProject(id),
  todoAsk: (id, text) => agent.askTodo(id, text),
  todoApply: (id, ops, rev, rule) => agent.applyAsk(id, ops, rev, rule),
  todoReject: (id, text, ops, rule) => agent.rejectAsk(id, text, ops, rule),
  todoRules: () => agent.todoRules(),
  todoLedger: (day) => agent.todoLedger(day),
  todoRuleEdit: (id, patch) => agent.editRule(id, patch),
  todoRuleDelete: (id) => agent.deleteRule(id),
  chat: (text, opts) => agent.chat(text, opts ?? {}),
  chatStop: (chatId) => agent.chatStop(chatId),
  chatNow: (chatId) => agent.chatNow(chatId),
  chatEdit: (threadId, n, text, o) => agent.chatEdit(threadId, n, text, o),
  chatEditQueued: (chatId, text) => agent.chatEditQueued(chatId, text),
  chatQueue: () => agent.chatQueue(),
  chatThreads: {
    list: (o) => agent.threads(o),
    create: (t) => agent.createThread(t),
    edit: (id, patch) => agent.editThread(id, patch),
    remove: (id) => agent.deleteThread(id),
    messages: (id, o) => agent.threadMessages(id, o),
  },
  todoExists: (id) => !!agent.getTodo(id),
  chatHistory: () => agent.chatHistory(50),
  attachments: {
    stage: (name, mime, bytes) => agent.stageAttachment(name, mime, bytes),
    file: (threadId, file) => agent.attachmentPath(threadId, file),
    open: (p) => { const o = openSpec(p); execFile(o.file, o.args, { windowsVerbatimArguments: o.verbatim, windowsHide: true }, () => {}); }, // 기본 앱으로(경로는 bus 가 첨부 폴더 안인지 확인한 것)
    claimRun: (runId, ids) => (runs.getRun(runId, Number.MAX_SAFE_INTEGER) ? agent.claimRunAttachments(runId, ids) : { error: "no such run" }),
  },
  profileFacts: () => agent.memories(),
  profileRemember: (text, category) => agent.remember(text, category),
  profileForget: (idOrText) => agent.forgetMemory(idOrText),
  mergeDecide: (id, decision) => agent.mergeDecide(id, decision),
  mergeAsk: (id, text) => agent.mergeAsk(id, text),
  runs,
  runContinue: (id, text, model) => agent.continueRun(id, text, model),
  runBtw: (id, text, model, att) => askBtw({ runs, cfg }, id, text, model, att), // /btw 곁질문 — run 에 끼어들지 않음
  runSync: (id, o) => (o.watch ? cliSync.watch(id) : cliSync.sync(id)),
  threadSync: (id) => cliSync.syncThread(id),
  runImport: (sid) => cliSync.importSession(sid),
  threadAgents: (id) => (store.thread(id) ? agentsForThread(runs, id, (t) => agent.bgAgents.get(t)) : undefined),
  agentStop: (toolUseId) => agent.bgAgents.stop(toolUseId),
  threadSessions: (id) => (store.thread(id) ? sessionsForThread(runs, id, (pid) => store.proposal(pid)?.created) : undefined),
  threadWorktrees: (id) => (store.thread(id) ? threadWorktrees({
    fixRuns: runs.runsInThread(id, AGENT_LIMITS.runs).filter((r) => r.kind === "fix"),
    bg: agent.bgAgents.list(id), subs: worktreeRecords.forThread(id),
    tokensOf: (runId, parent) => runs.tokensOf(runId, parent), askedAt: (pid) => store.proposal(pid)?.created,
  }) : undefined),
  models: () => ({ choices: modelChoices(cfg), defaults: { fix: cfg.models.code, chat: cfg.models.general } }),
  commands: () => commands.list(),
  repos: () => agent.repos(),
  newTask: (repo, text) => agent.newTask(repo, text),
  actions: {
    list: (o) => agent.listActions(o),
    get: (id) => agent.getAction(id),
    confirm: (id, o) => agent.confirmAction(id, o ?? {}),
    cancel: (id) => agent.cancelAction(id),
  },
  permissions: {
    list: () => agent.listPermissions(),
    remove: (id) => agent.deletePermission(id),
  },
  settings: { get: () => settings.view(), put: (body) => settings.put(body) },
  characters: characterStore,
  // AI 없이 고르는 질문(캐릭터 더블클릭 칩): 오늘 할 일·열린 할 일·캘린더만 보고 정해진 말로
  // 응원해 줘·춤춰 줘: 답과 함께 그 캐릭터의 응원·춤 영상(앱이 캐릭터마다 고른다)
  localAsk: (id) => {
    const answer = localAsk(id, {
      today: () => agent.dailyPlan().state().items,
      open: () => store.openTodos(),
      calendar: () => ({ enabled: calendar.enabled, meetings: calendar.enabled ? calendar.upcoming() : [] }),
    });
    if (answer?.id === "cheer" || answer?.id === "dance") bus.activity.startDance(8000, answer.id);
    return answer;
  },
  guidelines: agent.guidelinesApi(),
  focus: focusApi(focus),
  connections: { ids: CHECK_IDS, list: () => connections.list(), recheck: async (id) => { const r = await connections.recheck(id as CheckId | undefined); bus.statusChanged(status()); return r; } },
  status: () => {
    if (connections.claudeLoggedIn() === undefined) void probeClaude(); // 코드 기능(Claude Code)도 이걸로 가른다
    return status();
  },
  connectorsReload: () => reloadConnectors(),
  jobDone: (j) => jobDone(j),
  // [연결 해제]: 그 기능만 off(토큰·ICS 주소도 지움) → 다시 읽기 → 메모리도 바로 off
  connectorDisconnect: (cap) => disconnectConnector(cap, {
    path: join(HOME_DIR, "config.json"), cfg, reload: reloadConnectors,
    changed: () => {
      console.log(`[connectors] ${String(cap)} 연결 해제`);
      if (cap === "calendar") calendar.disable(); // 동기화·회의 알림을 바로 멈춘다
      if (cap === "slack") try { slackIngester.transport = null; } catch { /* 아직 안 만들어졌으면 만들 때 off 를 읽는다 */ } // 다음 수집부터 안 한다
      pushStatus();
      bus.dashboardChanged();
    },
  }),
});
setCliMcpUrl(mcpUrl(cfg.port, mcpTok));
console.log(`[cy-agent] 버스 http://127.0.0.1:${cfg.port}`);

// ── 할 일 캔버스: 데이터가 바뀔 때마다(디바운스·해시로 실제 호출은 변경 시에만)
const canvas = new TodoCanvas(store, { userId: cfg.slackUserId });
let dm: Promise<string> | undefined;
const syncCanvas = () => {
  const s = slack;
  if (!s) return;
  dm ??= openDm(s.app.client, cfg.slackUserId!).catch((e) => { dm = undefined; throw e; });
  dm.then((ch) => canvas.sync(s.app.client, ch)).catch((e) => console.warn("[canvas]", e?.data?.error ?? e?.message ?? e));
};
agent.onChange(syncCanvas);

if (slack) {
  // 토큰이 틀려도 데몬 전체가 죽지 않게: 경고만 남기고 말풍선으로 계속
  try {
    await slack.app.start();
    console.log("[cy-agent] Slack Socket Mode 연결");
    syncCanvas();
  } catch (e: any) {
    console.warn(`[cy-agent] Slack 연결 실패(${e?.data?.error ?? e?.message ?? e}) — 토큰을 확인해 주세요. 말풍선만 사용`);
    slack = undefined;
  }
} else {
  console.log("[cy-agent] Slack 토큰 없음 — 말풍선만 사용 (~/.cy-agent/config.json 참고)");
}

// ── 주기 작업
const ingest = safe("ingest", () => { const n = agent.ingest(); if (n) console.log(`[cy-agent] 세션 ${n}개 반영`); });

// 커넥터 MCP 서버(주소가 있는 http 서버만) 도달 상태 — 끊기면 말풍선으로 알리고, 다시 붙으면 바로 훑어본다
const health = new McpHealth({ urls: () => connectorServerUrls(cfg.connectors) });

// 이벤트 루프 멈춤 감시: 동기 작업이 2초 넘게 데몬을 붙잡으면(패널이 '연결 안 됨'으로 보임) 로그로 남긴다.
// 단조 시계(performance.now) 기준. 맥이 잠들면 단조 시계는 거의 안 가고 벽시계만 크게 뛴다. 그건 멈춤이 아니다(log.ts stallLag)
let tickMono = performance.now(), tickWall = Date.now();
setInterval(() => {
  const mono = performance.now(), wall = Date.now();
  const lag = stallLag(mono - tickMono, wall - tickWall);
  if (lag > 2000) console.warn(`[stall] 데몬이 ${(lag / 1000).toFixed(1)}초 멈췄어요`);
  tickMono = mono; tickWall = wall;
}, 1000).unref();
let authSkipLogged = false;
const brief = asRoutine(safe("briefing", async () => {
  if (!modelWorkAllowed(cfg)) return; // 설치 마법사를 마치기 전(정기 브리핑은 말풍선도 없이 조용히)
  // API 키가 401·403 을 받았으면 정기 브리핑은 쉰다(실패 말풍선을 매번 띄우지 않게). 키를 바꾸면 지문이 달라져 다시 돈다
  if (brainAuthFailed(cfg) || brainCreditNeeded(cfg)) {
    if (!authSkipLogged) console.warn("[briefing] API 키가 맞지 않거나 크레딧이 없어 정기 브리핑을 쉬어요. 키를 바꾸거나 대화가 한 번 되면 다시 해요");
    authSkipLogged = true;
    return;
  }
  authSkipLogged = false;
  const h = await health.check().catch(() => health.last);
  if (h.state !== "ok") console.log("[briefing] 일부 MCP 서버에 연결이 안 돼요 —", healthNote(h)); // 쓸 수 있는 출처로만 브리핑한다
  await agent.runBriefing();
})); // 정기 작업(세션 창 "정기 작업" 묶음). 패널 "지금 브리핑"(bus briefing)은 사용자 작업
// 재시작·재연결 때: 마지막 브리핑이 briefingIntervalMin 안이면 건너뛴다(재시작마다 브리핑 → 같은 할 일이 되살아나던 것)
const briefIfDue = (why: string) => {
  if (briefingDue(store.latestBriefing(), cfg.briefingIntervalMin)) return brief();
  console.log(`[briefing] ${why} — 마지막 브리핑이 ${cfg.briefingIntervalMin}분 안이라 건너뜀`);
};

// Slack 수집: 커넥터 slack 이 api(사용자 토큰 Web API)일 때만. 이전 사이클이 돌고 있으면 run()이 바로 빠진다
const slackIngester = new SlackIngester(cfg, store);
const slackTick = asRoutine(safe("slack-ingest", async () => {
  if (!modelWorkAllowed(cfg)) return; // 설치 마법사를 마치기 전
  if (!slackIngester.transport) return; // slack 연결 안 됨(off·mcp) — 브리핑·채팅이 MCP로 실시간 조회
  // 진행 보고: 20초 안에 끝나는 평소 사이클은 조용히, 오래 걸리면 시작·결과만
  const prog = reactions.progress("slack-ingest", phrase("slack_prog"), { quietMs: 20e3 });
  const c = await slackIngester.run().catch((e) => { prog.fail("슬랙 훑다가 막혔어요"); throw e; });
  prog.done(c.messages ? phrase("slack_done", { n: c.messages }) : undefined);
  console.log("[slack-ingest]", JSON.stringify(c)); // 건수·비용만
  await safe("todo-auto", () => runAfterSlackIngest(agent, cfg, store))(); // 끝난 할 일 자동 완료(모델은 15분에 한 번)
  await safe("slack-todos", () => agent.slackTodosNow())(); // 새 DM·멘션은 바로 할 일로(정기 브리핑을 기다리지 않는다)
}));

// ↻ 새로고침(패널): 슬랙을 지금 다시 훑고 → 새 DM·멘션을 할 일로 → 브리핑(메일·일정·Jira 등)도 간격 상관없이 지금.
// 새 할 일은 「할 일 추가했어요」 말풍선(reactions.newTodos)으로 뜬다. 동시에 눌러도 한 번만
let refreshing: Promise<void> | undefined;
const refreshAll = () => (refreshing ??= (async () => {
  if (!modelWorkAllowed(cfg)) { bus.bubble({ id: "refresh", text: WAIT_SETUP, kind: "info", ttlMs: 10e3 }); return; }
  bus.bubble({ id: "refresh", text: phrase("refresh_prog"), kind: "info", ttlMs: 60e3 });
  const before = new Set(store.openTodos().map((t) => t.id));
  await slackTick();
  await agent.runBriefing();
  if (!store.openTodos().some((t) => !before.has(t.id))) bus.bubble({ id: "refresh", text: phrase("refresh_none"), kind: "info", ttlMs: 6e3 });
})().finally(() => { refreshing = undefined; }));

// 프로필 학습: 동시에 두 번 돌지 않게. 새 근거가 없으면 모델을 부르지 않는다
let learning: Promise<unknown> | undefined;
const learn = (rounds = 1) => asRoutine(safe("profile", async () => {
  if (learning || !modelWorkAllowed(cfg)) return;
  const prog = reactions.progress("profile", phrase("profile_prog"), { quietMs: 15e3 });
  learning = (async () => {
    let added = 0;
    for (let i = 0; i < rounds; i++) {
      const r = (await learnFrom(cfg, store)) as any;
      added += Number(r.added) || 0;
      if (!r.evidence) break;
    }
    prog.done(added ? phrase("profile_done", { n: added }) : undefined);
  })().catch((e) => { prog.done(); throw e; }).finally(() => { learning = undefined; });
  await learning;
}));

// 할 일 진행 확인: 작업 세션·작업 run 을 읽고 끝난 일은 자동 완료(되돌릴 수 있음), 하는 중인 일엔 어디까지 됐는지 한 줄.
// 새 세션·run 이 없으면 모델을 안 부른다. 시작 3분 뒤 한 번, 그다음 progressCheckMin 마다(0 이면 끔)
const progressTick = asRoutine(safe("todo-progress", async () => {
  if (!modelWorkAllowed(cfg)) return;
  agent.ingest(); // 방금 끝난 세션까지
  await checkProgress(cfg, store, agent);
}));
if ((cfg.progressCheckMin ?? 5) > 0) {
  setTimeout(progressTick, 3 * 60e3).unref();
  setInterval(progressTick, (cfg.progressCheckMin ?? 5) * 60e3).unref();
}

// 확인 카드: 30분 지난 대기는 만료(카드·Slack·말풍선이 바뀐다)
setInterval(safe("actions-expire", () => agent.expireActions()), 60e3).unref();

// 휴지통에 30일 넘게 있던 할 일은 영구 삭제(시작할 때 + 하루 한 번)
const purgeTrash = safe("trash", () => { const n = agent.purgeOldTrash(); if (n) console.log(`[cy-agent] 휴지통 오래된 할 일 ${n}개 영구 삭제`); });
await purgeTrash();
setInterval(purgeTrash, 24 * 60 * 60e3).unref();

await ingest();
bus.bubble({ text: phraseVoice("hello", {}, `hello:${new Date().toISOString().slice(0, 10)}`, { mood: "excited" }), kind: "info", ttlMs: 8e3 });
setInterval(ingest, cfg.ingestIntervalMin * 60e3);
await health.check().catch(() => {}); // 첫 Slack 수집 전에 연결 상태부터
slackTick();
setInterval(slackTick, cfg.slackIngestIntervalMin * 60e3);
learn(5)(); // 시작 시 밀린 근거 조금 따라잡기
setInterval(learn(), 60 * 60e3);

// 지식그래프: 매시간 새 청크만 haiku 추출 → 영향받은 엔티티만 sonnet 다듬기(Slack 원문은 정기 수집이 채운다)
const kgBackfill = new KgBackfill(cfg, store);
kgStatus = () => kgBackfill.status();
let kgBusy = false;
const kgHourly = asRoutine(safe("kg-hourly", async () => {
  if (kgBusy || !modelWorkAllowed(cfg)) return;
  kgBusy = true;
  try {
    await withRun({ kind: "kg", title: "지식그래프 갱신" }, async () => {
      const inc = await kgBackfill.incremental({ budgetUsd: 1 });
      const ref = await refineIncremental(cfg, store, { budgetUsd: 0.5 });
      console.log("[kg-hourly]", JSON.stringify({ chunks: inc.chunks, extractUsd: inc.costUsd, refineUsd: ref.costUsd, stopped: ref.stopped }));
    });
  } finally { kgBusy = false; }
}));
setInterval(kgHourly, 60 * 60e3);

// 연구 노트(research-note.ts): 한 시간마다 오늘·어제 페이지를 다시 만든다(바뀐 경우만 쓴다). 어제 것은 자정 넘어 끝난 세션까지 담으려고
// 어제 페이지에는 하루가 끝났으니 요약을 한 번 붙인다(날짜마다 이 데몬에서 한 번만 시도 — 실패해도 매시간 다시 부르지 않게)
const noteSkipped = new Set<string>(); // 사용자가 고친 페이지는 한 번만 알린다
const summaryTried = new Set<string>();
const writeNotes = safe("research-note", async () => {
  if (!cfg.tineGraph) return;
  const today = localDay(Date.now());
  const yesterday = localDay(dayStart(today) - 12 * 3600e3); // 어제 낮 = 어제 날짜
  if (!summaryTried.has(yesterday)) {
    summaryTried.add(yesterday);
    try { if (await summarizeDay(cfg, store, await collectDay(cfg, store, yesterday, { focus }))) console.log(`[research-note] ${yesterday} 요약을 붙여요`); }
    catch (e: any) { console.warn(`[research-note] ${yesterday} 요약 못 함: ${e?.message ?? e}`); }
  }
  for (const day of [yesterday, today]) {
    const { path, result } = await writeDay(cfg, store, day, { focus });
    if (result === "written") console.log(`[research-note] ${day} 썼어요`);
    if ((result === "edited" || result === "removed") && !noteSkipped.has(path)) { noteSkipped.add(path); console.log(`[research-note] ${day} 우사기 블록을 누가 ${result === "edited" ? "고쳐서" : "지워서"} 그대로 둬요: ${path}`); }
  }
});
if (cfg.tineGraph) { setTimeout(writeNotes, 90e3).unref(); setInterval(writeNotes, 60 * 60e3).unref(); }

// 긴 작업 끝(jobs.ts): 이 맥은 POST /jobs/done, 원격 서버(jobHosts·sshHosts)는 2분마다 ssh 로 가져온다
// 작업 하나가 노드 하나(job:<서버>:<id>): 도는 동안 running, 끝나면 결과로 덮고, 표시만 남고 프로세스가 없으면 lost
function jobDone(j: JobDone) {
  const id = jobNodeId(j);
  store.upsertNode(id, "job", j.name, jobProps(j)); // 연구 노트(research-note.ts)·맥락 도구 jobs_recent 가 읽는다
  const b = jobBubble(j, id.slice(4));
  bus.bubble(b);
  if (b.kind === "done") bus.activity.startDance(8000, "cheer");
}
function jobsRunning(host: string, running: RunningJob[]) {
  const seen = new Set<string>();
  for (const r of running) {
    const id = jobNodeId(r);
    seen.add(id);
    const prev = store.node(id);
    if (prev && !prev.props.running && !prev.props.lost) continue; // 같은 목록에서 이미 끝난 것
    store.upsertNode(id, "job", r.name, jobProps(r, r.alive ? "running" : "lost"));
    if (!r.alive) console.warn(`[jobs] ${host} 의 '${r.name}' 이(가) 끝 기록 없이 사라졌어요(서버 재시작·강제 종료)`);
  }
  // 표시가 없어졌는데 끝 기록도 없는 것(누가 표시를 지움) → lost
  for (const n of store.nodesSince("job", new Date(Date.now() - 14 * 86400e3).toISOString(), 500)) {
    if (n.props.running && n.props.host === host && !seen.has(n.id)) store.upsertNode(n.id, "job", n.label, { ...n.props, running: undefined, lost: true });
  }
}
const jobHostDown = new Set<string>(); // 끊긴 서버는 상태가 바뀔 때만 로그
let jobsBusy = false;
async function pollJobHosts() {
  if (jobsBusy) return;
  jobsBusy = true;
  try {
    for (const host of cfg.jobHosts) {
      try {
        const { done, running } = await pullJobs(host);
        jobsRunning(host, running);
        for (const j of done) jobDone(j);
        if (jobHostDown.delete(host)) console.log(`[jobs] ${host} 다시 연결됨`);
      } catch (e: any) {
        if (!jobHostDown.has(host)) console.warn(`[jobs] ${host} 확인 못 함: ${e?.message ?? e}`);
        jobHostDown.add(host);
      }
    }
  } finally { jobsBusy = false; }
}
if (cfg.jobHosts.length) { setTimeout(pollJobHosts, 15e3).unref(); setInterval(pollJobHosts, 2 * 60e3).unref(); }

// ssh 서버의 작업 기록(ingest/remote-sessions.ts): sessionHosts 에서 늘어난 만큼 받아 와 이 맥 기록과 같이 읽는다
const sessionHostDown = new Set<string>();
let remoteBusy = false;
async function pollSessionHosts() {
  if (remoteBusy || !sessionsAllowed(cfg)) return;
  remoteBusy = true;
  try {
    let got = 0;
    for (const host of cfg.sessionHosts) {
      try {
        got += await syncRemoteSessions(host);
        if (sessionHostDown.delete(host)) console.log(`[sessions] ${host} 다시 연결됨`);
      } catch (e: any) {
        if (!sessionHostDown.has(host)) console.warn(`[sessions] ${host} 작업 기록을 못 받음: ${e?.message ?? e}`);
        sessionHostDown.add(host);
      }
    }
    if (got) await ingest();
  } finally { remoteBusy = false; }
}
if (cfg.sessionHosts.length) { setTimeout(pollSessionHosts, 30e3).unref(); setInterval(pollSessionHosts, 10 * 60e3).unref(); }

// 연결 상태가 바뀔 때만 한 번씩 알린다. 다시 연결되면 바로 훑어본다
let mcpState = "ok";
const healthTick = asRoutine(safe("mcp-health", async () => {
  const h = await health.check();
  const g = h.state;
  if (g === mcpState) return;
  const prev = mcpState;
  mcpState = g;
  console.log("[mcp-health]", JSON.stringify(h.servers));
  if (g !== "ok") {
    bus.bubble({ id: "mcp-health", text: healthNote(h) ?? "MCP 서버에 연결이 안 돼요. 잠시 뒤에 다시 볼게요", kind: "error", ttlMs: 30e3 });
  } else if (prev !== "ok") {
    bus.bubble({ id: "mcp-health", text: phrase("mcp_back"), kind: "info", ttlMs: 10e3 });
    slackTick();
    briefIfDue("다시 연결됨");
  }
}));
healthTick();
setInterval(healthTick, 2 * 60e3);
// 평일 업무시간(이 맥의 시간대로 9~19시)에만 정기 브리핑
setInterval(() => { if (briefingHours(new Date())) brief(); }, cfg.briefingIntervalMin * 60e3);
setTimeout(() => briefIfDue("시작"), 5e3);
// 일정 N분 전(설정 calendarAlert): 춤 + 말풍선(회의실·온라인 여부, 링크 버튼은 회의 링크, 없으면 캘린더 일정). 일정·분마다 한 번(DB에 남김)
const stopCalendar = asRoutine(calendar.schedule.bind(calendar))((m, text, mins) => {
  bus.activity.startDance(8000);
  const detail = alertDetail(m);
  bus.bubble({ id: `meeting:${m.id}@${m.start}#${mins}`, text, kind: "todo", ttlMs: Math.max(60e3, Date.parse(m.start) - Date.now()), link: m.link ?? m.webLink, ...(detail ? { detail } : {}) });
}, (r) => console.log("[calendar]", JSON.stringify({ meetings: r.meetings, events: r.events, calls: r.calls, errors: r.errors, costUsd: r.costUsd })));

// 설치 마법사를 막 마쳤을 때(PUT /settings onboarded: true): 시작할 때 하던 첫 정리를 지금 한 번
function onboardedNow() {
  console.log(`[onboarding] 설치 마법사를 마침: 작업 기록 ${sessionsAllowed(cfg) ? "읽기 켬" : "읽기 끔"} · 레포 폴더 ${cfg.repoRoots.length}개 · 뇌 ${cfg.brain.provider}`);
  void ingest();
  slackTick();
  learn(5)();
  briefIfDue("설치 마법사를 마침");
  if (calendar.enabled) calendar.sync().catch(() => {});
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  bus.stopping = true; // GET /status stopping: true — 새로 뜬 앱이 이 데몬이 곧 사라질 걸 안다
  stopCalendar();
  try { focus.checkpoint(); } catch { /* 꺼지는 중 */ }
  await canvas.flush().catch(() => {});
  bus.close();
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown());
// Windows 는 SIGTERM 을 보내면(child.kill) 핸들러 없이 바로 죽는다 — 앱이 IPC 로 띄웠으면 "shutdown" 메시지·연결 끊김으로 깔끔히 끈다
if (process.platform === "win32" && process.send) {
  process.on("message", (m) => { if (m === "shutdown" || (m as { type?: unknown } | null)?.type === "shutdown") void shutdown(); });
  process.on("disconnect", () => void shutdown());
}
