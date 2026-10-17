// 패널 「설정」 화면용 IPC(메인 프로세스 쪽). 일렉트론 객체는 main.js 가 넘긴다(시험은 가짜로).
// 모델·브리핑 출처 저장(PUT /settings) · 연결 상태(GET /connections, POST /connections/check) · 행동 지침 · 캐릭터 · 이 앱.
// 받는 쪽은 패널 창 하나뿐이다(오버레이·세션 창의 요청은 거절).

// deps: { ipcMain, shell, request(method, path, body?, timeoutMs?), fromPanel(e), caps?(),
//         sisa?() 앱의 AI 저장(publicView), disconnectBrain?(id), disconnectConnector?(cap), copyText?(text),
//         calendars?() 연결된 캘린더(가린 이름), removeCalendar?(id) 하나 빼기,
//         appPrefs?: { get() → { version, openAtLogin: { available, on, hint }, updateCheck }, set(patch) } 「이 앱」 칸,
//         upload?(method, path, name, mime, bytes) 파일 바이트 그대로 올리기(캐릭터 그림) }
export function setupSettings(deps) {
  const { ipcMain } = deps;
  const isMine = deps.fromPanel;
  ipcMain.handle('settings-get', (e) => (isMine(e) ? deps.request('GET', '/settings') : denied()));
  ipcMain.handle('settings-put', (e, patch) => {
    const p = isMine(e) ? sanitizeSettingsPatch(patch) : null;
    return p ? deps.request('PUT', '/settings', p) : denied();
  });
  ipcMain.handle('connections-get', (e) => (isMine(e) ? deps.request('GET', '/connections', undefined, 20000) : denied()));
  // claude·services 는 SDK 를 띄우거나 경량 모델을 한 번 부른다 — 넉넉히
  ipcMain.handle('connections-check', (e, id) => {
    if (!isMine(e) || (id != null && !okCheckId(id))) return denied();
    return deps.request('POST', '/connections/check', id ? { id } : {}, 90000);
  });
  // 행동 지침(GET/POST /guidelines · PUT/DELETE /guidelines/:id)
  ipcMain.handle('guidelines-get', (e) => (isMine(e) ? deps.request('GET', '/guidelines') : denied()));
  ipcMain.handle('guidelines-add', (e, g) => {
    const p = isMine(e) ? sanitizeGuidelineAdd(g) : null;
    return p ? deps.request('POST', '/guidelines', p) : denied();
  });
  ipcMain.handle('guidelines-edit', (e, id, patch) => {
    const p = isMine(e) && okGuidelineId(id) ? sanitizeGuidelinePatch(patch) : null;
    return p ? deps.request('PUT', `/guidelines/${id}`, p) : denied();
  });
  ipcMain.handle('guidelines-delete', (e, id) => (isMine(e) && okGuidelineId(id) ? deps.request('DELETE', `/guidelines/${id}`) : denied()));
  // 이 컴퓨터에서 쓸 수 있는 것({ claude, codex }) — Claude Code 가 없으면 코드 관련 칸은 안내로
  ipcMain.handle('settings-caps', async (e) => (isMine(e) ? ((await deps.caps?.()) ?? {}) : denied()));
  // [연결 해제]: AI 칸(연결된 AI 줄) · 연결 상태(커넥터 줄). 끊는 일은 main 이(패널과 같은 함수)
  ipcMain.handle('settings-sisa', (e) => (isMine(e) && deps.sisa ? deps.sisa() : denied()));
  ipcMain.handle('settings-brain-disconnect', (e, id) => (isMine(e) && okBrainId(id) && deps.disconnectBrain ? deps.disconnectBrain(id) : denied()));
  ipcMain.handle('settings-connector-disconnect', (e, cap) => (isMine(e) && okCap(cap) && deps.disconnectConnector ? deps.disconnectConnector(cap) : denied()));
  // 캘린더 여러 개: 목록(가린 이름만) · 하나 빼기(id). 빼는 일은 main 이(패널과 같은 함수)
  ipcMain.handle('settings-calendars', (e) => (isMine(e) && deps.calendars ? deps.calendars() : denied()));
  ipcMain.handle('settings-calendar-remove', (e, id) => (isMine(e) && okCalendarId(id) && deps.removeCalendar ? deps.removeCalendar(id) : denied()));
  ipcMain.handle('settings-copy', (e, text) => (isMine(e) && typeof text === 'string' && text && deps.copyText ? deps.copyText(text) : denied()));
  ipcMain.on('settings-open-doc', (e, doc) => {
    if (isMine(e) && typeof doc === 'string' && /^docs\/connect\/[a-z0-9-]+\.md$/.test(doc)) deps.shell?.openExternal(`https://github.com/${REPO_SLUG}/blob/main/${doc}`).catch(() => {});
  });

  // 「이 앱」: 로그인할 때 켜기 · 새 버전 알림(앱의 state.json)
  ipcMain.handle('settings-app-get', (e) => (isMine(e) && deps.appPrefs ? deps.appPrefs.get() : denied()));
  ipcMain.handle('settings-app-set', (e, patch) => {
    const p = isMine(e) && deps.appPrefs ? sanitizeAppPrefs(patch) : null;
    return p ? deps.appPrefs.set(p) : denied();
  });

  // 캐릭터 만들기·고치기·지우기(데몬 /characters). 그림은 바이트로(채팅 첨부처럼), 저장 이름은 데몬이 짓는다
  ipcMain.handle('characters-list', (e) => (isMine(e) ? deps.request('GET', '/characters') : denied()));
  ipcMain.handle('characters-create', (e, body) => {
    const b = isMine(e) ? sanitizeCharacterBody(body, true) : null;
    return b ? deps.request('POST', '/characters', b, 30000) : denied();
  });
  ipcMain.handle('characters-update', (e, id, body) => {
    const b = isMine(e) && okCharacterId(id) ? sanitizeCharacterBody(body) : null;
    return b ? deps.request('PUT', `/characters/${id}`, b, 30000) : denied();
  });
  ipcMain.handle('characters-reset', (e, id) => (isMine(e) && okCharacterId(id) ? deps.request('DELETE', `/characters/${id}/lines`) : denied()));
  ipcMain.handle('characters-delete', (e, id) => (isMine(e) && okCharacterId(id) ? deps.request('DELETE', `/characters/${id}`) : denied()));
  ipcMain.handle('characters-media-put', (e, id, slot, name, mime, bytes) => {
    const u = isMine(e) && okCharacterId(id) && okMediaSlot(slot) && deps.upload ? cleanUpload(name, mime, bytes) : null;
    return u ? deps.upload('PUT', `/characters/${id}/media/${slot}`, u.name, u.mime, u.bytes) : denied();
  });
  ipcMain.handle('characters-media-delete', (e, id, slot) => (isMine(e) && okCharacterId(id) && okMediaSlot(slot) ? deps.request('DELETE', `/characters/${id}/media/${slot}`) : denied()));

  // 사용법 다시 보기
  ipcMain.on('settings-tour', (e) => { if (isMine(e)) deps.startTour?.(); });

  return { isSender: isMine };
}
