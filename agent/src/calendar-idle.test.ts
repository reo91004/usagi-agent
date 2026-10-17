import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { Config } from "./config.ts";
import { CalendarSync } from "./calendar-sync.ts";

test("CalendarSync: MCP 는 한 시간 넘게 자리를 비우면 동기화를 쉬고 돌아오면 한 번, ICS 는 그대로", async () => {
  for (const mode of ["mcp", "api"] as const) {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "cy-cal-idle-")), "t.db"));
    let now = Date.parse("2026-10-08T02:00:00Z"), idle = 0, calls = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const cal = new CalendarSync({ models: { light: "x" }, connectors: { calendar: { mode } } } as unknown as Config, store, {
      now: () => new Date(now), idleSec: async () => idle,
      setTimer: (fn, ms) => { timers.push({ at: now + ms, fn }); return 0 as any; }, clearTimer: () => {},
      source: async () => { calls++; return { ok: true, events: [], calls: 0, errors: 0, costUsd: 0 }; },
    });
    const advance = async (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((x, y) => x.at - y.at);
        if (!timers.length || timers[0].at > end) break;
        const t = timers.shift()!; now = t.at; t.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = end;
    };
    cal.schedule(() => {});
    await advance(10);
    assert.equal(calls, 1, mode); // 켤 때 한 번
    idle = 61 * 60; // 자리 비움
    await advance(2 * 3600e3);
    const away = calls;
    if (mode === "mcp") assert.equal(away, 1); else assert.ok(away >= 4);
    idle = 5; // 돌아옴
    await advance(2 * 60e3);
    assert.equal(calls, away + (mode === "mcp" ? 1 : 0), mode); // mcp 는 돌아오면 한 번, api 는 이미 30분 안에 가져왔으니 그대로
  }
});
