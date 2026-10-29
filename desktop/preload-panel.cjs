// 패널 프리로드 — 샌드박스라 CommonJS. 대시보드·채팅·오늘 할 일에 필요한 것만 노출.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('cy', {
  onConnection: on('connection'),
  onDashboard: on('dashboard'),
  onSisa: on('sisa'), // AI·연결을 끊으면 새 저장 모양(publicView)
  onSection: on('section'),
  onChat: on('chat'),
  onCharacter: on('character'),
  // 사용자 캐릭터·고친 대사(GET /characters 받아 둔 것) · 바뀜 알림
  getCharacters: () => ipcRenderer.invoke('characters-get'),
  onCharacters: on('characters'),
  localAsk: (id) => ipcRenderer.invoke('local-ask', String(id)), // 정해진 답 응원·춤 → 캐릭터 영상(POST /local/ask)
  getCharacter: () => ipcRenderer.invoke('get-character'), // 지금 캐릭터 id(데몬 state.character, 모르면 'shisa')
  getDashboard: () => ipcRenderer.invoke('get-dashboard'),
  briefingNow: () => ipcRenderer.invoke('briefing-now'),
  researchGpu: () => ipcRenderer.invoke('research-gpu'), // 연구 카드: 실험 서버 GPU(누를 때만)
  appleStatus: () => ipcRenderer.invoke('apple-status'), // 이 Mac 의 캘린더·미리알림 상태
  appleConnect: (o) => ipcRenderer.invoke('apple-connect', { calendar: !!o?.calendar, reminders: !!o?.reminders, twoWay: !!o?.twoWay }),
  appleDisconnect: (o) => ipcRenderer.invoke('apple-disconnect', { calendar: !!o?.calendar, reminders: !!o?.reminders, twoWay: !!o?.twoWay }),
  openPrivacy: (kind) => ipcRenderer.invoke('open-privacy', String(kind)), // 시스템 설정 → 개인정보 보호 및 보안 → 캘린더·미리알림
  directiveDecide: (id, decision) => ipcRenderer.invoke('directive-decide', String(id), String(decision)), // 지시사항 [할 일로]·[괜찮아요]
  directiveFrom: (ids) => ipcRenderer.invoke('directive-from', Array.isArray(ids) ? ids.map(String) : []), // 지시자 목록 저장
  researchJobForget: (id) => ipcRenderer.invoke('research-job-forget', String(id)), // usagi-run 기록 하나 지우기
  researchNoteOpen: (day) => ipcRenderer.invoke('research-note-open', String(day)), // 그날 연구 노트 파일 열기
  refreshSources: () => ipcRenderer.invoke('refresh-sources'), // ↻: 슬랙·메일 지금 다시 읽고 할 일 반영
  todoDone: (id) => ipcRenderer.invoke('todo-done', String(id)),
  todoAdd: (body) => ipcRenderer.invoke('todo-add', body),
  todoEdit: (id, patch) => ipcRenderer.invoke('todo-edit', String(id), patch),
  todoDelete: (id) => ipcRenderer.invoke('todo-delete', String(id)), // 휴지통으로
  todoRestore: (id) => ipcRenderer.invoke('todo-restore', String(id)),
  todoPurge: (id) => ipcRenderer.invoke('todo-purge', String(id)),
  todoTrashEmpty: () => ipcRenderer.invoke('todo-trash-empty'),
  todoRevert: (id) => ipcRenderer.invoke('todo-revert', String(id)),
  todoDetail: (id) => ipcRenderer.invoke('todo-detail', String(id)),
  todoReorder: (id, priority, beforeId) => ipcRenderer.invoke('todo-reorder', String(id), Number(priority), beforeId == null ? null : String(beforeId)),
  // 프로젝트 숨기기(hide=true) / 다시 보이기(false). id = 프로젝트 경로
  projectHide: (path, hide) => ipcRenderer.invoke('project-hide', String(path), !!hide),
  // 연구 프로젝트 저장(PUT /research/projects): { key, kind?, name?, subs?, url?, mergeInto? }
  researchProjectSave: (body) => ipcRenderer.invoke('research-project-save', body),
  // 폴더의 AGENTS.md·CLAUDE.md 에 usagi-run 규칙: add=false 면 상태 읽기, true 면 덧붙이기 → { agents, claude }
  agentRules: (path, add) => ipcRenderer.invoke('agent-rules', String(path), !!add),
  folderHosts: () => ipcRenderer.invoke('folder-hosts'), // ~/.ssh/config 서버 별칭 [{ host, user }]
  folderOpen: (path, how, host) => ipcRenderer.invoke('folder-open', String(path), String(how), host ? String(host) : null), // how: code | finder
  // 할 일 규칙: 목록 · 켜기/끄기·글 고치기({ enabled?, text? }) · 지우기
  todoRuleEdit: (id, patch) => ipcRenderer.invoke('todo-rule-edit', String(id), patch),
  todoRuleDelete: (id) => ipcRenderer.invoke('todo-rule-delete', String(id)),
  // opts: { threadId?, todoId?, model?, clientId? } — threadId 없으면 새 대화(todoId 면 그 할 일의 대화). 결과 { ok, chatId, threadId, queued?, position? }
  chatStop: (chatId) => ipcRenderer.invoke('chat-stop', String(chatId)), // 답하던 것 멈추기 → POST /chat/:chatId/stop
  chatNow: (chatId) => ipcRenderer.invoke('chat-now', String(chatId)), // 기다리던 말 지금 보내기(답하던 건 멈춤) → POST /chat/:chatId/now
  // 마지막 내 말 고치기(✏️) → POST /chat/threads/:id/messages/:n/edit · 줄 선 말 고치기 → POST /chat/:chatId/edit
  chatEdit: (threadId, n, text, opts) => ipcRenderer.invoke('chat-edit', String(threadId), Number(n), String(text), opts && typeof opts === 'object' ? { ...opts } : {}),
  chatEditQueued: (chatId, text) => ipcRenderer.invoke('chat-edit-queued', String(chatId), String(text)),
  chatSend: (text, opts) => ipcRenderer.invoke('chat-send', String(text), {
    threadId: opts?.threadId == null ? null : String(opts.threadId),
    todoId: opts?.todoId == null ? null : String(opts.todoId),
    model: opts?.model == null ? null : String(opts.model),
    clientId: opts?.clientId == null ? null : String(opts.clientId), // 이 말의 id(낙관적 사본 ↔ 데몬 큐·기록 짝 맞추기)
    attachments: Array.isArray(opts?.attachments) ? opts.attachments.map(String) : null, // 먼저 올려 둔 첨부 id(chatAttach)
  }),
  // 첨부 올리기(📎·끌어다 놓기·⌘V) → POST /chat/attachments → { ok, data: { attachment: { id, name, kind, size, mime } } }
  chatAttach: (name, mime, bytes) => ipcRenderer.invoke('chat-attach', String(name), String(mime ?? ''), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  // 보낸 말의 첨부를 기본 앱으로 열기(threadId + 저장 이름 — 메인·데몬이 첨부 폴더 안인지 확인)
  openAttachment: (threadId, file) => ipcRenderer.invoke('attachment-open', String(threadId), String(file)),
  chatQueue: () => ipcRenderer.invoke('chat-queue'), // 줄 선 말·지금 답하는 말(GET /chat/queue) → { queue, running }
  listModels: () => ipcRenderer.invoke('session-models'), // 고를 수 있는 모델(GET /models)
  listCommands: () => ipcRenderer.invoke('slash-commands'), // 슬래시 명령 자동완성 목록(GET /commands)
  // 대화 스레드: 목록(archived=true 면 보관함) · 이름/보관({title?, archived?}) · 삭제 · 말(before = 순번)
  onThreads: on('threads'),
  chatThreads: (archived) => ipcRenderer.invoke('chat-threads', archived === true),
  chatThreadEdit: (id, patch) => ipcRenderer.invoke('chat-thread-edit', String(id), patch && typeof patch === 'object' ? { title: patch.title, archived: patch.archived } : {}),
  chatThreadDelete: (id) => ipcRenderer.invoke('chat-thread-delete', String(id)),
  chatThreadMessages: (id, before) => ipcRenderer.invoke('chat-thread-messages', String(id), Number.isInteger(before) ? before : null),
  // ↻ 이 대화가 터미널 Claude Code 에서 이어 간 말 불러오기 → { ok, data: { imported } }
  chatThreadSync: (id) => ipcRenderer.invoke('chat-thread-sync', String(id)),
  chatThreadAgents: (id) => ipcRenderer.invoke('chat-thread-agents', String(id)), // → { agents: [...] }
  onAgents: on('agents'), // { threadId } — 그 대화의 서브에이전트가 바뀜
  agentStop: (toolUseId) => ipcRenderer.invoke('agent-stop', String(toolUseId)), // 백그라운드 에이전트 멈추기(대기 중이면 취소) → POST /chat/agents/:toolUseId/stop
  // 확인 카드(회의 응답 등): SSE action · 실행/취소(decision = 'confirm' | 'cancel') · 목록(threadId 선택)
  onAction: on('action'),
  actionDecide: (id, decision) => ipcRenderer.invoke('action-decide', String(id), String(decision)),
  // 도구 권한 규칙([항상 허용]): 목록 · 지우기
  permissions: () => ipcRenderer.invoke('permissions'),
  permissionDelete: (id) => ipcRenderer.invoke('permission-delete', String(id)),
  openLink: (url) => ipcRenderer.send('open-link', String(url)),
  caps: () => ipcRenderer.invoke('caps-get'), // { claude, codex, agy } — 이 컴퓨터에 Claude Code·Codex·Antigravity 가 있나(코드 관련 버튼 숨기기)
  onCaps: on('caps'),
  copyText: (text) => ipcRenderer.invoke('copy-text', String(text)),
  agentLogin: (agent) => ipcRenderer.invoke('agent-login', agent === 'codex' || agent === 'agy' ? agent : 'claude'),
  sisaGet: () => ipcRenderer.invoke('sisa-get'),
  sisaCheck: (provider, apiKey) => ipcRenderer.invoke('sisa-check', String(provider || ''), String(apiKey || '')),
  sisaSkip: () => ipcRenderer.invoke('sisa-skip'),
  sisaModels: (provider) => ipcRenderer.invoke('sisa-models', String(provider || '')),
  sisaSetModels: (pick) => ipcRenderer.invoke('sisa-set-models', pick && typeof pick === 'object' ? pick : {}),
  sisaSetOrder: (order) => ipcRenderer.invoke('sisa-set-order', Array.isArray(order) ? order.map(String) : []),
  sisaSetVoice: (patch) => ipcRenderer.invoke('sisa-set-voice', patch && typeof patch === 'object' ? patch : {}),
  gskFound: () => ipcRenderer.invoke('gsk-found'), // gsk login 한 Genspark 키가 이 맥에 있나(키는 안 온다)
  sisaUseGsk: () => ipcRenderer.invoke('sisa-use-gsk'),
  sisaUseCli: (agent) => ipcRenderer.invoke('sisa-use-cli', agent === 'codex' || agent === 'agy' ? agent : 'claude'),
  sisaAddCli: (agent) => ipcRenderer.invoke('sisa-add-cli', agent === 'codex' || agent === 'agy' ? agent : 'claude'),
  sisaMark: (id, url) => ipcRenderer.invoke('sisa-mark', String(id || ''), url == null ? '' : String(url)),
  // [연결 해제]: AI(gemini|claude|openai|genspark|claudecode|codexcli|agycli) · 커넥터(slack|calendar|mail|issues)
  sisaDisconnect: (provider) => ipcRenderer.invoke('sisa-disconnect', String(provider || '')),
  connectorDisconnect: (cap) => ipcRenderer.invoke('connector-disconnect', String(cap || '')),
  // 캘린더 여러 개: 목록 { ok, items: [{ id, kind, title, label }] }(주소는 없음) · 하나 빼기(id) → { ok, items, note?, error? }
  calendarList: () => ipcRenderer.invoke('calendar-list'),
  calendarRemove: (id) => ipcRenderer.invoke('calendar-remove', String(id || '')),
  // 뇌(말 거는 AI) 연결 상태(brain-state.js brainView) — 없으면 입력 대신 연결 안내 카드
  brain: () => ipcRenderer.invoke('brain-get'),
  onBrain: on('brain'),
  // AI 연결 안내 카드 숨김(데스크톱 state.json): { hidden }
  connectCardGet: () => ipcRenderer.invoke('connect-card-get'),
  connectCardSet: (hidden) => ipcRenderer.invoke('connect-card-set', !!hidden),
  // 설치 마법사: 이름·레포 폴더 읽기/쓰기(데몬 설정) · 폴더 고르기 · 사용법 둘러보기
  setupLoad: () => ipcRenderer.invoke('setup-load'),
  setupSave: (patch) => ipcRenderer.invoke('setup-save', patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
  pickFolder: (kind) => ipcRenderer.invoke('pick-folder', kind),
  startTour: () => ipcRenderer.send('start-tour'),
  // 작업 세션 창(runId 없으면 돌고 있는 것·최근 것)
  // toolUseId(선택): 그 Agent 줄을 펼쳐서 — 채팅의 에이전트 줄·카드
  openSession: (runId, toolUseId) => ipcRenderer.send('open-session', runId == null ? null : String(runId), toolUseId == null ? null : String(toolUseId)),
  // 세션 창 "원래 화면 열기": { type: 'thread'|'todo'|'proposal', … } — 그 대화·할 일·제안으로
  onOpenOrigin: on('open-origin'),
  // 할 일 상태·그 대화(GET /todos/:id/thread/last): 원래 화면 열기가 그 줄로 갈지 대화로 갈지 정한다
  todoLastAsk: (id) => ipcRenderer.invoke('todo-last-ask', String(id)),
  // 집중하기: SSE focus · 지금 상태 · cmd('start'|'pause'|'resume'|'stop') · 날마다 집중한 초(from·to = 로컬 YYYY-MM-DD)
  onFocus: on('focus'),
  focusGet: () => ipcRenderer.invoke('focus-get'),
  focusCmd: (cmd) => ipcRenderer.invoke('focus-cmd', String(cmd)),
  focusStats: (from, to) => ipcRenderer.invoke('focus-stats', String(from), String(to)),
  // 설정 화면(renderer/settings.js)용: panel 의 cy.* 이름과 겹치지 않게 cy.settings 아래에 둔다. 메인이 패널에서 온 요청만 받는다.
  settings: {
    getSettings: () => ipcRenderer.invoke('settings-get'), // → { ok, data: GET /settings }
    // patch = { models?: { quick|general|code|light: id }, briefing?: { exclude: [...] } } → { ok, status, data }
    saveSettings: (patch) => ipcRenderer.invoke('settings-put', patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
    getConnections: () => ipcRenderer.invoke('connections-get'),
    checkConnection: (id) => ipcRenderer.invoke('connections-check', id == null ? null : String(id)), // id: net|claude|services|gh|local, 없으면 전부
    // 행동 지침: 목록 · 추가 { text, scope? } · 고치기(id, { text?, scope?, active? }) · 지우기(id) → { ok, status, data }
    getGuidelines: () => ipcRenderer.invoke('guidelines-get'),
    addGuideline: (g) => ipcRenderer.invoke('guidelines-add', g && typeof g === 'object' ? JSON.parse(JSON.stringify(g)) : null),
    editGuideline: (id, patch) => ipcRenderer.invoke('guidelines-edit', String(id), patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
    deleteGuideline: (id) => ipcRenderer.invoke('guidelines-delete', String(id)),
    getCaps: () => ipcRenderer.invoke('caps-get'), // { claude, codex } — 이 컴퓨터에 Claude Code·Codex 가 있나
    // [연결 해제]: 앱의 AI 저장(publicView, 키 없음) · AI 끊기(id) · 커넥터 끊기(cap) · 안내 명령 복사
    getSisa: () => ipcRenderer.invoke('sisa-get'),
    disconnectBrain: (id) => ipcRenderer.invoke('sisa-disconnect', String(id || '')),
    disconnectConnector: (cap) => ipcRenderer.invoke('connector-disconnect', String(cap || '')),
    // 캘린더 여러 개: 목록 { ok, items: [{ id, kind, title, label }] }(주소는 없음) · 하나 빼기(id) → { ok, items, note?, error? }
    getCalendars: () => ipcRenderer.invoke('calendar-list'),
    removeCalendar: (id) => ipcRenderer.invoke('calendar-remove', String(id || '')),
    copyText: (text) => ipcRenderer.invoke('copy-text', String(text || '')),
    openDoc: (doc) => ipcRenderer.send('settings-open-doc', String(doc)), // docs/connect/*.md — 설치 화면에 없는 연결(메일·이슈)의 안내를 GitHub 에서
    getAppPrefs: () => ipcRenderer.invoke('settings-app-get'), // { version, openAtLogin: { available, on, hint }, updateCheck, showInDock(맥) }
    setAppPrefs: (patch) => ipcRenderer.invoke('settings-app-set', patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
    recordShortcut: (on) => ipcRenderer.send('settings-shortcut-recording', on === true), // 새 단축키를 받는 동안 메뉴 단축키를 비운다
    startTour: () => ipcRenderer.send('start-tour'), // 사용법 다시 보기(캐릭터 말풍선)
    // 캐릭터: 목록(GET /characters) · 만들기 { name, from?, lines?, frame? } · 고치기(id, { name?, lines?, frame? }) · 기본값으로(id) · 지우기(id)
    // · 그림 올리기(id, 칸, 이름, 종류, 바이트) · 그림 빼기(id, 칸) → { ok, status, data }
    getCharacters: () => ipcRenderer.invoke('characters-list'),
    createCharacter: (body) => ipcRenderer.invoke('characters-create', body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : null),
    updateCharacter: (id, body) => ipcRenderer.invoke('characters-update', String(id), body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : null),
    resetCharacter: (id) => ipcRenderer.invoke('characters-reset', String(id)),
    deleteCharacter: (id) => ipcRenderer.invoke('characters-delete', String(id)),
    putCharacterMedia: (id, slot, name, mime, bytes) => ipcRenderer.invoke('characters-media-put', String(id), String(slot), String(name), String(mime ?? ''), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
    deleteCharacterMedia: (id, slot) => ipcRenderer.invoke('characters-media-delete', String(id), String(slot)),
    onCharacters: on('characters'),
  },
  close: () => ipcRenderer.send('close-panel'),
});
