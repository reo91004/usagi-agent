// 패널 「개요」의 연구 카드(#40): 실험(usagi-run 작업)·오늘 연구 노트·어제 요약. 연구 쪽 연결(sshHosts·jobHosts·tineGraph)이 없으면 없다.
// 순수하게 로컬 DB·파일만 본다(서버 접속 없음). GPU 는 패널에서 버튼을 누를 때만 따로 가져온다(remote-fs.ts remoteGpu).
import { existsSync } from "node:fs";
import type { Config } from "./config.ts";
import { dayStart, localDay } from "./focus.ts";
import { remoteHosts } from "./remote-fs.ts";
import { notePath } from "./research-note.ts";
import type { Store } from "./store.ts";

export type ResearchJob = {
  id: string; name: string; host?: string; state: "running" | "done" | "failed" | "lost";
  start?: number; seconds?: number; code?: number | null; cwd?: string; cmd?: string; files?: string[]; at: string;
};
export type Research = {
  hosts: string[];
  jobs: ResearchJob[];
  note?: { day: string; exists: boolean; yesterday?: { day: string; lines: string[]; next: string[] } };
};

const strs = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, n) : []);
const RECENT = 6; // 끝난 작업은 최근 몇 개만(도는 작업은 다)

export function researchSummary(cfg: Pick<Config, "sshHosts" | "jobHosts" | "tineGraph">, store: Store, now = new Date()): Research | undefined {
  const hosts = remoteHosts(cfg);
  if (!hosts.length && !cfg.tineGraph) return undefined;
  const all = store.nodesSince("job", new Date(now.getTime() - 3 * 86400e3).toISOString(), 200);
  const shaped = all.map((j): ResearchJob => {
    const p = j.props as Record<string, any>;
    const state = p.running ? "running" : p.lost ? "lost" : p.code !== null && p.code !== undefined && p.code !== 0 ? "failed" : "done";
    const files = strs(p.files, 8);
    return {
      id: j.id, name: j.label, state, at: j.updated,
      ...(p.host ? { host: String(p.host) } : {}), ...(Number(p.start) > 0 ? { start: Number(p.start) } : {}),
      ...(state === "done" || state === "failed" ? { seconds: Number(p.seconds) || 0, code: Number.isInteger(p.code) ? p.code : null } : {}),
      ...(p.cwd ? { cwd: String(p.cwd) } : {}), ...(p.cmd ? { cmd: String(p.cmd) } : {}), ...(files.length ? { files } : {}),
    };
  });
  const jobs = [...shaped.filter((j) => j.state === "running"), ...shaped.filter((j) => j.state !== "running").slice(0, RECENT)];
  let note: Research["note"];
  if (cfg.tineGraph) {
    const today = localDay(now.getTime());
    const yday = localDay(dayStart(today) - 12 * 3600e3);
    const s = store.node(`note-summary:${yday}`);
    const lines = strs(s?.props.lines, 3), next = strs(s?.props.next, 3);
    note = { day: today, exists: existsSync(notePath(cfg.tineGraph, today)), ...(lines.length || next.length ? { yesterday: { day: yday, lines, next } } : {}) };
  }
  return { hosts, jobs, ...(note ? { note } : {}) };
}

// 패널 「열기」: 그 날짜 노트 파일 경로(있을 때만). 날짜 모양이 아니면 거절
export function notePathFor(cfg: Pick<Config, "tineGraph">, day: string): string | null {
  if (!cfg.tineGraph || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const p = notePath(cfg.tineGraph, day);
  return existsSync(p) ? p : null;
}
