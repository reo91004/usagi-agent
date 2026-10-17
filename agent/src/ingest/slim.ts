// 받은 세션 JSONL 한 줄을 소비자(ingest/sessions.ts, kg/chunks.ts)가 읽는 필드만 남긴 같은 모양의 JSONL 줄로 바꾼다.
// 사람 글·AI 글·도구 입력값은 자르지 않는다(소비자의 자르는 길이와 묶지 않기 위해). 버리는 것: thinking·tool_result·소비자가 안 읽는 입력 키
// (Write·Edit 본문, apply_patch 본문)·소비자가 안 읽는 줄 종류. 줄 번호·바이트 위치는 원본과 달라진다(서버 오프셋은 사이드카에 따로).
// 소비자가 읽는 필드를 바꾸면 SLIM_V 를 올린다. 원본은 맥에 남지 않으므로 올리면 서버에서 처음부터 다시 받는 수밖에 없다.
export const SLIM_V = 1;
const MAX_LINE = 8 << 20; // readLinesFrom 과 같은 줄 상한: 넘는 줄은 소비자가 빈 줄로 본다
const INPUT_KEYS = ["command", "file_path", "notebook_path", "url", "query", "description", "cmd", "input"]; // toolExcerpt 가 읽는 키
const STATE = ["sessionId", "cwd", "gitBranch"]; // Claude: 소비자가 마지막 값(ingest)·첫 값(KG)으로 쓰는 필드
const CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);

// apply_patch 는 이름만 쓰므로 본문을 버린다. 객체가 아니면 빈 객체
function pickInput(input: any, name: string): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (name === "apply_patch" || !input || typeof input !== "object" || Array.isArray(input)) return o;
  for (const k of INPUT_KEYS) if (k in input) o[k] = input[k];
  return o;
}
// codexItems 가 입력을 만드는 방식 그대로
function codexInput(p: any) {
  let input = p.input ?? p.action;
  if (typeof p.arguments === "string") {
    try { input = JSON.parse(p.arguments); } catch { input = { command: p.arguments }; }
  }
  return typeof input === "string" ? { input } : input;
}
const texts = (content: any[], kind: string) =>
  content.filter((b) => b?.type === kind && typeof b.text === "string").map((b) => ({ type: kind, text: b.text }));

// Claude 한 줄 → 남길 모양(없으면 null)
function claudeKept(e: any, ctx: { titleSeen: boolean }) {
  const t = e.type;
  let body: any;
  if (t === "user") {
    const c = e.message?.content;
    const content = typeof c === "string" ? c : Array.isArray(c) ? texts(c, "text") : "";
    if (!content.length) return null;
    body = { message: { content } };
    for (const k of ["entrypoint", "isSidechain", "isMeta"]) if (k in e) body[k] = e[k];
    if (e.origin && typeof e.origin === "object" && "kind" in e.origin) body.origin = { kind: e.origin.kind };
  } else if (t === "assistant") {
    const c = e.message?.content;
    if (!Array.isArray(c)) return null;
    const blocks = c.flatMap((b: any): object[] =>
      b?.type === "text" && typeof b.text === "string" ? [{ type: "text", text: b.text }]
        : b?.type === "tool_use" && typeof b.name === "string" ? [{ type: "tool_use", name: b.name, input: pickInput(b.input, b.name) }] : []);
    if (!blocks.length) return null;
    body = { message: { content: blocks } };
  } else if (t === "ai-title" && e.aiTitle) {
    if (ctx.titleSeen) return null; // ingest 는 첫 ai-title 만 쓴다
    ctx.titleSeen = true;
    body = { aiTitle: e.aiTitle };
  } else if (t === "custom-title" && e.customTitle) {
    body = { customTitle: e.customTitle }; // 마지막 값이 이긴다
  } else return null;
  const out: any = { type: t, ...body };
  if (e.timestamp) out.timestamp = e.timestamp;
  for (const k of STATE) if (e[k]) out[k] = e[k];
  return out;
}

