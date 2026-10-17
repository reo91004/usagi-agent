// 캐릭터 활동 상태: 데몬이 스스로 Agent SDK 세션을 돌리는 동안 "공부 중", 일정 알림(기본 10분 전) 땐 "춤".
// 우선순위 dancing > studying > idle. 춤이 끝나면 그 전 상태(돌고 있는 일이 있으면 studying)로 돌아간다.
// 버스가 SSE `state` 에 { activity, runs, danceId? } 를 실어 보낸다(docs/contract.md "캐릭터 활동").
//
// 무엇이 "공부 중"인가: 실행 기록(runs.ts)의 돌고 있는 run 중 사용자가 직접 부른 대화(chat)를 뺀 것 +
// 아직 runs 로 감싸지 않은 일을 begin() 으로 직접 알린 것. 주기 중계(슬랙·캘린더·자동 완료·프로필)는
// grace 안에 끝나면 아예 안 보인다(몇 초짜리 정기 작업마다 영상이 깜빡이지 않게).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

export type Activity = "idle" | "studying" | "dancing";
export type ActivityRun = { id: string; kind: string; title: string; startedAt: string };
// 춤 영상 종류: plan = 일정 알림 · dance = 「춤」(채팅·춤춰 줘 칩) · cheer = 응원해 줘 칩. 앱이 캐릭터마다 맞는 영상을 고른다
export type DanceClip = "plan" | "dance" | "cheer";
export type ActivitySnapshot = { activity: Activity; runs: ActivityRun[]; danceId?: string; danceClip?: DanceClip };

// runs.ts RunRegistry 의 필요한 부분만(구조적 타입 — 순환 의존 없이)
export type RunSource = {
  active(): { id: string; kind: string; title: string; startedAt: string; status: string }[];
  subscribe(fn: (u: { type: string }) => void): () => void;
};

export const EXCLUDED_KINDS: ReadonlySet<string> = new Set(["chat"]); // 사용자가 직접 부른 대화 — 생각 중 점으로 충분
export const GRACE_MS: Readonly<Record<string, number>> = { "slack-ingest": 20e3, slack: 20e3, calendar: 20e3, "todo-auto": 20e3, profile: 15e3 };

export function deriveActivity(runs: number, dancing: boolean): Activity {
  return dancing ? "dancing" : runs > 0 ? "studying" : "idle";
}

// 지금 보일 run 들과 다음에 다시 볼 시각(grace 가 끝나는 때). 순수 함수
export function visibleRuns(active: ActivityRun[], nowMs: number, grace: Readonly<Record<string, number>> = GRACE_MS): { runs: ActivityRun[]; recheckInMs?: number } {
  const runs: ActivityRun[] = [];
  let recheck: number | undefined;
  for (const r of active) {
    if (EXCLUDED_KINDS.has(r.kind)) continue;
    const left = Date.parse(r.startedAt) + (grace[r.kind] ?? 0) - nowMs;
    if (left <= 0 || Number.isNaN(left)) runs.push(r);
    else recheck = Math.min(recheck ?? Infinity, left);
  }
  return recheck === undefined ? { runs } : { runs, recheckInMs: recheck };
}

type Timer = ReturnType<typeof setTimeout>;
export type ActivityDeps = { now: () => Date; setTimer: (fn: () => void, ms: number) => Timer; clearTimer: (t: Timer) => void };

export class ActivityTracker {
  private manual = new Map<string, ActivityRun>();
  private source?: RunSource;
  private unsub?: () => void;
  private recheck?: Timer;
  private dance?: { id: string; timer: Timer; clip: DanceClip };
  private last = "";
  private deps: ActivityDeps;
  onChange?: (s: ActivitySnapshot) => void;

  constructor(deps: Partial<ActivityDeps> = {}) {
    this.deps = {
      now: () => new Date(),
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
      clearTimer: (t) => clearTimeout(t),
      ...deps,
    };
  }

  // 실행 기록에 붙인다: run 이 시작·끝날 때마다 다시 계산
  bindRuns(src: RunSource) {
    this.unsub?.();
    this.source = src;
    this.unsub = src.subscribe((u) => { if (u.type === "runs") this.refresh(); });
    this.refresh();
  }

