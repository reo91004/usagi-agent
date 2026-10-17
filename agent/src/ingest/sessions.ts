// Claude Code / Codex 세션 JSONL → 지식그래프(session · project · file 노드).
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Store } from "../store.ts";
import { IS_WIN, winNorm } from "../plat.ts";
import { loadSshSessionHosts } from "./ssh-hosts.ts";

export type SessionDigest = {
  id: string;
  tool: "claude" | "codex";
  cwd?: string;
  branch?: string;
  title?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  lastAssistant?: string;
  started?: string;
  ended?: string;
  turns: number;
  files: string[];
};

const clip = (s: string | undefined, n: number) =>
  s === undefined ? undefined : s.length > n ? s.slice(0, n - 1) + "…" : s;

// 사람이 친 프롬프트만 — 하네스가 주입한 태그/지시문은 뺀다
function isHumanText(s: string): boolean {
  const t = s.trimStart();
  return t.length > 0 && !t.startsWith("<") && !t.startsWith("# AGENTS.md") && !t.startsWith("Caveat:");
}

function textOf(content: unknown, kind: "text" | "input_text" | "output_text"): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((b: any) => b?.type === kind && typeof b.text === "string").map((b: any) => b.text);
  return parts.length ? parts.join("\n") : undefined;
}

// JSONL 을 1MB 씩 읽어 한 줄씩 낸다. 통째로 읽지 않는다: 앱(Electron)의 Node 는 2GB 넘는 파일을
// readFileSync(…, "utf8") 하면 오류 대신 프로세스째 죽는다(PartitionAlloc OOM, SIGTRAP).
// 문자열로 만들 수 없을 만큼 긴 줄은 빈 줄로 낸다.
// from 바이트부터 읽고, end 는 그 줄 다음 바이트 위치(줄바꿈으로 끝나지 않은 마지막 줄은 end = -1).
function* readLinesFrom(path: string, from = 0): Generator<{ line: string; end: number }> {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let parts: Buffer[] = [];
    let base = from; // buf[0] 의 파일 내 위치
    let n: number;
    const flush = function* (end: number) {
      if (!parts.length) return;
      const line = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      parts = [];
      let text = "";
      try { text = line.toString("utf8"); } catch { /* 너무 긴 줄: 빈 줄로 넘겨 읽은 자리만 앞으로 */ }
      yield { line: text, end };
    };
    while ((n = readSync(fd, buf, 0, buf.length, base)) > 0) {
      let start = 0;
      for (let i = buf.indexOf(10, 0); i !== -1 && i < n; i = buf.indexOf(10, start)) {
        parts.push(Buffer.from(buf.subarray(start, i)));
        yield* flush(base + i + 1);
        start = i + 1;
      }
      if (start < n) parts.push(Buffer.from(buf.subarray(start, n)));
      base += n;
    }
    yield* flush(-1);
  } finally {
    closeSync(fd);
  }
}

export function* readLines(path: string): Generator<string> {
  for (const l of readLinesFrom(path)) yield l.line;
}

// 이어 접는 파서: step(줄) 로 먹이고 finish() 로 지금까지의 결과를 얻는다. save() 는 JSON 으로 저장할 중간 상태
// (긴 글은 recordSession 이 자르는 길이로 미리 잘라 둔다 — 자르기는 여러 번 해도 같다)
type Fold = { step(line: string): void; finish(): SessionDigest | undefined; save(): FoldState };
type FoldState = Omit<SessionDigest, "tool">;
const savedOf = (d: SessionDigest, files: Set<string>): FoldState => {
  const { tool: _, ...rest } = d;
  return { ...rest, firstPrompt: clip(d.firstPrompt, 400), lastPrompt: clip(d.lastPrompt, 400), lastAssistant: clip(d.lastAssistant, 600), files: [...files] };
};
const parseLine = (line: string): any => {
  if (!line) return undefined;
  try { return JSON.parse(line); } catch { return undefined; }
};

