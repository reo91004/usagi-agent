// 패널 다시 그리기·주기 확인을 줄이는 작은 순수 도우미(DOM 은 모른다)

// 같은 key·글이면 이미 만든 노드를 다시 쓴다(마크다운 파싱·정화를 건너뜀). get 으로 쓴 것만 end() 뒤에 남는다
export function createNodeCache() {
  let old = new Map();
  let cur = new Map();
  return {
    get(key, text, build) {
      const hit = old.get(key);
      const dup = cur.has(key); // 같은 key 가 한 번 더 오면 노드를 나눠 쓸 수 없으니 새로 만든다
      const node = hit && hit.text === text && !dup ? hit.node : build();
      if (!dup) cur.set(key, { text, node });
      return node;
    },
    end() { old = cur; cur = new Map(); },
  };
}

// 진행 이벤트(step)로는 안 바뀌는 대화 상태의 모양: 같으면 말·대기 줄은 그대로 두고 「답하는 중」 글만 고치면 된다
export function pendingShape(chat) {
  return JSON.stringify(Object.entries(chat.pending).map(([id, p]) => { const { step: _s, ...rest } = p; return [id, rest]; }));
}

// 보이는 구역만 지금 그리고 나머지(또는 창이 숨겨졌으면 전부)는 나중에 그릴 것으로 표시
export function planRender(all, current, hidden) {
  return { now: hidden ? [] : all.filter((s) => s === current), dirty: hidden ? [...all] : all.filter((s) => s !== current) };
}

// 이전 확인이 끝난 뒤에야 다음을 예약한다. next(결과)가 ms 를 주면 그만큼 뒤에 다시, null 이면 멈춘다.
// stop() 은 예약을 걷고 진행 중이던 확인의 결과도 버린다(start 는 이미 돌고 있으면 아무것도 안 함)
export function createPoller(run, next) {
  let token = 0;
  let timer = null;
  let active = false;
  const step = async (t) => {
    let res;
    try { res = await run(); } catch { res = undefined; }
    if (t !== token) return;
    const ms = next(res);
    if (ms == null) { active = false; return; }
    timer = setTimeout(() => step(t), ms);
  };
  return {
    get active() { return active; },
    start() {
      if (active) return;
      active = true;
      step(++token);
    },
    stop() { token++; clearTimeout(timer); timer = null; active = false; },
  };
}
