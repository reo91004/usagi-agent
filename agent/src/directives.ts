// Slack 지시사항(#41·#119): 지시를 줄 사람(config directiveFrom, Slack 사용자 id)이 나에게 보낸 DM, 나를 멘션한 글,
//   내가 들어가 있는 채널에 쓴 글을 따로 모은다. 할 일은 자동으로 넣지 않고 제안 카드에서 고른다.
//   (처음엔 DM·멘션만이었으나 2026-10-17 사용자가 채널 글도 넣기로 바꿨다. 봇·내 글·맞장구는 어느 쪽이든 뺀다)
//   재료는 Slack 수집(api 모드)이 쌓은 message 노드 — 서버·모델 호출 없음. 그래서 어떤 뇌든 같다.
//   새 지시는 core 의 Slack → 할 일 자동 흐름에서 빼고(중복 방지 — DM·멘션은 core 가 지시자 글을 걸러내고, 채널 글은 그 흐름에 원래 들어오지 않는다), 패널 카드의 [할 일로]·[괜찮아요]로 사용자가 정한다.
//   정한 것은 directive_state 표(메시지 id → todo|dismissed)에 남긴다.
import type { DatabaseSync } from "node:sqlite";
import { NOT_MUTED, mutedJson, permalinkOf } from "./ingest/slack.ts";
import type { Store } from "./store.ts";
import { oneLine } from "./text.ts";

export type DirectiveState = "open" | "todo" | "dismissed";
export type Directive = {
  id: string; author: string; authorName: string; text: string; at: string;
  channelLabel: string; isDM: boolean; permalink?: string; state: DirectiveState; todoId?: string;
};

export const okSlackUserId = (v: unknown): v is string => typeof v === "string" && /^[UW][A-Z0-9]{2,20}$/.test(v);

export function ensureDirectiveTables(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS directive_state (id TEXT PRIMARY KEY, state TEXT NOT NULL, todo_id TEXT, at TEXT NOT NULL)");
}

