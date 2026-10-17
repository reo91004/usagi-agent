import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { Bus } from "./bus.ts";
import { AGY_ALLOW, agyPaths, ensureAgyMcp, mcpHandler, mcpToken, mcpUrl, openGate, type GateConnect, type GateDecide } from "./mcp-http.ts";
import { agyExec, codexExec, setAgyMcpHome, setCliMcpUrl, type ExecFileLike } from "./providers.ts";

test("mcpToken: 64자리 hex 를 권한 600 으로 한 번 만들고 다시 쓴다", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tok-"));
  const t = mcpToken(dir);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(statSync(join(dir, "mcp-token")).mode & 0o777, 0o600);
  assert.equal(mcpToken(dir), t);
  writeFileSync(join(dir, "mcp-token"), "short");
  assert.notEqual(mcpToken(dir), "short"); // 이상한 값이면 새로
});

test("HTTP MCP: 토큰이 맞으면 진짜 MCP 클라이언트가 도구 목록을 받고 부른다. 틀린 토큰·GET·다른 Host 는 거절", async () => {
  const bus = new Bus();
  const token = "a".repeat(64);
  let calls = 0;
  const tools = () => [tool("echo_twice", "두 번 말하기", { text: z.string() }, async (a) => { calls++; return { content: [{ type: "text" as const, text: `${a.text} ${a.text}` }] }; }, { annotations: { readOnlyHint: true } })];
  await bus.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", mcp: mcpHandler(token, tools) });
  const port = (bus.server!.address() as any).port as number;
  try {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(port, token))));
    const list = await client.listTools();
    assert.deepEqual(list.tools.map((t) => [t.name, t.annotations?.readOnlyHint]), [["echo_twice", true]]);
    const r = await client.callTool({ name: "echo_twice", arguments: { text: "야하" } });
    assert.deepEqual(r.content, [{ type: "text", text: "야하 야하" }]);
    assert.equal(calls, 1);
    await client.close();

    const post = (path: string, host = `127.0.0.1:${port}`, method = "POST") => new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers: { host, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      req.end(method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) : undefined);
    });
    assert.equal(await post(`/mcp/${"b".repeat(64)}`), 403);
    assert.equal(await post("/mcp/"), 403);
    assert.equal(await post(`/mcp/${token}`, "evil.example:80"), 403); // DNS 리바인딩
    assert.equal(await post(`/mcp/${token}`, undefined, "GET"), 405);
  } finally {
    bus.close();
  }
});

test("ensureAgyMcp: 두 파일에 우사기 서버·허용 규칙을 넣고 다른 설정은 그대로, 두 번째는 바뀐 것 없음", () => {
  const home = mkdtempSync(join(tmpdir(), "agy-home-"));
  const p = agyPaths(home);
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(p.mcp, ""); // agy 가 처음 만든 빈 파일
  writeFileSync(p.settings, JSON.stringify({ trustedWorkspaces: ["/Users/me"], permissions: { allow: ["command(git)"], deny: ["command(rm -rf)"] } }), { mode: 0o600 });
  assert.deepEqual(ensureAgyMcp("http://127.0.0.1:1/mcp/x", home), [p.mcp, p.settings]);
  assert.deepEqual(JSON.parse(readFileSync(p.mcp, "utf8")), { mcpServers: { usagi: { url: "http://127.0.0.1:1/mcp/x" } } });
  assert.deepEqual(JSON.parse(readFileSync(p.settings, "utf8")), { trustedWorkspaces: ["/Users/me"], permissions: { allow: ["command(git)", AGY_ALLOW], deny: ["command(rm -rf)"] } });
  assert.equal(statSync(p.settings).mode & 0o777, 0o600); // 원래 권한 유지
  assert.deepEqual(ensureAgyMcp("http://127.0.0.1:1/mcp/x", home), []);
  // 주소가 바뀌면 그 서버만 고치고, 사용자가 둔 다른 서버는 남긴다
  writeFileSync(p.mcp, JSON.stringify({ mcpServers: { mine: { command: "x" }, usagi: { url: "old" } } }));
  assert.deepEqual(ensureAgyMcp("http://127.0.0.1:2/mcp/y", home), [p.mcp]);
  assert.deepEqual(JSON.parse(readFileSync(p.mcp, "utf8")).mcpServers, { mine: { command: "x" }, usagi: { url: "http://127.0.0.1:2/mcp/y" } });
  // 깨진 사용자 파일은 덮지 않는다
  writeFileSync(p.settings, "{ // 주석\n}");
  assert.throws(() => ensureAgyMcp("http://127.0.0.1:3/mcp/z", home), /그대로 둬요/);
  assert.equal(readFileSync(p.settings, "utf8"), "{ // 주석\n}");
  // 없는 홈이면 만든다
  const fresh = mkdtempSync(join(tmpdir(), "agy-home-"));
  assert.equal(ensureAgyMcp("u", fresh).length, 2);
});

