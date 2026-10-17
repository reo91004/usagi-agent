// 창을 지금 보고 있는 데스크탑(macOS Space)에 띄운다(#88).
// 숨겼다 다시 여는 패널·세션 창은 마지막으로 보였던 데스크탑에 묶여 있어서, 그냥 show() 하면 macOS 가 그 데스크탑으로 넘어간다.
// 잠깐 모든 데스크탑에 보이게 한 채 앞으로 가져오고 다시 끄면 창이 지금 데스크탑에 남는다.
// skipTransformProcessType: 켜고 끌 때 macOS 가 앱 종류를 바꿔 Dock 아이콘이 나타나거나 사라지지 않게(Dock 표시는 사용자 설정)
const KEEP_DOCK = { skipTransformProcessType: true };
// 앱 활성화(app.focus, 패널이 열리며 Dock 아이콘을 띄울 때 Electron 이 하는 재활성화 #121)는 macOS 가 나중에 처리한다.
// 그 전에 끄면 창은 옛 데스크탑 창이고, 활성화 때 macOS 가 그 데스크탑으로 넘어간다. 그래서 활성화가 끝난 뒤에 끈다
export const SETTLE_MS = 1000;
const settle = new WeakMap();

export function showOnCurrentSpace(win, app, platform = process.platform) {
  if (platform === 'darwin') {
    clearTimeout(settle.get(win));
    win.setVisibleOnAllWorkspaces(true, KEEP_DOCK);
    app.focus({ steal: true });
  }
  win.show();
  win.focus();
  if (platform === 'darwin') settle.set(win, setTimeout(() => { if (!win.isDestroyed()) win.setVisibleOnAllWorkspaces(false, KEEP_DOCK); }, SETTLE_MS));
}