function claudeFold(fallbackId: string, saved?: FoldState): Fold {
  const d: SessionDigest = { id: fallbackId, turns: 0, files: [], ...saved, tool: "claude" };
  const files = new Set<string>(saved?.files);
  return {
    step(line) {
      const e = parseLine(line);
      if (!e) return;
      if (e.sessionId) d.id = e.sessionId;
      if (e.cwd) d.cwd = e.cwd;
      if (e.gitBranch && e.gitBranch !== "HEAD") d.branch = e.gitBranch;
      if (e.timestamp) { d.started ??= e.timestamp; d.ended = e.timestamp; }
      if (e.type === "ai-title" && e.aiTitle) d.title ??= e.aiTitle;
      if (e.type === "custom-title" && e.customTitle) d.title = e.customTitle;
      if (e.type === "user" && !e.isMeta) {
        const t = textOf(e.message?.content, "text");
        if (t && isHumanText(t)) { d.firstPrompt ??= t; d.lastPrompt = t; d.turns++; }
      }
      if (e.type === "assistant") {
        for (const b of e.message?.content ?? []) {
          if (b?.type === "text" && b.text?.trim()) d.lastAssistant = b.text;
          if (b?.type === "tool_use" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(b.name)) {
            const p = b.input?.file_path ?? b.input?.notebook_path;
            if (typeof p === "string") files.add(p);
          }
        }
      }
    },
    finish: () => (d.turns ? { ...d, files: [...files] } : undefined),
    save: () => savedOf(d, files),
  };
}

function codexFold(fallbackId: string, saved?: FoldState): Fold {
  const d: SessionDigest = { id: fallbackId, turns: 0, files: [], ...saved, tool: "codex" };
  return {
    step(line) {
      const e = parseLine(line);
      if (!e) return;
      if (e.timestamp) { d.started ??= e.timestamp; d.ended = e.timestamp; }
      const p = e.payload ?? {};
      if (e.type === "session_meta") { d.id = p.id ?? d.id; d.cwd = p.cwd ?? d.cwd; d.branch = p.git?.branch ?? d.branch; }
      if (e.type === "turn_context" && p.cwd) d.cwd = p.cwd;
      if (e.type === "response_item" && p.type === "message") {
        if (p.role === "user") {
          const t = textOf(p.content, "input_text");
          if (t && isHumanText(t)) { d.firstPrompt ??= t; d.lastPrompt = t; d.turns++; }
        } else if (p.role === "assistant") {
          const t = textOf(p.content, "output_text");
          if (t?.trim()) d.lastAssistant = t;
        }
      }
    },
    finish: () => (d.turns ? { ...d } : undefined),
    save: () => savedOf(d, new Set()),
  };
}

const foldAll = (fold: Fold, raw: string | Iterable<string>) => {
  for (const line of typeof raw === "string" ? raw.split("\n") : raw) fold.step(line);
  return fold.finish();
};
export const parseClaudeSession = (raw: string | Iterable<string>, fallbackId: string) => foldAll(claudeFold(fallbackId), raw);
export const parseCodexSession = (raw: string | Iterable<string>, fallbackId: string) => foldAll(codexFold(fallbackId), raw);

export function recordSession(store: Store, s: SessionDigest) {
  const sid = `session:${s.id}`;
  store.upsertNode(sid, "session", s.title ?? clip(s.firstPrompt, 60) ?? s.id, {
    tool: s.tool, cwd: s.cwd, branch: s.branch, started: s.started, turns: s.turns,
    firstPrompt: clip(s.firstPrompt, 400), lastPrompt: clip(s.lastPrompt, 400),
    lastAssistant: clip(s.lastAssistant, 600), files: s.files.slice(0, 30),
  }, s.ended);
  if (s.cwd) {
    const pid = `project:${s.cwd}`;
    store.upsertNode(pid, "project", basename(s.cwd), { path: s.cwd }, s.ended);
    store.link(sid, "in", pid);
  }
  for (const f of s.files) {
    const fid = `file:${f}`;
    store.upsertNode(fid, "file", basename(f), { path: f }, s.ended);
    store.link(sid, "edited", fid);
  }
}

// 접는 규칙(claudeFold·codexFold·isHumanText 등)을 바꾸면 올린다: 저장된 중간 상태를 버리고 처음부터 다시 읽는다
const FOLD_V = 1;
type SavedRead = { v: number; offset: number; ino: number; edge: string; fold: FoldState };
// 이어 읽을 자리가 같은 파일인지: 맨 앞과 읽은 자리 바로 앞 각 256바이트의 해시(덧붙기만 했으면 그대로다)
function edgeHash(path: string, off: number): string {
  const fd = openSync(path, "r");
  try {
    const n = Math.min(256, off), b = Buffer.alloc(n * 2);
    readSync(fd, b, 0, n, 0);
    readSync(fd, b, n, n, off - n);
    return createHash("sha1").update(b).digest("hex");
  } finally {
    closeSync(fd);
  }
}

function* walkJsonl(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "subagents") yield* walkJsonl(p); } // 서브에이전트 트랜스크립트는 부모 세션에 포함 — 들어가지 않는다
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