// Slack 원문 표기 → 읽는 글: <@U…> → @이름, <#C…|이름> → #이름, <url|글> → 글, &lt; 등
export function slackPlain(t: string, nameOf: (id: string) => string): string {
  return t
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${nameOf(id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
// 「넵」「ㅇㅋ」·이모지만 같은 짧은 맞장구는 지시가 아니다
const isAck = (t: string) => oneLine(t.replace(/:[a-z0-9_+-]+:/g, "")).length < 4;

// 그 사람들이 sinceIso 뒤에 보낸 DM·멘션·채널 글, 최신 먼저. state 로 거르기(기본: 다)
export function directivesSince(store: Store, from: readonly string[], sinceIso: string, opts: { limit?: number; state?: DirectiveState } = {}): Directive[] {
  const who = from.filter(okSlackUserId);
  if (!who.length) return [];
  ensureDirectiveTables(store.db);
  let rows: any[];
  try {
    rows = store.db.prepare(`SELECT n.id, n.updated, n.props, d.state, d.todo_id FROM nodes n LEFT JOIN directive_state d ON d.id = n.id
      WHERE n.kind = 'message' AND n.updated >= ?
        AND json_extract(n.props, '$.author') IN (${who.map(() => "?").join(", ")})
        AND coalesce(json_extract(n.props, '$.fromMe'), 0) = 0 AND coalesce(json_extract(n.props, '$.bot'), 0) = 0
        AND coalesce(json_extract(n.props, '$.channel'), '') NOT IN (SELECT value FROM json_each(?))
      ORDER BY n.updated DESC LIMIT 200`).all(sinceIso, ...who, mutedJson(store)) as any[];
  } catch { return []; } // Slack 수집 전
  const teamUrl = (() => {
    try { return (store.db.prepare("SELECT value FROM slack_meta WHERE key = 'teamUrl'").get() as any)?.value as string | undefined; } catch { return undefined; }
  })();
  const out: Directive[] = [];
  for (const r of rows) {
    const p = JSON.parse(r.props);
    const text = slackPlain(String(p.text ?? ""), (id) => (store.node(`person:${id}`)?.props.isMe ? "나" : store.node(`person:${id}`)?.label ?? id));
    if (isAck(text)) continue;
    const state: DirectiveState = r.state === "todo" || r.state === "dismissed" ? r.state : "open";
    if (opts.state && opts.state !== state) continue;
    const inThread = p.thread_ts && p.thread_ts !== p.ts;
    const permalink = permalinkOf(teamUrl, p.channel, p.ts, inThread ? p.thread_ts : undefined);
    out.push({
      id: r.id, author: String(p.author), authorName: String(p.authorName ?? p.author), text: text.slice(0, 1000), at: r.updated,
      channelLabel: store.node(`channel:${p.channel}`)?.label ?? String(p.channel), isDM: !!p.isDM,
      ...(permalink ? { permalink } : {}), state, ...(r.todo_id ? { todoId: String(r.todo_id) } : {}),
    });
    if (out.length >= (opts.limit ?? 30)) break;
  }
  return out;
}

export function markDirective(db: DatabaseSync, id: string, state: Exclude<DirectiveState, "open">, todoId?: string) {
  ensureDirectiveTables(db);
  db.prepare("INSERT INTO directive_state (id, state, todo_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, todo_id = excluded.todo_id, at = excluded.at")
    .run(id, state, todoId ?? null, new Date().toISOString());
}

// 지시 하나 → 할 일 하나(제목은 글 첫 줄, 메모에 누가·어디서, 링크는 그 메시지). addTodo 는 core 의 것(규칙 적용)
export function directiveTodo(d: Directive): { title: string; priority: number; note: string; link?: string; source: string } {
  const first = oneLine(d.text.split("\n").find((l) => l.trim()) ?? d.text);
  return {
    title: first.length > 80 ? `${first.slice(0, 79)}…` : first,
    priority: 2,
    note: `${d.authorName} 지시(${d.isDM ? "DM" : d.channelLabel}): ${oneLine(d.text).slice(0, 400)}`,
    ...(d.permalink ? { link: d.permalink } : {}),
    source: "slack",
  };
}

// 지시자 고르기: 최근 30일 DM·채널 글을 많이 보낸 사람(봇·나 빼고). count = DM 수, channel = 채널 글 수
export type DirectiveCandidate = { id: string; name: string; count: number; channel: number };
export function directiveCandidates(store: Store, sinceIso: string, limit = 6): DirectiveCandidate[] {
  try {
    return (store.db.prepare(`SELECT json_extract(props, '$.author') AS who, max(json_extract(props, '$.authorName')) AS name,
        sum(coalesce(json_extract(props, '$.isDM'), 0) = 1) AS dm, sum(coalesce(json_extract(props, '$.isDM'), 0) != 1) AS ch FROM nodes
      WHERE kind = 'message' AND updated >= ?
        AND coalesce(json_extract(props, '$.fromMe'), 0) = 0 AND coalesce(json_extract(props, '$.bot'), 0) = 0 AND ${NOT_MUTED}
      GROUP BY who ORDER BY dm + ch DESC, who LIMIT ?`).all(sinceIso, mutedJson(store), limit) as any[])
      .filter((r) => okSlackUserId(r.who)).map((r) => ({ id: r.who, name: String(r.name ?? r.who), count: Number(r.dm), channel: Number(r.ch) }));
  } catch { return []; }
}

export function formatDirectives(items: Directive[]): string {
  if (!items.length) return "(지시 없음)";
  return items.map((d) => `- [${d.at.slice(5, 16).replace("T", " ")}] ${d.authorName}${d.isDM ? " DM" : ` ${d.channelLabel}`}${d.state === "todo" ? " (할 일로 넣음)" : d.state === "dismissed" ? " (넘김)" : ""}: ${oneLine(d.text).slice(0, 200)}${d.permalink ? ` <${d.permalink}>` : ""}`).join("\n");
}

export type DirectivesView = { from: { id: string; name: string }[]; candidates: DirectiveCandidate[]; open: Directive[] };
// 패널 카드: 지시자·(아직 없으면) 고를 사람·아직 정하지 않은 지시(14일)
export function directivesView(store: Store, from: readonly string[], now = new Date()): DirectivesView {
  const since = (d: number) => new Date(now.getTime() - d * 86400e3).toISOString();
  const name = (id: string) => store.node(`person:${id}`)?.label ?? id;
  return {
    from: from.filter(okSlackUserId).map((id) => ({ id, name: name(id) })),
    candidates: directiveCandidates(store, since(30)).filter((c) => !from.includes(c.id)),
    open: directivesSince(store, from, since(14), { state: "open", limit: 10 }),
  };
}

