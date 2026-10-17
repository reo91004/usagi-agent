import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveConnectors } from "./connectors.ts";
import { CODEX_TOOL_TIMEOUT_S, agyMcpEntries, cliMcpServers, codexMcpArgs } from "./cli-mcp.ts";
import { AGY_ALLOW, agyPaths, ensureAgyMcp, mcpHandler, mcpUrl } from "./mcp-http.ts";
import { CODEX_TIMEOUT_MS, agyExec, codexExec, setAgyMcpHome, setCliMcpUrl, type ExecFileLike } from "./providers.ts";
import { PERMISSION_TTL_MS, PermissionBroker, PermissionRules } from "./permissions.ts";
import { Actions, type PendingAction } from "./actions.ts";
import { RunRegistry } from "./runs.ts";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { ask } from "./brain.ts";
import { loadConfig } from "./config.ts";

const SECRET = "sk-test-0123456789abcdef";
// ~/.claude.json 의 mcpServers 모양(claude mcp add 가 쓰는 것)
const CLAUDE_JSON = {
  mcpServers: {
    gmail: { type: "stdio", command: "npx", args: ["-y", "gmail-mcp"], env: { GMAIL_TOKEN: SECRET } },
    gh2: { type: "http", url: "https://gh.example/mcp/", headers: { Authorization: `Bearer ${SECRET}` } },
    ms365: { command: "ms365-mcp", args: [] }, // type 이 없으면 stdio
    cal: { type: "stdio", command: "cal-mcp" },
    slk: { type: "sse", url: "https://slack.example/sse" },
    usagi: { type: "stdio", command: "x" }, // 우사기 맥락 도구 이름과 겹침
    odd: ["not", "an", "object"],
  },
};
const conns = () => resolveConnectors({}, {
  connectors: {
    mail: { mode: "mcp", preset: "gmail" },
    issues: { mode: "mcp", server: "gh2", tools: { search: "search_issues", list: "create_issue", read: "issue_read" } }, // list 에 쓰기 도구를 잘못 적음
    calendar: { mode: "mcp", server: "cal" }, // 매핑이 없으면 도구별로 열 수 없다
    slack: { mode: "mcp", server: "slk", tools: { search: "search_messages" } }, // sse 는 못 넘긴다
  },
});

test("cliMcpServers: 커넥터 매핑 중 읽기 도구만, 매핑이 없거나 sse·미등록 서버는 뺀다", () => {
  const s = cliMcpServers(conns(), () => CLAUDE_JSON);
  assert.deepEqual(s.map((x) => [x.name, x.caps, x.tools]), [
    ["gmail", ["메일"], ["search_emails", "read_email"]],
    ["gh2", ["이슈"], ["search_issues", "issue_read"]],
  ]);
  assert.deepEqual(s[0].def, { command: "npx", args: ["-y", "gmail-mcp"], env: { GMAIL_TOKEN: SECRET } });
  assert.deepEqual(s[1].def, { url: "https://gh.example/mcp/", headers: { Authorization: `Bearer ${SECRET}` } });
  // 같은 서버를 두 기능이 쓰면 합친다(ms-365 메일·캘린더)
  const shared = cliMcpServers(resolveConnectors({}, { connectors: { mail: { mode: "mcp", preset: "ms-365" }, calendar: { mode: "mcp", preset: "ms-365" } } }), () => CLAUDE_JSON);
  assert.deepEqual(shared.map((x) => [x.name, x.caps, x.tools]), [["ms365", ["캘린더", "메일"], ["get-calendar-view", "list-mail-messages", "get-mail-message"]]]);
  assert.deepEqual(cliMcpServers(conns(), () => ({})), []);
  for (const server of ["usagi", "odd"]) assert.deepEqual(cliMcpServers(resolveConnectors({}, { connectors: { mail: { mode: "mcp", server, tools: { search: "search_emails" } } } }), () => CLAUDE_JSON), []);
  assert.deepEqual(cliMcpServers(conns(), () => { throw new Error("no file"); }), []);
});

