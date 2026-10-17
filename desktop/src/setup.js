// 처음 설치 때 설치 마법사를 열지 정하는 판단.

// 처음 설치: Slack·캘린더가 둘 다 아직 준비가 안 됐을 때만 마법사를 연다.
// 커넥터 목록이 없는 예전 데몬은 가만히 둔다.
export function needsSetup(connectors) {
  if (!Array.isArray(connectors) || connectors.length === 0) return false;
  const want = ['slack', 'calendar'];
  const rows = connectors.filter((c) => c && want.includes(c.cap));
  return rows.length === want.length && rows.every((c) => c.ready !== true);
}