test("codex·agy: mcp 실행(채팅)만 우사기 도구를 붙이고 안내를 넣는다. 아니면 지금처럼 도구 없이", async () => {
  const seen: { file: string; args: readonly string[]; input?: string }[] = [];
  const execFile: ExecFileLike = async (file, args, opts) => { seen.push({ file, args, input: opts?.input }); return { stdout: file === "agy" ? JSON.stringify({ structured_output: { reply: "ok" } }) : `{"type":"item.completed","item":{"type":"agent_message","text":"{\\"reply\\":\\"ok\\"}"}}\n`, stderr: "" }; };
  const has = () => true;
  const url = "http://127.0.0.1:47823/mcp/" + "c".repeat(64);
  setCliMcpUrl(url);
  const home = mkdtempSync(join(tmpdir(), "agy-home-"));
  setAgyMcpHome(home);
  try {
    await codexExec("p", { type: "object" }, { execFile, commandExists: has, mcp: true });
    assert.deepEqual(seen[0].args.slice(-3), ["-c", `mcp_servers.usagi.url="${url}"`, "-"]);
    assert.ok(seen[0].args.includes("--ignore-user-config"));
    assert.match(seen[0].input!, /usagi MCP 도구/);
    await codexExec("p", { type: "object" }, { execFile, commandExists: has });
    assert.ok(!seen[1].args.includes("-c"));
    assert.match(seen[1].input!, /도구를 부르지 말고/);
    await agyExec("p", { type: "object" }, { execFile, commandExists: has, mcp: true });
    assert.match(String(seen[2].args[1]), /usagi MCP 도구/);
    assert.equal(JSON.parse(readFileSync(agyPaths(home).mcp, "utf8")).mcpServers.usagi.url, url);
    setCliMcpUrl(undefined); // 버스가 아직 없으면 mcp 를 원해도 도구 없이
    await codexExec("p", { type: "object" }, { execFile, commandExists: has, mcp: true });
    assert.ok(!seen[3].args.includes("-c"));
  } finally {
    setCliMcpUrl(undefined);
    setAgyMcpHome(undefined);
  }
});

test("#65 문지기: 열쇠·서버가 맞아야 붙고, 닫히거나 끊기면 허용이 나와도 진짜 서버에 넘기지 않는다", async () => {
  const bus = new Bus();
  const token = "9".repeat(64);
  await bus.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", mcp: mcpHandler(token, () => []) });
  const port = (bus.server!.address() as any).port as number;
  const calls: unknown[] = [];
  let closed = 0;
  const connect = (async () => ({
    listTools: async () => ({ tools: [{ name: "send_email", inputSchema: { type: "object" } }] }),
    callTool: async (p: unknown) => { calls.push(p); return { content: [{ type: "text", text: "sent" }] }; },
    close: async () => { closed++; },
  })) as unknown as GateConnect;
  // 결정: 멈춤 신호가 오면 그때 "허용"을 돌려준다(허용이 늦게 나와도 넘기지 않는지)
  let seen: AbortSignal | undefined;
  const decide: GateDecide = (_t, _a, signal) => { seen = signal; return new Promise((r) => signal.addEventListener("abort", () => r({ allow: true }), { once: true })); };
  const gate = openGate([{ name: "gmail", caps: ["메일"], tools: ["search_emails"], def: { command: "x", args: [], env: {} } }], decide, connect);
  const base = mcpUrl(port, token);
  const status = (url: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then((r) => r.status);
  try {
    assert.equal(await status(`${base}/${"0".repeat(64)}/gmail`), 404); // 모르는 열쇠
    assert.equal(await status(`${base}/${gate.key}/other`), 404); // 이 실행에 없는 서버
    assert.equal(await status(`${base}/${gate.key}`), 404);
    assert.equal(await status(`http://127.0.0.1:${port}/mcp/${"8".repeat(64)}/${gate.key}/gmail`), 403); // 토큰이 틀리면
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/${gate.key}/gmail`)));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["send_email"]);
    const p = client.callTool({ name: "send_email", arguments: { to: "a@b" } });
    for (let k = 0; k < 200 && !seen; k++) await new Promise((r) => setTimeout(r, 5));
    gate.close(); // 실행이 끝남 → 기다리던 결정에 멈춤 신호
    const r = await p;
    assert.equal(r.isError, true);
    assert.equal(calls.length, 0);
    assert.equal(seen?.aborted, true);
    assert.equal(closed, 1); // 띄운 서버도 닫는다
    assert.equal(await status(`${base}/${gate.key}/gmail`), 404);
    await client.close();
  } finally {
    gate.close();
    bus.close();
  }
});