// Codex 한 줄 → 남길 모양(없으면 null). reasoning·*_output·compacted·token_count·item_completed 등은 소비자가 안 읽는다
function codexKept(e: any) {
  const t = e.type;
  const p = e.payload ?? {};
  let payload: any;
  if (t === "session_meta") {
    payload = {};
    for (const k of ["id", "cwd", "originator", "source"]) if (k in p) payload[k] = p[k];
    if (p.git && typeof p.git === "object" && "branch" in p.git) payload.git = { branch: p.git.branch };
  } else if (t === "turn_context") {
    if (!p.cwd) return null;
    payload = { cwd: p.cwd };
  } else if (t === "event_msg") {
    if (p.type !== "task_started") return null; // 이 줄만 imported 표시를 바꾼다
    payload = { type: "task_started", turn_id: p.turn_id };
  } else if (t === "response_item" && p.type === "message" && p.role === "user") {
    const content = typeof p.content === "string" ? p.content : Array.isArray(p.content) ? texts(p.content, "input_text") : "";
    if (!content.length) return null;
    payload = { type: "message", role: "user", content };
  } else if (t === "response_item" && p.type === "message" && p.role === "assistant") {
    const content = typeof p.content === "string" ? p.content : Array.isArray(p.content) ? texts(p.content, "output_text") : "";
    if (!(typeof content === "string" ? content : content.map((b: any) => b.text).join("\n")).trim()) return null; // 빈 글은 소비자가 건너뛴다
    payload = { type: "message", role: "assistant", content };
  } else if (t === "response_item" && CALLS.has(p.type)) {
    payload = { type: p.type, name: p.name, input: pickInput(codexInput(p), p.name) };
  } else return null;
  const out: any = { type: t, payload };
  if (e.timestamp) out.timestamp = e.timestamp;
  return out;
}

// 줄을 차례로 먹인다. 버려진 줄이 소비자가 보는 시각·cwd·gitBranch·sessionId 를 바꿀 때만 자리표시(type "stub")를 낸다:
//   끝 시각(시각 있는 마지막 줄)은 보류했다가 end() 에서, 처음 시각·cwd·gitBranch·sessionId 는 값이 바뀔 때만. 소비자는 stub 을 세션 정보에 쓰지 않는다.
// 상태는 인스턴스 안에만 있다(재시작하면 같은 값의 자리표시가 한 번 더 나올 뿐 소비자 결과는 같다).
function makeSlimmer(tool: "claude" | "codex") {
  const ctx = { titleSeen: false };
  const state = tool === "claude" ? STATE : [];
  const last: Record<string, string> = {};
  let sawTs = false;
  let pending: object | null = null;
  const stub = (e: any, st: object) => ({ type: "stub", ...(e.timestamp ? { timestamp: e.timestamp } : {}), ...st });
  return {
    push(line: string, out: string[]) {
      if (!line) return;
      let e: any;
      try { e = JSON.parse(line); } catch { return; } // 소비자도 못 읽는 줄
      if (!e || typeof e !== "object") return;
      const k = tool === "claude" ? claudeKept(e, ctx) : codexKept(e);
      if (k) {
        if (k.timestamp) { sawTs = true; pending = null; }
        for (const f of state) if (e[f]) last[f] = e[f];
        out.push(JSON.stringify(k));
        return;
      }
      const st: Record<string, string> = {};
      for (const f of state) if (e[f] && e[f] !== last[f]) st[f] = e[f];
      if (e.timestamp && !sawTs || Object.keys(st).length) {
        if (e.timestamp) { sawTs = true; pending = null; }
        out.push(JSON.stringify(stub(e, st)));
        Object.assign(last, st);
      } else if (e.timestamp) pending = stub(e, {});
    },
    end(out: string[]) {
      if (pending) out.push(JSON.stringify(pending));
      pending = null;
    },
  };
}

// 서버가 보낸 바이트 조각을 받아 「줄바꿈으로 끝난 줄」만 슬림으로 바꾼다. feed/end 는 파일에 덧붙일 글을 돌려준다.
// off = 처리한 서버 바이트 수(마지막 줄바꿈까지). 끝이 안 온 조각은 쓰지 않고 다음 요청(off 부터)에 다시 받는다.
export function makeReceiver(tool: "claude" | "codex") {
  const sl = makeSlimmer(tool);
  let rest: Buffer = Buffer.alloc(0);
  const joined = (out: string[]) => (out.length ? out.join("\n") + "\n" : "");
  const r = {
    off: 0,
    feed(chunk: Buffer) {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const out: string[] = [];
      let start = 0;
      for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, start)) {
        if (i - start <= MAX_LINE) sl.push(buf.toString("utf8", start, i), out);
        start = i + 1;
      }
      r.off += start;
      rest = Buffer.from(buf.subarray(start));
      return joined(out);
    },
    end() {
      const out: string[] = [];
      sl.end(out);
      return joined(out);
    },
  };
  return r;
}
