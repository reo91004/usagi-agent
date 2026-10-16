// 캐릭터 오른쪽 클릭 메뉴와 메뉴 막대 메뉴가 같이 쓰는 템플릿. 순수 로직 — 동작·아이콘은 main 이 넘긴다.
// s: { name, connected, brainLabel, coder, bubblesHidden }, a: { open, session, briefing, settings, tour, toggleBubbles, quit }, icon(symbol) → NativeImage | undefined
export function menuTemplate(s, a, icon = () => undefined) {
  const it = (label, symbol, click) => {
    const img = icon(symbol);
    return { label, click, ...(img ? { icon: img } : {}) };
  };
  const brain = s.connected && s.brainLabel ? ` · ${s.brainLabel}` : '';
  return [
    { label: `${s.name} ${s.connected ? '켜짐' : '꺼짐'}${brain}`, enabled: false },
    { type: 'separator' },
    it('패널 열기', 'rectangle.on.rectangle', a.open),
    ...(s.coder ? [it('작업 세션 열기', 'terminal', a.session)] : []),
    it('지금 브리핑', 'newspaper', a.briefing),
    { type: 'separator' },
    it('설정…', 'gearshape', a.settings),
    it('사용법 다시 보기', 'questionmark.circle', a.tour),
    { type: 'separator' },
    { label: '말풍선 숨기기', type: 'checkbox', checked: !!s.bubblesHidden, click: a.toggleBubbles },
    { type: 'separator' },
    it(`${s.name} 끄기`, 'power', a.quit),
  ];
}