test("#65 codexMcpArgs: 서버마다 데몬 문지기 주소만 넘기고 Codex 쪽 승인은 approve. 명령·비밀값은 Codex 에 안 간다", () => {
  const servers = cliMcpServers(conns(), () => CLAUDE_JSON);
  const gate = "http://127.0.0.1:1/mcp/tok/key";
  const args = codexMcpArgs(servers, gate);
  const t = `tool_timeout_sec=${CODEX_TOOL_TIMEOUT_S}`;
  assert.deepEqual(args, [
    "-c", `mcp_servers.gmail.url="${gate}/gmail"`, "-c", `mcp_servers.gmail.${t}`, "-c", 'mcp_servers.gmail.default_tools_approval_mode="approve"',
    "-c", `mcp_servers.gh2.url="${gate}/gh2"`, "-c", `mcp_servers.gh2.${t}`, "-c", 'mcp_servers.gh2.default_tools_approval_mode="approve"',
  ]);
  assert.ok(CODEX_TOOL_TIMEOUT_S * 1000 > PERMISSION_TTL_MS); // 카드 10분을 다 기다린다(codex 기본 300초로는 못 기다린다)
  assert.ok(!args.join(" ").includes(SECRET) && !args.join(" ").includes("npx"));
  assert.deepEqual(codexMcpArgs([], gate), []);
});

test("ensureAgyMcp: 사용자 MCP 는 usagi-<이름> + 읽기 도구 하나하나의 허용 규칙. 빠진 것은 지우고 사용자 것은 그대로, 비밀값이 있으면 600", () => {
  const home = mkdtempSync(join(tmpdir(), "agy-home-"));
  const p = agyPaths(home);
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(p.mcp, JSON.stringify({ mcpServers: { gmail: { command: "mine" } } }), { mode: 0o644 });
  writeFileSync(p.settings, JSON.stringify({ permissions: { allow: ["command(git)", "mcp(gmail/send_email)"] } }), { mode: 0o600 });
  const servers = cliMcpServers(conns(), () => CLAUDE_JSON);
  const url = "http://127.0.0.1:1/mcp/x";
  assert.deepEqual(ensureAgyMcp(url, home, servers), [p.mcp, p.settings]);
  const m = JSON.parse(readFileSync(p.mcp, "utf8")).mcpServers;
  assert.deepEqual(m, {
    gmail: { command: "mine" }, // 사용자가 agy 에 직접 넣은 같은 이름 서버는 건드리지 않는다
    usagi: { url },
    "usagi-gmail": { command: "npx", args: ["-y", "gmail-mcp"], env: { GMAIL_TOKEN: SECRET }, enabledTools: ["search_emails", "read_email"] },
    "usagi-gh2": { serverUrl: "https://gh.example/mcp/", headers: { Authorization: `Bearer ${SECRET}` }, enabledTools: ["search_issues", "issue_read"] },
  });
  assert.equal(statSync(p.mcp).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(p.settings, "utf8")).permissions.allow, [
    "command(git)", "mcp(gmail/send_email)", AGY_ALLOW,
    "mcp(usagi-gmail/search_emails)", "mcp(usagi-gmail/read_email)", "mcp(usagi-gh2/search_issues)", "mcp(usagi-gh2/issue_read)",
  ]);
  assert.deepEqual(ensureAgyMcp(url, home, servers), []);
  // 커넥터에서 이슈가 빠지면 그 서버와 규칙을 지운다. 키 순서가 바뀌어도(agy 가 다시 써도) 같은 것으로 본다
  const sorted = JSON.parse(readFileSync(p.mcp, "utf8"));
  sorted.mcpServers["usagi-gmail"] = { enabledTools: ["search_emails", "read_email"], env: { GMAIL_TOKEN: SECRET }, command: "npx", args: ["-y", "gmail-mcp"] };
  writeFileSync(p.mcp, JSON.stringify(sorted));
  assert.deepEqual(ensureAgyMcp(url, home, servers), []);
  assert.deepEqual(ensureAgyMcp(url, home, servers.slice(0, 1)), [p.mcp, p.settings]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(p.mcp, "utf8")).mcpServers), ["gmail", "usagi", "usagi-gmail"]);
  assert.ok(!readFileSync(p.settings, "utf8").includes("usagi-gh2"));
  assert.ok(readFileSync(p.settings, "utf8").includes("mcp(gmail/send_email)"));
  assert.deepEqual(ensureAgyMcp(url, home), [p.mcp, p.settings]); // 연결이 없으면 우사기 것만
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(p.mcp, "utf8")).mcpServers), ["gmail", "usagi"]);
  assert.deepEqual(agyMcpEntries([]), { servers: {}, allow: [], secret: false });
});

