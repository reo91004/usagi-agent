// 뒤에서 도는 일(브리핑·캘린더 MCP 동기화)이 Codex 뇌로도 사용자 MCP 를 읽는다(#164). 가짜 codex exec 가 데몬 문지기 주소로 진짜 MCP 호출을 보내고,
// 진짜 문지기가 읽기 도구만 통과시킨다. 사용자 MCP 서버는 stdio 로 띄운 가짜(도구 두 개: list_events 읽기, send_event 쓰기)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bus } from "./bus.ts";
import { Store } from "./store.ts";
import { Agent, type SlackPort } from "./core.ts";
import { loadConfig, type Config } from "./config.ts";
import { mcpHandler } from "./mcp-http.ts";
import { readOnlyGate, type CliMcpServer } from "./cli-mcp.ts";
import { setCliMcpUrl, type ExecFileLike } from "./providers.ts";
import { mcpCalendarSource } from "./calendar-sync.ts";
import { resetSkipNotes } from "./feature-brain.ts";

const mod = (p: string) => pathToFileURL(resolve(import.meta.dirname, "../node_modules", p)).href;
const dir = mkdtempSync(join(tmpdir(), "cy-bgmcp-"));
const calls = join(dir, "calls.log");
writeFileSync(join(dir, "fake.mjs"), `
import { appendFileSync } from "node:fs";
import { McpServer } from "${mod("@modelcontextprotocol/sdk/dist/esm/server/mcp.js")}";
import { StdioServerTransport } from "${mod("@modelcontextprotocol/sdk/dist/esm/server/stdio.js")}";
import { z } from "${mod("zod/index.js")}";
const s = new McpServer({ name: "cal", version: "1" });
const text = (t) => ({ content: [{ type: "text", text: t }] });
s.registerTool("list_events", { inputSchema: {} }, async () => { appendFileSync(${JSON.stringify(calls)}, "list_events\\n"); return text("[]"); });
s.registerTool("send_event", { inputSchema: { title: z.string() } }, async () => { appendFileSync(${JSON.stringify(calls)}, "send_event\\n"); return text("sent"); });
await s.connect(new StdioServerTransport());
`);
const server: CliMcpServer = { name: "cal", caps: ["일정"], tools: ["list_events"], def: { command: process.execPath, args: [join(dir, "fake.mjs")], env: {} } };
const conn = { mode: "mcp", cap: "calendar", server: "cal", tools: { listEvents: "list_events" } } as any;
const cfg = (provider: string) => loadConfig({}, { brain: { provider } } as any) as Config;
const win = { from: "2026-10-17T00:00:00+09:00", to: "2026-10-19T00:00:00+09:00" };
const EVENT = { id: "e1", subject: "랩 미팅", start: "2026-10-17T10:00:00+09:00", end: "2026-10-17T11:00:00+09:00", allDay: false, cancelled: false, declined: false, online: false };

// 가짜 codex: 인자의 cal 문지기 주소로 도구를 부른다(list_events, 그리고 send_event 를 시도) 한 뒤 JSON 답
function fakeCodex(callList: boolean) {
  const seen: { write?: string } = {};
  const execFile: ExecFileLike = async (_f, args) => {
    const url = args.find((a) => a.startsWith("mcp_servers.cal.url="))!.split("=")[1];
    const c = new Client({ name: "fake-codex", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(JSON.parse(url))));
    if (callList) await c.callTool({ name: "list_events", arguments: {} });
    const w: any = await c.callTool({ name: "send_event", arguments: { title: "x" } });
    seen.write = w.isError ? w.content[0].text : "ALLOWED";
    await c.close();
    const text = JSON.stringify({ ok: true, events: [EVENT] });
    return { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) };
  };
  return { execFile, seen };
}

async function withDaemon<T>(fn: () => Promise<T>): Promise<T> {
  const bus = new Bus(), token = "b".repeat(64);
  await bus.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", mcp: mcpHandler(token, () => []) });
  setCliMcpUrl(`http://127.0.0.1:${(bus.server!.address() as any).port}/mcp/${token}`);
  try { return await fn(); } finally { setCliMcpUrl(undefined); bus.server!.close(); bus.server!.closeAllConnections?.(); }
}