  // 실행 기록 밖의 일 하나 시작. 반환: 끝내기(여러 번 불러도 한 번만)
  begin(kind: string, title: string): () => void {
    const run: ActivityRun = { id: randomUUID(), kind, title, startedAt: this.deps.now().toISOString() };
    this.manual.set(run.id, run);
    this.refresh();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.manual.delete(run.id);
      this.refresh();
    };
  }

  async track<T>(kind: string, title: string, fn: () => Promise<T> | T): Promise<T> {
    const end = this.begin(kind, title);
    try { return await fn(); } finally { end(); }
  }

  // 춤 ms 동안. 춤 중에 또 부르면 새 춤으로 늘린다. 끝나면 그 전 상태로
  startDance(ms = 8000, clip: DanceClip = "plan"): string {
    if (this.dance) this.deps.clearTimer(this.dance.timer);
    const id = randomUUID();
    this.dance = { id, clip, timer: this.deps.setTimer(() => { if (this.dance?.id === id) { this.dance = undefined; this.refresh(true); } }, ms) };
    this.refresh(true);
    return id;
  }

  snapshot(): ActivitySnapshot {
    const active: ActivityRun[] = [...(this.source?.active().filter((r) => r.status === "running") ?? []).map(({ id, kind, title, startedAt }) => ({ id, kind, title, startedAt })), ...this.manual.values()];
    const { runs } = visibleRuns(active, this.deps.now().getTime());
    const s: ActivitySnapshot = { activity: deriveActivity(runs.length, !!this.dance), runs };
    if (this.dance) { s.danceId = this.dance.id; s.danceClip = this.dance.clip; }
    return s;
  }

  // 바뀐 게 있을 때만 알린다. grace 가 끝나는 때에 다시 본다
  private refresh(force = false) {
    if (this.recheck) { this.deps.clearTimer(this.recheck); this.recheck = undefined; }
    const active: ActivityRun[] = [...(this.source?.active().filter((r) => r.status === "running") ?? []), ...this.manual.values()];
    const { recheckInMs } = visibleRuns(active, this.deps.now().getTime());
    if (recheckInMs !== undefined) this.recheck = this.deps.setTimer(() => this.refresh(), recheckInMs + 5);
    const s = this.snapshot();
    const key = JSON.stringify(s);
    if (!force && key === this.last) return;
    this.last = key;
    this.onChange?.(s);
  }

  stop() {
    this.unsub?.();
    if (this.recheck) this.deps.clearTimer(this.recheck);
    if (this.dance) this.deps.clearTimer(this.dance.timer);
  }
}

// 마지막 키보드·마우스 입력 뒤 지난 초(macOS ioreg 의 HIDIdleTime, 나노초). 부를 때만 ioreg 를 한 번 띄운다(수 ms).
// 다른 OS 이거나 못 읽으면 0(= 자리에 있음) — 브리핑을 미루지 않는 쪽으로
export const parseHidIdle = (out: string) => { const m = /"HIDIdleTime" = (\d+)/.exec(out); return m ? Number(m[1]) / 1e9 : 0; };
export const hidIdleSec = (): Promise<number> => process.platform !== "darwin" ? Promise.resolve(0) : new Promise((ok) => {
  execFile("ioreg", ["-c", "IOHIDSystem"], { timeout: 5e3, maxBuffer: 1 << 22 }, (err, out) => ok(err ? 0 : parseHidIdle(String(out))));
});

// 정기 브리핑: 입력이 awayMs 넘게 없으면(자리 비움) 미루고, 돌아올 때까지 recheckMs 마다 입력만 확인하다 돌아오면 한 번 돈다.
// 미루는 동안 들어온 매시간 신호는 무시(돌아와서 한 번이면 충분). 업무시간이 끝나면 미룬 것도 버린다. 반환: 매시간 부를 함수
export function awayAwareBriefing(o: {
  idleSec: () => Promise<number>; inHours: () => boolean; run: () => unknown;
  awayMs?: number; recheckMs?: number; later?: (fn: () => void, ms: number) => void;
}) {
  const { awayMs = 60 * 60e3, recheckMs = 5 * 60e3, later = (fn, ms) => { setTimeout(fn, ms).unref(); } } = o;
  let waiting = false;
  const check = async () => {
    if (!o.inHours()) { waiting = false; return; }
    if ((await o.idleSec()) * 1000 >= awayMs) { waiting = true; later(check, recheckMs); return; }
    waiting = false;
    o.run();
  };
  return () => { if (!waiting) return check(); };
}