test("codex·agy 채팅: 사용자 MCP 를 함께 붙이고 안내엔 서버·도구 이름만(비밀값 없음). Codex 는 문지기(gate)가 있을 때만, 비밀값은 codex 에 안 간다", async () => {
  const seen: { file: string; args: readonly string[]; input?: string; env?: NodeJS.ProcessEnv; timeout?: number }[] = [];
  const execFile: ExecFileLike = async (file, args, opts) => { seen.push({ file, args, input: opts?.input, env: opts?.env, timeout: opts?.timeout }); return { stdout: file === "agy" ? JSON.stringify({ structured_output: { reply: "ok" } }) : `{"type":"item.completed","item":{"type":"agent_message","text":"{\\"reply\\":\\"ok\\"}"}}\n`, stderr: "" }; };
  const has = () => true;
  const servers = cliMcpServers(conns(), () => CLAUDE_JSON);
  const base = "http://127.0.0.1:47823/mcp/" + "c".repeat(64);
  setCliMcpUrl(base);
  const home = mkdtempSync(join(tmpdir(), "agy-home-"));
  setAgyMcpHome(home);
  const gate = async () => ({ deny: "no" });
  try {
    await codexExec("p", { type: "object" }, { execFile, commandExists: has, mcp: true, servers, gate });
    const c = seen[0];
    const url = c.args.find((a) => a.startsWith("mcp_servers.gmail.url="));
    assert.match(url!, new RegExp(`^mcp_servers\\.gmail\\.url="${base}/[0-9a-f]{64}/gmail"$`));
    assert.equal(c.args.at(-1), "-");
    assert.equal(c.env, undefined); // 비밀값을 codex 환경에 넣지 않는다(데몬이 서버에 붙는다)
    assert.equal(c.timeout, CODEX_TIMEOUT_MS + PERMISSION_TTL_MS); // 승인 카드를 기다릴 만큼
    assert.match(c.input!, /메일 gmail\(search_emails, read_email\) · 이슈 gh2\(search_issues, issue_read\)/);
    assert.match(c.input!, /승인 카드가 뜨고, 사용자가 허용해야 실행된다/);
    assert.ok(!c.input!.includes(SECRET) && !c.args.join(" ").includes(SECRET));
    // 문지기가 없으면(승인 브로커 없음) 사용자 MCP 를 안 붙인다 · 채팅이 아니면(mcp 없음) 아무것도
    await codexExec("p", { type: "object" }, { execFile, commandExists: has, mcp: true, servers });
    assert.ok(!seen[1].args.some((a) => a.startsWith("mcp_servers.gmail")) && seen[1].timeout === CODEX_TIMEOUT_MS);
    await codexExec("p", { type: "object" }, { execFile, commandExists: has, servers, gate });
    assert.ok(!seen[2].args.includes("-c") && seen[2].env === undefined);
    await agyExec("p", { type: "object" }, { execFile, commandExists: has, mcp: true, servers });
    assert.match(String(seen[3].args[1]), /메일 usagi-gmail\(search_emails, read_email\)/);
    assert.match(String(seen[3].args[1]), /쓰기는 이 연결로 못 하니/); // agy 는 읽기만(승인 카드 없음)
    assert.ok(!String(seen[3].args[1]).includes(SECRET));
    assert.ok(JSON.parse(readFileSync(agyPaths(home).mcp, "utf8")).mcpServers["usagi-gh2"]);
  } finally {
    setCliMcpUrl(undefined);
    setAgyMcpHome(undefined);
  }
});