test("캘린더 MCP 동기화: Codex 뇌는 문지기를 거쳐 listEvents 만 읽고 일정을 돌려준다, 쓰기 도구는 거절", async () => {
  writeFileSync(calls, "");
  const f = fakeCodex(true);
  const r = await withDaemon(() => mcpCalendarSource(conn, undefined, { servers: () => [server], codex: { execFile: f.execFile, commandExists: () => true } })(cfg("codex"), win));
  assert.equal(r.ok, true);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.events.map((e) => e.subject), ["랩 미팅"]);
  assert.match(f.seen.write!, /읽기 도구만/);
  assert.equal(readFileSync(calls, "utf8"), "list_events\n"); // 진짜 서버에 닿은 건 읽기 하나뿐
});

test("캘린더 MCP 동기화: Codex 가 listEvents 를 안 부르고 일정을 지어내면 저장하지 않는다(ok=false)", async () => {
  const f = fakeCodex(false);
  const r = await withDaemon(() => mcpCalendarSource(conn, undefined, { servers: () => [server], codex: { execFile: f.execFile, commandExists: () => true } })(cfg("codex"), win));
  assert.equal(r.ok, false);
  assert.equal(r.calls, 0);
});

test("캘린더 MCP 동기화: agy 뇌와 Codex 에 못 넘기는 서버는 건너뛴다(예전 일정 유지)", async () => {
  resetSkipNotes();
  const none: any = () => { throw new Error("부르면 안 된다"); };
  const opts = { servers: () => [], codex: { execFile: none, commandExists: () => true } };
  for (const p of ["agy", "codex"]) assert.deepEqual(await mcpCalendarSource(conn, none, opts)(cfg(p), win), { ok: false, events: [], calls: 0, errors: 0, costUsd: 0 });
});

test("브리핑: Codex·agy 뇌는 넘길 수 있는 MCP 서버의 출처를 지시에 남기고 읽기 문지기를 붙인다", async () => {
  const mail: CliMcpServer = { name: "gmail", caps: ["메일"], tools: ["search_emails"], def: server.def };
  const run = async (provider: string, servers: CliMcpServer[]) => {
    const c = cfg(provider);
    c.connectors = { ...c.connectors, mail: { mode: "mcp", cap: "mail", server: "gmail", tools: { search: "search_emails" } } } as any;
    const bus = new Bus();
    bus.bubble = () => "b"; bus.dashboardChanged = () => {};
    const slack: SlackPort = { post: async () => ({ channel: "D0", ts: "1" }), update: async () => {} };
    let got: { task: string; deps?: any } = { task: "" };
    const agent = new Agent(c, new Store(":memory:"), bus, slack, {
      think: async (_c: any, _s: any, task: string, _o: any, o: any) => { got = { task, deps: o.deps }; return { bubble: "b", reply_md: "r", todos: [], done_todo_ids: [], proposals: [] }; },
      git: async () => [], ready: () => new Set(["mail"]), cliServers: () => servers,
    } as any);
    await agent.runBriefing();
    return got;
  };
  const sig = new AbortController().signal;
  const cx = await run("codex", [mail]);
  assert.match(cx.task, /mcp__gmail__search_emails/);
  assert.deepEqual([cx.deps.mcp, cx.deps.servers.map((s: CliMcpServer) => s.name)], [true, ["gmail"]]);
  assert.deepEqual(await cx.deps.gate("mcp__gmail__search_emails", {}, sig), { allow: true });
  assert.ok("deny" in await cx.deps.gate("mcp__gmail__send_email", {}, sig));
  const ag = await run("agy", [mail]);
  assert.equal(ag.deps.gate, undefined); // agy 는 전역 설정의 읽기 도구
  assert.equal(ag.deps.mcp, true);
  const none = await run("codex", []);
  assert.doesNotMatch(none.task, /mcp__gmail__/);
  assert.equal(none.deps, undefined);
  assert.ok("deny" in await readOnlyGate([mail])("mcp__other__search_emails", {}, sig));
});
