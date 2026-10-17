// 창을 지금 보고 있는 데스크탑(macOS Space)에 띄운다(#88).
// 숨겼다 다시 여는 패널·세션 창은 마지막으로 보였던 데스크탑에 묶여 있어서, 그냥 show() 하면 macOS 가 그 데스크탑으로 넘어간다.
// 잠깐 모든 데스크탑에 보이게 한 채 앞으로 가져오고 다시 끄면 창이 지금 데스크탑에 남는다.
// skipTransformProcessType: 켜고 끌 때 macOS 가 앱 종류를 바꿔 Dock 아이콘이 나타나거나 사라지지 않게(Dock 표시는 사용자 설정)
const KEEP_DOCK = { skipTransformProcessType: true };

export function showOnCurrentSpace(win, app, platform = process.platform) {
  if (platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, KEEP_DOCK);
    app.focus({ steal: true });
  }
  win.show();
  win.focus();
  if (platform === 'darwin') win.setVisibleOnAllWorkspaces(false, KEEP_DOCK);
}