test("ask(채팅, 뇌 codex): 설정의 커넥터와 ~/.claude.json 으로 사용자 MCP 를 문지기로 붙인다. 채팅이 아닌 ask·브로커 없는 채팅은 안 붙인다", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "claude-home-"));
  writeFileSync(join(fakeHome, ".claude.json"), JSON.stringify(CLAUDE_JSON));
  const before = process.env.HOME;
  process.env.HOME = fakeHome; // readClaudeJson 기본 경로(homedir())
  const seen: { args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
  const execFile: ExecFileLike = async (_f, args, opts) => { seen.push({ args, env: opts?.env }); return { stdout: `{"type":"item.completed","item":{"type":"agent_message","text":"{\\"reply\\":\\"ok\\"}"}}\n` }; };
  setCliMcpUrl("http://127.0.0.1:47823/mcp/" + "d".repeat(64));
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), { requestPermission() { throw new Error("카드 없음"); } });
  try {
    const cfg = loadConfig({}, { brain: { provider: "codex" }, connectors: { mail: { mode: "mcp", preset: "gmail" } } } as any);
    const deps = { execFile, commandExists: () => true };
    assert.equal(await ask<string>(cfg, "메일 확인", null, undefined, { interactive: { origin: { via: "chat" }, broker }, deps }), "ok");
    assert.ok(seen[0].args.some((a) => /^mcp_servers\.gmail\.url=".*\/gmail"$/.test(a)));
    assert.equal(seen[0].env, undefined);
    await ask<string>(cfg, "정리", null, undefined, { deps });
    assert.ok(!seen[1].args.includes("-c"));
    await ask<string>(cfg, "메일 확인", null, undefined, { interactive: { origin: { via: "chat" } }, deps }); // 데몬이 브로커를 안 붙였다(cli·시험)
    assert.ok(!seen[2].args.some((a) => a.startsWith("mcp_servers.gmail")));
  } finally {
    process.env.HOME = before;
    setCliMcpUrl(undefined);
  }
});

test("#65 Codex 채팅의 쓰기 도구: 읽기는 카드 없이, 쓰기는 승인 카드 → 허용한 것만 진짜 서버에 한 번. 거부·대화 멈춤은 안 넘긴다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const log = join(dir, "fake.log");
  writeFileSync(log, "");
  const fakeHome = join(dir, "home");
  mkdirSync(fakeHome);
  const fixture = join(import.meta.dirname, "fixtures", "fake-mail-mcp.mjs");
  writeFileSync(join(fakeHome, ".claude.json"), JSON.stringify({ mcpServers: { gmail: { command: process.execPath, args: [fixture], env: { FAKE_LOG: log, FAKE_SECRET: SECRET } } } }));
  const before = process.env.HOME;
  process.env.HOME = fakeHome;
  const store = new Store(":memory:");
  const cfg = loadConfig({}, { brain: { provider: "codex" }, connectors: { mail: { mode: "mcp", preset: "gmail" } } } as any);
  const actions = new Actions(cfg, store, { runs: new RunRegistry(new DatabaseSync(":memory:")), execute: async () => ({ called: false }) });
  const cards: PendingAction[] = [];
  actions.onChange = (a) => { if (a.status === "pending") cards.push(a); };
  const broker = new PermissionBroker(new PermissionRules(store), actions);
  const card = async (n: number) => { for (let k = 0; k < 500 && cards.length < n; k++) await new Promise((r) => setTimeout(r, 5)); assert.equal(cards.length, n); return cards[n - 1]; };
  const bus = new Bus();
  const token = "f".repeat(64);
  await bus.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", mcp: mcpHandler(token, () => []) });
  setCliMcpUrl(mcpUrl((bus.server!.address() as any).port, token));
  const abort = new AbortController();
  let url = "";
  const got: any = {};
  // 가짜 codex: 받은 -c 주소로 진짜 MCP 클라이언트를 붙여 도구를 부른다(codex 가 하는 일)
  const execFile: ExecFileLike = async (_f, args) => {
    url = args.find((a) => a.startsWith("mcp_servers.gmail.url="))!.match(/"(.*)"/)![1];
    const client = new Client({ name: "fake-codex", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    got.tools = (await client.listTools()).tools.map((t) => t.name);
    got.read = await client.callTool({ name: "search_emails", arguments: { query: "PROBE" } });
    const send = (body: string) => client.callTool({ name: "send_email", arguments: { to: "probe@example.invalid", body } });
    const s1 = send("one");
    got.card = await card(1);
    assert.ok((await actions.confirm(got.card.id)).ok);
    got.s1 = await s1;
    const s2 = send("two");
    actions.cancel((await card(2)).id);
    got.s2 = await s2;
    const s3 = send("three");
    await card(3);
    abort.abort(); // 채팅 멈춤 → 기다리던 카드 취소
    got.s3 = await s3;
    await client.close();
    return { stdout: `{"type":"item.completed","item":{"type":"agent_message","text":"{\\"reply\\":\\"ok\\"}"}}\n` };
  };
  try {
    const out = await ask<string>(cfg, "메일 보내", null, undefined, { interactive: { origin: { via: "chat", threadId: "t1" }, broker }, abort, deps: { execFile, commandExists: () => true } });
    assert.equal(out, "ok");
    assert.deepEqual(got.tools, ["search_emails", "send_email"]);
    assert.equal(got.read.isError, undefined);
    assert.deepEqual([got.card.toolName, got.card.via, got.card.threadId, !!got.card.runId], ["mcp__gmail__send_email", "chat", "t1", true]);
    assert.deepEqual(got.card.card.fields[0], { label: "받는 사람", value: "probe@example.invalid" });
    assert.deepEqual(got.s1.content, [{ type: "text", text: "sent" }]);
    assert.equal(got.s2.isError, true);
    assert.match(got.s2.content[0].text, /거부했어요/);
    assert.equal(got.s3.isError, true);
    assert.equal(cards.length, 3); // 읽기는 카드 없음
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ").slice(1).join(" ")), [
      'search_emails {"query":"PROBE"} secret=set',
      'send_email {"to":"probe@example.invalid","body":"one"} secret=set',
    ]);
    // 실행이 끝나면 그 열쇠는 없다
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(r.status, 404);
  } finally {
    process.env.HOME = before;
    setCliMcpUrl(undefined);
    bus.close();
  }
});

