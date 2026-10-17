// 패널 창의 Dock·Cmd+Tab 표시와 캐릭터 두 번 클릭 판단(순수 로직)

// 패널이 열려 있는 동안은 Dock·Cmd+Tab 에 보여 다른 앱에 가려져도 돌아올 수 있게 하고, 설정 「Dock 에 보이기」가 켜져 있으면 늘 보인다
export const dockWanted = ({ panelVisible, showInDock }) => showInDock === true || !!panelVisible;

// 캐릭터 두 번 클릭: 보이고 앞(포커스)이면 숨기고, 가려졌거나 안 보이면 앞으로
export const panelClickAction = ({ visible, focused }) => (visible && focused ? 'hide' : 'show');
