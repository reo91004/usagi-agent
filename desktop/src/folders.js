// 작업 폴더를 VS Code 로 여는 데 쓰는 순수 함수들. 파일·창은 main.js 가 만진다.

// ~/.ssh/config 글에서 구체적인 Host 별칭과 그 User 를 뽑는다(* ? ! 가 든 패턴은 별칭이 아니라서 뺀다)
export function sshConfigHosts(text) {
  const out = [];
  let cur = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^(host|user)\s*[=\s]\s*(.+)$/i.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() === 'host') {
      cur = m[2].split(/\s+/).filter((n) => /^[A-Za-z0-9._-]+$/.test(n)).map((host) => ({ host, user: '' }));
      out.push(...cur);
    } else for (const e of cur) e.user ||= m[2].trim();
  }
  return out;
}

// 서버 경로 /home/<user>/… 의 계정 이름. 아니면 ''
export const homeUser = (dir) => /^\/home\/([^/]+)\//.exec(dir)?.[1] || '';

// 서버 이름을 모르는 /home/<user>/… 경로의 후보: ssh User 가 같은 서버
export function candidateHosts(dir, hosts) {
  const u = homeUser(dir);
  return u ? hosts.filter((h) => h.user === u).map((h) => h.host) : [];
}

// VS Code Remote-SSH 로 여는 링크. host 는 ssh config 별칭이거나 user@host(별칭이 없는 서버, 엄격히 검사)이고 dir 은 절대 경로(조각마다 인코딩)
export function remoteUrl(host, dir, hosts) {
  if (!hosts.some((h) => h.host === host) && !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(host)) return null;
  if (typeof dir !== 'string' || !dir.startsWith('/') || /[\0\r\n]/.test(dir)) return null;
  return `vscode://vscode-remote/ssh-remote+${host}${dir.split('/').map(encodeURIComponent).join('/')}`;
}