test("#56 removeAgyUsagi: 우사기가 넣은 서버·규칙만 지우고 사용자 것은 그대로, 헤더 없는 http(OAuth) 서버는 Codex·agy 에 안 붙임", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeAgyUsagi } = await import("./mcp-http.ts");
  const { cliMcpServers } = await import("./cli-mcp.ts");
  const home = mkdtempSync(join(tmpdir(), "agy-clean-"));
  const p = agyPaths(home);
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(p.mcp, JSON.stringify({ mcpServers: { usagi: { url: "http://127.0.0.1:1/mcp/x" }, "usagi-gmail": { command: "x", env: { TOKEN: "secret" } }, mine: { command: "y" } } }));
  writeFileSync(p.settings, JSON.stringify({ trustedWorkspaces: ["/u"], permissions: { allow: [AGY_ALLOW, "mcp(usagi-gmail/search)", "write_file(/w/worktrees)", "read_file(/u/.gitconfig)", "command(git)"] } }));
  assert.deepEqual(removeAgyUsagi(home, "/w/worktrees"), [p.mcp, p.settings]);
  assert.deepEqual(JSON.parse(readFileSync(p.mcp, "utf8")).mcpServers, { mine: { command: "y" } });
  assert.deepEqual(JSON.parse(readFileSync(p.settings, "utf8")), { trustedWorkspaces: ["/u"], permissions: { allow: ["read_file(/u/.gitconfig)", "command(git)"] } });
  assert.deepEqual(removeAgyUsagi(home, "/w/worktrees"), []);
  assert.deepEqual(removeAgyUsagi(mkdtempSync(join(tmpdir(), "agy-none-"))), []); // agy 를 안 쓰는 맥
  const conns = { slack: { cap: "slack", mode: "off" }, calendar: { cap: "calendar", mode: "off" }, mail: { cap: "mail", mode: "mcp", server: "oauthonly", tools: { search: "search_threads" } }, issues: { cap: "issues", mode: "off" } } as any;
  assert.deepEqual(cliMcpServers(conns, () => ({ mcpServers: { oauthonly: { type: "http", url: "https://mail.example/mcp" } } })), []);
});
