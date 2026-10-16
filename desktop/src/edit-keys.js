// 맥 입력창의 ⌘C·⌘V·⌘X·⌘A 는 원래 앱의 「편집」 메뉴를 거친다. Dock 을 숨기면 메뉴 막대가 없고, 캐릭터 입력창은
// 앱을 활성화하지 않는 패널이라 메뉴로 가지 않을 수 있다. 그래서 창이 키를 받는 단계(before-input-event)에서 직접 처리한다.
// ⌘Z 는 뺀다: 패널이 입력창 밖의 ⌘Z 로 할 일 삭제를 되돌린다(panel.js). 한글 입력 중이면 key 가 한글이라 물리 키(code)로 본다
const COMMANDS = { c: 'copy', v: 'paste', x: 'cut', a: 'selectAll' };

export function editCommand(input) {
  if (input?.type !== 'keyDown' || !input.meta || input.control || input.alt || input.shift) return null;
  const k = /^[a-z]$/i.test(input.key) ? input.key.toLowerCase() : /^Key([A-Z])$/.exec(input.code ?? '')?.[1].toLowerCase();
  return COMMANDS[k] ?? null;
}
