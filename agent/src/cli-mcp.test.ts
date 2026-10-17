import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConnectors } from "./connectors.ts";
import { agyMcpEntries, cliMcpServers, codexMcpArgs, connectorGuide, type CliMcpServer } from "./cli-mcp.ts";
import { AGY_ALLOW, agyPaths, ensureAgyMcp } from "./mcp-http.ts";
import { agyExec, codexExec, setAgyMcpHome, setCliMcpUrl, type ExecFileLike } from "./providers.ts";
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

test("codexMcpArgs: 읽기 도구만 보이고 그 도구만 승인. 비밀값은 argv 가 아니라 환경변수로", () => {
  const servers = cliMcpServers(conns(), () => CLAUDE_JSON);
  const { args, env, used } = codexMcpArgs(servers, {});
  const cs = args.filter((_, i) => args[i - 1] === "-c");
  assert.equal(args.length, cs.length * 2);
  assert.ok(cs.includes('mcp_servers.gmail.command="npx"'));
  assert.ok(cs.includes('mcp_servers.gmail.args=["-y","gmail-mcp"]'));
  assert.ok(cs.includes('mcp_servers.gmail.env_vars=["GMAIL_TOKEN"]'));
  assert.ok(cs.includes('mcp_servers.gmail.enabled_tools=["search_emails","read_email"]'));
  assert.ok(cs.includes('mcp_servers.gmail.default_tools_approval_mode="prompt"'));
  assert.ok(cs.includes('mcp_servers.gmail.tools.search_emails.approval_mode="approve"'));
  assert.ok(cs.includes('mcp_servers.gh2.url="https://gh.example/mcp/"'));
  assert.ok(cs.includes('mcp_servers.gh2.env_http_headers={"Authorization"="USAGI_MCP_H1"}'));
  assert.ok(cs.includes('mcp_servers.gh2.enabled_tools=["search_issues","issue_read"]'));
  assert.ok(!cs.some((c) => c.includes("create_issue")));
  assert.ok(cs.includes('shell_environment_policy.inherit="core"')); // 셸 도구엔 그 값이 안 간다
  assert.ok(!args.join(" ").includes(SECRET));
  assert.deepEqual(env, { GMAIL_TOKEN: SECRET, USAGI_MCP_H1: `Bearer ${SECRET}` });
  assert.deepEqual(used.map((s) => s.name), ["gmail", "gh2"]);
  // 같은 환경변수 이름을 앞 서버나 codex 자신의 환경(PATH·HOME…)과 다른 값으로 쓰는 서버는 뺀다. 같은 값이면 괜찮다
  const clash: CliMcpServer[] = [
    { name: "one", caps: ["메일"], tools: ["a"], def: { command: "x", args: [], env: { TOKEN: "1" } } },
    { name: "two", caps: ["이슈"], tools: ["b"], def: { command: "y", args: [], env: { TOKEN: "2" } } },
    { name: "home", caps: ["캘린더"], tools: ["c"], def: { command: "z", args: [], env: { HOME: "/elsewhere" } } },
    { name: "path", caps: ["Slack"], tools: ["d"], def: { command: "w", args: [], env: { PATH: "/usr/bin" } } },
  ];
  const c2 = codexMcpArgs(clash, { HOME: "/Users/me", PATH: "/usr/bin" });
  assert.deepEqual(c2.used.map((s) => s.name), ["one", "path"]);
  assert.deepEqual(c2.env, { TOKEN: "1", PATH: "/usr/bin" });
  assert.deepEqual(codexMcpArgs([], {}), { args: [], env: {}, used: [] });
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

test("codex·agy 채팅: 사용자 MCP 를 함께 붙이고 안내엔 서버·도구 이름만(비밀값 없음), 비밀값은 codex 환경변수로만", async () => {
  const seen: { file: string; args: readonly string[]; input?: string; env?: NodeJS.ProcessEnv }[] = [];
  const execFile: ExecFileLike = async (file, args, opts) => { seen.push({ file, args, input: opts?.input, env: opts?.env }); return { stdout: file === "agy" ? JSON.stringify({ structured_output: { reply: "ok" } }) : `{"type":"item.completed","item":{"type":"agent_message","text":"{\\"reply\\":\\"ok\\"}"}}\n`, stderr: "" }; };
  const has = () => true;
  const servers = cliMcpServers(conns(), () => CLAUDE_JSON);
  setCliMcpUrl("http://127.0.0.1:47823/mcp/" + "c".repeat(64));
  const home = mkdtempSync(join(tmpdir(), "agy-home-"));
  setAgyMcpHome(home);
  try {
    await codexExec("p", { type: "object" }, { execFile, commandExists: has, mcp: true, servers });
    const c = seen[0];
    assert.ok(c.args.includes('mcp_servers.gmail.enabled_tools=["search_emails","read_email"]'));
    assert.equal(c.args.at(-1), "-");
    assert.equal(c.env?.GMAIL_TOKEN, SECRET);
    assert.equal(c.env?.PATH, process.env.PATH); // 원래 환경 위에 더한다
    assert.match(c.input!, /메일 gmail\(search_emails, read_email\) · 이슈 gh2\(search_issues, issue_read\)/);
    assert.ok(!c.input!.includes(SECRET) && !c.args.join(" ").includes(SECRET));
    // 채팅이 아니면(mcp 없음) 사용자 MCP 도 안 붙인다
    await codexExec("p", { type: "object" }, { execFile, commandExists: has, servers });
    assert.ok(!seen[1].args.includes("-c") && seen[1].env === undefined);
    await agyExec("p", { type: "object" }, { execFile, commandExists: has, mcp: true, servers });
    assert.match(String(seen[2].args[1]), /메일 usagi-gmail\(search_emails, read_email\)/);
    assert.ok(!String(seen[2].args[1]).includes(SECRET));
    assert.ok(JSON.parse(readFileSync(agyPaths(home).mcp, "utf8")).mcpServers["usagi-gh2"]);
  } finally {
    setCliMcpUrl(undefined);
    setAgyMcpHome(undefined);
  }
});

test("ask(채팅, 뇌 codex): 설정의 커넥터와 ~/.claude.json 으로 사용자 MCP 를 붙인다. 채팅이 아닌 ask 는 안 붙인다", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "claude-home-"));
  writeFileSync(join(fakeHome, ".claude.json"), JSON.stringify(CLAUDE_JSON));
  const before = process.env.HOME;
  process.env.HOME = fakeHome; // readClaudeJson 기본 경로(homedir())
  const seen: { args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
  const execFile: ExecFileLike = async (_f, args, opts) => { seen.push({ args, env: opts?.env }); return { stdout: `{"type":"item.completed","item":{"type":"agent_message","text":"{\\"reply\\":\\"ok\\"}"}}\n` }; };
  setCliMcpUrl("http://127.0.0.1:47823/mcp/" + "d".repeat(64));
  try {
    const cfg = loadConfig({}, { brain: { provider: "codex" }, connectors: { mail: { mode: "mcp", preset: "gmail" } } } as any);
    const deps = { execFile, commandExists: () => true };
    assert.equal(await ask<string>(cfg, "메일 확인", null, undefined, { interactive: { origin: { via: "chat" } } as any, deps }), "ok");
    assert.ok(seen[0].args.includes('mcp_servers.gmail.enabled_tools=["search_emails","read_email"]'));
    assert.equal(seen[0].env?.GMAIL_TOKEN, SECRET);
    await ask<string>(cfg, "정리", null, undefined, { deps });
    assert.ok(!seen[1].args.includes("-c"));
  } finally {
    process.env.HOME = before;
    setCliMcpUrl(undefined);
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
