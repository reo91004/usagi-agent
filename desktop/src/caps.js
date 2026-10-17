// 이 컴퓨터에서 쓸 수 있는 코딩 도구(Claude Code·Codex·Antigravity) — 순수 로직. 확인 자체(agent-login.js)는 main 이 한다.
// 코드 고치기·작업 세션·이어 하기는 뇌가 Codex·agy 면 그 CLI, 아니면 Claude Code 로 돈다(데몬 GET /status 의 features.code).
// 워크트리·백그라운드 에이전트는 Claude Code 만. 고칠 수 없으면(키·로컬 뇌에 Claude Code 도 없음) 버튼은 숨기고, 누를 길이 남아 있으면 쉬운 말로 안내한다.

// 모르면(아직 확인 전) 있다고 본다 — 예전처럼 다 보이고, 확인이 끝나면 맞춘다
export const UNKNOWN_CAPS = Object.freeze({ claude: null, codex: null, agy: null });

// agentLogin 결과 셋 → { claude, codex, agy } (로그인까지 돼 있어야 true)
export function normCaps(claude, codex, agy) {
  return { claude: claude?.loggedIn === true, codex: codex?.loggedIn === true, agy: agy?.loggedIn === true };
}

// 코드 고치기(작업 세션·새 작업·이어 하기·자동 머지)를 할 수 있나: main 이 데몬 features.code 를 code 로 붙여 준다(없으면 Claude Code 로그인)
export const hasCoder = (caps) => (caps?.code ?? caps?.claude) !== false;
export const sameCaps = (a, b) => a?.claude === b?.claude && a?.codex === b?.codex && a?.agy === b?.agy && a?.code === b?.code;

// 기능별 안내(누를 수 있는 곳에서 Claude Code 가 없을 때)
export const CODER_HINTS = {
  session: '작업 세션은 코드를 고칠 때 생겨요. 코드 고치기는 Claude Code·Codex·Antigravity 중 하나가 있어야 해요. 지금은 대화·브리핑·할 일만 써요.',
  code: '코드 고치기는 Claude Code·Codex·Antigravity 중 하나가 있어야 해요. 위쪽 [연결 도우미]에서 연결할 수 있어요.',
};
export const coderHint = (feature) => CODER_HINTS[feature] ?? CODER_HINTS.code;

// 확인 결과를 잠깐 기억(Claude Code 확인은 프로세스를 하나 띄운다). force 면 새로
export function createCapsProbe(check, { ttlMs = 5 * 60e3, now = () => Date.now() } = {}) {
  let last = null;
  let at = 0;
  let inflight = null;
  return {
    get: () => last ?? UNKNOWN_CAPS,
    async refresh(force = false) {
      if (!force && last && now() - at < ttlMs) return last;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const [c, x, g] = await check();
          last = normCaps(c, x, g);
          at = now();
        } catch {
          // 확인이 깨졌으면 예전 값(없으면 모름)
        }
        inflight = null;
        return last ?? UNKNOWN_CAPS;
      })();
      return inflight;
    },
  };
}
