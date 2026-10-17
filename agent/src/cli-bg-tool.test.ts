// Codex 채팅이 agent_start 도구로 백그라운드 에이전트를 띄운다(#165): 열쇠는 채팅 실행 하나 동안만 유효하고,
// 띄우는 길은 Claude 뇌의 Agent 호출과 같은 broker.onBackgroundAgent 다. 가짜 codex 가 프롬프트에 적힌 열쇠로 진짜 MCP 호출을 보낸다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bus } from "./bus.ts";
import { Store } from "./store.ts";
import { loadConfig, type Config } from "./config.ts";
import { mcpHandler } from "./mcp-http.ts";
import { ask } from "./brain.ts";
import { PermissionBroker, PermissionRules } from "./permissions.ts";
import { setCliMcpUrl, type ExecFileLike } from "./providers.ts";

const cfg = loadConfig({}, { brain: { provider: "codex" } } as any) as Config;
const text = (r: any) => r.content[0].text as string;

async function withDaemon<T>(fn: () => Promise<T>): Promise<T> {
  const bus = new Bus(), token = "c".repeat(64);
  await bus.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", mcp: mcpHandler(token, () => []) });
  setCliMcpUrl(`http://127.0.0.1:${(bus.server!.address() as any).port}/mcp/${token}`);
  try { return await fn(); } finally { setCliMcpUrl(undefined); bus.server!.close(); bus.server!.closeAllConnections?.(); }
}
const callTool = async (url: string, args: Record<string, unknown>) => {
  const c = new Client({ name: "fake-codex", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  try { return text(await c.callTool({ name: "agent_start", arguments: args })); } finally { await c.close(); }
};
const reply = (r: string) => ({ stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ reply: r }) } }) });

test("agent_start: 채팅 실행 열쇠로 broker.onBackgroundAgent 를 부르고, 실행이 끝나면 열쇠가 죽는다", async () => {
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), { requestPermission: () => { throw new Error("카드 없음"); } } as any);
  const started: any[] = [];
  broker.onBackgroundAgent = (r) => { started.push(r); return "[백그라운드 에이전트] 시작했어요"; };
  let key = "", url = "", during = "", noKey = "";
  const execFile: ExecFileLike = async (_f, args, o) => {
    url = JSON.parse(args.find((a) => a.startsWith("mcp_servers.usagi.url="))!.split("=").slice(1).join("="));
    key = /agent_start 도구\(key: ([0-9a-f]+)\)/.exec(String(o?.input))![1];
    during = await callTool(url, { key, description: "리팩터", prompt: "~/repo 를 정리해 줘" });
    noKey = await callTool(url, { key: "0".repeat(32), description: "x", prompt: "y" });
    return reply("시작했어요");
  };
  await withDaemon(async () => {
    const out = await ask<string>(cfg, "뒤에서 따로 리팩터해 줘", null, undefined, {
      interactive: { origin: { via: "chat", threadId: "t1" }, broker }, deps: { execFile, commandExists: () => true },
    });
    assert.equal(out, "시작했어요");
    assert.match(during, /시작했어요/);
    assert.match(noKey, /띄울 수 없어요/);
    assert.match(await callTool(url, { key, description: "x", prompt: "y" }), /띄울 수 없어요/); // 끝난 실행의 열쇠
  });
  assert.equal(started.length, 1);
  assert.equal(started[0].origin.threadId, "t1");
  assert.equal(started[0].input.prompt, "~/repo 를 정리해 줘");
  assert.match(started[0].toolUseId, /^cli-/);
});

test("agent_start: 답 형식(스키마)이 있는 채팅에서도 실행이 끝날 때까지 열쇠가 살아 있다", async () => {
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), { requestPermission: () => { throw new Error("카드 없음"); } } as any);
  const started: any[] = [];
  broker.onBackgroundAgent = (r) => { started.push(r); return "[백그라운드 에이전트] 시작했어요"; };
  let during = "";
  const execFile: ExecFileLike = async (_f, args, o) => {
    const url = JSON.parse(args.find((a) => a.startsWith("mcp_servers.usagi.url="))!.split("=").slice(1).join("="));
    const key = /agent_start 도구\(key: ([0-9a-f]+)\)/.exec(String(o?.input))![1];
    during = await callTool(url, { key, description: "리팩터", prompt: "~/repo 정리" });
    return { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ reply: "시작했어요" }) } }) };
  };
  await withDaemon(() => ask(cfg, "뒤에서 따로 해 줘", { type: "object", required: ["reply"], properties: { reply: { type: "string" } } }, undefined, {
    interactive: { origin: { via: "chat", threadId: "t2" }, broker }, deps: { execFile, commandExists: () => true },
  }));
  assert.match(during, /시작했어요/);
  assert.equal(started.length, 1);
});

test("agent_start: 대화 없는 실행(브리핑 등)에는 열쇠가 안 붙는다", async () => {
  let input = "";
  const execFile: ExecFileLike = async (_f, _a, o) => { input = String(o?.input); return reply("."); };
  await withDaemon(() => ask(cfg, "p", null, undefined, { deps: { execFile, commandExists: () => true } }));
  assert.doesNotMatch(input, /agent_start/);
});
