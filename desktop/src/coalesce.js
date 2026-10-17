// 같은 일을 겹쳐서 두 번 하지 않게 하는 작은 도구 둘. 시계는 주입(시험은 가짜로).

// 같은 key 의 요청은 진행 중이면 그 약속을 같이 쓰고, 끝난 뒤 ttlMs 동안은 결과를 다시 쓴다. 실패(ok:false)는 담아 두지 않는다.
// invalidate(key) 는 진행 중인 약속도 버려서 다음 get 이 새로 받는다.
export function createCoalescer(fetcher, { ttlMs, now = Date.now }) {
  const slots = new Map(); // key → { p, at, done }
  return {
    get(key) {
      const s = slots.get(key);
      if (s && (!s.done || now() - s.at < ttlMs)) return s.p;
      const slot = { done: false, at: 0, p: null };
      slot.p = fetcher(key).then((r) => {
        if (slots.get(key) === slot) {
          if (r?.ok) { slot.done = true; slot.at = now(); } else slots.delete(key);
        }
        return r;
      });
      slots.set(key, slot);
      return slot.p;
    },
    invalidate(key) { slots.delete(key); },
    clear() { slots.clear(); },
  };
}

// 늦춰서 한 번만 실행. schedule 을 다시 부르면 이미 기다리는 중이니 그대로 두고, cancel 하면 없던 일로.
export function createDelayed(fn, ms, { setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
  let t = null;
  return {
    schedule() { if (!t) t = st(() => { t = null; fn(); }, ms); },
    cancel() { if (t) { ct(t); t = null; } },
  };
}
