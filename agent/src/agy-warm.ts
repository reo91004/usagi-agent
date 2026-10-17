// agy 미리 띄운 예비 프로세스(말 걸기 전용). agy 는 뜨는 데 4~5초가 걸리고 그동안 입력을 안 받아도 혼자 준비를 마친다(측정: .plans/measurements/agy-warm-20261017).
// 그래서 입력창이 열릴 때 stream-json 모드로 하나를 띄워 두고, 보낸 말 한 줄만 먹여 한 턴만 돌린 뒤 stdin 을 닫아 끝낸다.
// 한 프로세스로 대화를 이어 가면 턴마다 입력 토큰이 약 1.4만씩 늘어 한 프로세스는 한 턴만 쓴다.
// 이 모듈은 providers.ts 를 모른다(순환 방지): 프로세스를 만드는 spawn 은 밖에서 받고, 답은 result 이벤트 그대로 돌려준다.
import type { Readable, Writable } from "node:stream";

// 말이 없으면 3분 뒤 끈다: 켜 둔 agy 는 CPU ~0%·메모리 80~200MB 라 잠깐은 괜찮지만, 입력창을 열고 말 걸지 않은 채 오래 두면 자원만 잡는다
export const WARM_IDLE_MS = 3 * 60_000;

export type WarmChild = {
  stdin: Pick<Writable, "write" | "end"> & { on(ev: "error", f: () => void): unknown };
  stdout: Pick<Readable, "on">;
  stderr: Pick<Readable, "on">;
  on(ev: "exit" | "error", f: () => void): unknown;
  kill(): unknown;
};
export type WarmDeps = {
  spawn(args: string[], cwd: string): WarmChild;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  idleMs?: number;
};
export type Spare = { key: string; child: WarmChild; dead: boolean; timer?: unknown; err: string; result?: unknown; onEnd?: () => void };

export function createAgyWarm(deps: WarmDeps) {
  const setTimer = deps.setTimer ?? ((f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  const spares = new Map<string, Spare>(); // 같은 인자(모델·MCP)당 하나

  function drop(s: Spare) {
    if (s.timer !== undefined) clearTimer(s.timer);
    s.timer = undefined;
    if (spares.get(s.key) === s) spares.delete(s.key);
  }
  function kill(s: Spare) {
    drop(s);
    s.dead = true;
    s.child.kill();
  }
  const arm = (s: Spare) => { if (s.timer !== undefined) clearTimer(s.timer); s.timer = setTimer(() => kill(s), deps.idleMs ?? WARM_IDLE_MS); };

  return {
    // 있으면 타이머만 새로 하고(말 걸 낌새), 없으면 하나 띄운다
    prewarm(key: string, args: string[], cwd: string): void {
      const old = spares.get(key);
      if (old && !old.dead) return arm(old);
      const child = deps.spawn(args, cwd);
      const s: Spare = { key, child, dead: false, err: "" };
      let buf = "";
      child.stdout.on("data", (d: Buffer | string) => {
        buf += d;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.includes('"result"')) continue; // init·step_update 는 흘려보낸다
          try { const ev = JSON.parse(l); if (ev?.event === "result") { s.result = ev.result; s.onEnd?.(); } } catch { /* 줄 하나가 깨져도 다음 줄을 본다 */ }
        }
      });
      child.stderr.on("data", (d: Buffer | string) => { if (s.err.length < 8000) s.err += d; });
      const end = () => { s.dead = true; drop(s); s.onEnd?.(); };
      child.on("exit", end);
      child.on("error", end);
      child.stdin.on("error", () => {});
      spares.set(key, s);
      arm(s);
    },
    // 쓸 수 있는 예비를 꺼내 준다(꺼낸 뒤엔 이 말 하나에만 쓴다). 죽었거나 없으면 undefined — 호출한 쪽이 보통 방식으로
    take(key: string): Spare | undefined {
      const s = spares.get(key);
      if (!s || s.dead) return undefined;
      drop(s);
      return s;
    },
    // 말 한 줄을 먹이고 stdin 을 닫아 한 턴만 돌린다 → result 이벤트의 result. 실패는 stderr 를 실은 오류(agyFailure 가 읽는다)
    runTurn(s: Spare, input: string, timeoutMs: number): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => { reject(new Error("agy 실행 시간이 초과됐어요.")); s.dead = true; s.child.kill(); }, timeoutMs);
        const finish = () => {
          if (s.result === undefined && !s.dead) return;
          clearTimer(timer);
          if (s.result !== undefined) resolve(s.result);
          else reject(Object.assign(new Error("agy 실행이 실패했어요."), { stderr: s.err }));
        };
        s.onEnd = finish;
        s.child.stdin.write(`${JSON.stringify({ event: "user", message: { content: input } })}\n`);
        s.child.stdin.end();
        finish(); // 이미 죽어 있었던 경우
      });
    },
    // 설정이 바뀌었거나 데몬이 꺼진다: 남은 예비를 모두 끈다
    reset(): void {
      for (const s of [...spares.values()]) kill(s);
    },
    count: () => spares.size,
  };
}
export type AgyWarm = ReturnType<typeof createAgyWarm>;