// 시사(cy-agent) 데이터 폴더 안에서 돈 세션인가 — 이 설치(skipCwdPrefix)뿐 아니라 같은 맥의 다른 설치
// (~/.cy-agent, ~/.cy-agent-xxx 등)의 두뇌 대화·자동수정 세션도 내 작업 기록이 아니다
export function isCyAgentCwd(cwd: string | undefined, skipCwdPrefix?: string, home = homedir()): boolean {
  if (!cwd) return false;
  // Windows: 드라이브 글자·대소문자·구분자가 섞여 기록될 수 있다(c:\ · C:/)
  const starts = (p: string) => (IS_WIN ? winNorm(cwd).startsWith(winNorm(p)) : cwd.startsWith(p));
  if (skipCwdPrefix && starts(skipCwdPrefix)) return true;
  return starts(join(home, ".cy-agent"));
}

// 바뀐 파일만(mtime 기준) 늘어난 부분부터 이어 읽는다. 반환: 새로 반영한 세션 수
// skipCwdPrefix: 데몬 자신이 돌린 세션(브리핑·자동수정)은 기록에서 뺀다(같은 맥의 다른 시사 설치 폴더도 — isCyAgentCwd)
// host: ssh 서버에서 받아 온 기록(ingest/remote-sessions.ts) — cwd 를 「서버:/경로」로 적어 이 맥의 폴더와 섞이지 않게
// ssh-<id> 폴더(Claude 데스크탑 앱의 SSH 세션)는 앱 세션 정보로 서버를 찾아 같은 모양으로 적는다(ssh-hosts.ts, 패스마다 처음 필요할 때 한 번 읽음).
//   서버를 찾은 파일은 「서버 확인」 표시를 따로 남겨, 서버를 모르던 때 쌓은 세션도 한 번 다시 읽는다. sshHosts: 테스트용 주입
export function ingestSessions(
  store: Store, dirs: { claude: string; codex: string },
  opts: { sinceMs?: number; skipCwdPrefix?: string; host?: string; sshHosts?: Map<string, string> } = {},
): number {
  const { sinceMs = 14 * 864e5, skipCwdPrefix } = opts;
  let sshHosts = opts.sshHosts;
  let n = 0;
  const cutoff = Date.now() - sinceMs;
  for (const [tool, dir] of [["claude", dirs.claude], ["codex", dirs.codex]] as const) {
    for (const path of walkJsonl(dir)) {
      let st;
      try { st = statSync(path); } catch { continue; }
      const mtime = st.mtimeMs;
      if (mtime < cutoff) continue;
      const sshId = !opts.host && tool === "claude" ? /^ssh-(.+)$/.exec(basename(dirname(path)))?.[1] : undefined;
      const hostMark = sshId ? `ssh-host:${path}` : "";
      // 바뀌지 않았고 서버도 이미 찾아본 파일은 앱 세션 정보를 읽지 않고 건너뛴다(못 찾은 것도 0 으로 남겨 매번 다시 읽지 않는다)
      if (store.markOf(path) === mtime && (!hostMark || store.markOf(hostMark) !== undefined)) continue;
      const host = sshId ? (sshHosts ??= loadSshSessionHosts()).get(sshId) : opts.host;
      const id = basename(path, ".jsonl");
      const mk = tool === "claude" ? claudeFold : codexFold;
      // 이어 읽기: 접는 규칙이 같고, 같은 파일(inode)이 줄지 않았고 읽은 자리 앞이 그대로일 때만. 아니면 처음부터
      let saved: SavedRead | undefined;
      try { saved = JSON.parse(store.stateOf(path) ?? "null") ?? undefined; } catch { saved = undefined; }
      const resume = saved?.v === FOLD_V && saved.ino === st.ino && st.size >= saved.offset && edgeHash(path, saved.offset) === saved.edge;
      const fold = mk(id, resume ? saved!.fold : undefined);
      let offset = resume ? saved!.offset : 0;
      let s: SessionDigest | undefined;
      try {
        for (const { line, end } of readLinesFrom(path, offset)) {
          if (end < 0) { // 줄바꿈 없는 마지막 줄: 결과에만 반영하고 저장 상태에는 넣지 않는다(다음에 완성된 줄로 다시 읽음)
            const tail = mk(id, fold.save());
            tail.step(line);
            s = tail.finish();
            break;
          }
          fold.step(line);
          offset = end;
        }
        s ??= fold.finish();
        store.setState(path, JSON.stringify({ v: FOLD_V, offset, ino: st.ino, edge: edgeHash(path, offset), fold: fold.save() } satisfies SavedRead));
      } catch { continue; }
      if (s && !isCyAgentCwd(s.cwd, skipCwdPrefix)) {
        if (host && s.cwd) s.cwd = `${host}:${s.cwd}`;
        recordSession(store, s);
        n++;
      }
      store.setMark(path, mtime);
      if (hostMark) store.setMark(hostMark, host ? 1 : 0);
    }
  }
  return n;
}
