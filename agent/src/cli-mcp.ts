// 사용자가 Claude Code 에 등록한 MCP 연결(connectors mode "mcp" — 메일·이슈·캘린더·Slack)을 Codex·agy 채팅에도 붙인다(#15 3단계).
//   서버 정의(command/args/env 또는 url/headers)는 ~/.claude.json 에서, 열 도구는 커넥터 매핑 중 읽기 도구(guard.ts isReadOnlyCall)만.
//   Codex: 실행마다 -c mcp_servers.<이름>.… — enabled_tools 로 그 도구만 보이고, 그 도구만 approval_mode "approve"(나머지는 exec 가 거절)
//   agy:   전역 mcp_config.json 의 "usagi-<이름>"(enabledTools) + settings.json permissions.allow "mcp(usagi-<이름>/<도구>)"(mcp-http.ts ensureAgyMcp)
//          headless agy 는 허용 규칙이 없는 MCP 호출을 자동 거절한다(2026-10-17 agy 1.4.0 확인)
// 도구별로 열 수 없는 서버(매핑이 비었거나 sse·headersHelper)는 붙이지 않는다. 비밀값(env·헤더 값)은 argv·로그·프롬프트에 넣지 않는다.
import { CAP_LABELS, CAPABILITIES, CONNECTORS, mcpTool, type Connectors } from "./connectors.ts";
import { isReadOnlyCall } from "./guard.ts";
import { readClaudeJson } from "./mcp.ts";

export type CliMcpDef = { command: string; args: string[]; env: Record<string, string> } | { url: string; headers: Record<string, string> };
export type CliMcpServer = { name: string; caps: string[]; tools: string[]; def: CliMcpDef };

const SAFE = /^[A-Za-z0-9_-]+$/; // -c 키 경로·agy 규칙에 그대로 들어간다
const RESERVED = "usagi"; // 우사기 맥락 도구 서버 이름(mcp-http.ts MCP_NAME)과 겹치면 붙이지 않는다
const strMap = (v: unknown): Record<string, string> | null => {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) { if (typeof x !== "string") return null; out[k] = x; }
  return out;
};

function defOf(s: any): CliMcpDef | undefined {
  if (!s || typeof s !== "object" || s.headersHelper) return undefined;
  const type = s.type ?? "stdio";
  if (type === "stdio" && typeof s.command === "string" && s.command) {
    const args = s.args ?? [];
    const env = strMap(s.env);
    return Array.isArray(args) && args.every((a: unknown) => typeof a === "string") && env ? { command: s.command, args, env } : undefined;
  }
  if (type === "http" && typeof s.url === "string" && /^https?:\/\//.test(s.url)) {
    // 헤더가 없으면 Claude Code 안의 OAuth 로그인으로 쓰는 서버다 — Codex·agy 는 그 로그인을 못 써서 붙여도 못 읽는다(#56)
    const headers = strMap(s.headers);
    return headers && Object.keys(headers).length ? { url: s.url, headers } : undefined;
  }
  return undefined;
}

// 커넥터가 mcp 로 쓰는 서버 중 Codex·agy 에 넘길 수 있는 것(같은 서버를 여러 기능이 쓰면 합친다). 읽기 도구가 하나도 없으면 뺀다
export function cliMcpServers(conns: Connectors = CONNECTORS, claudeJson: () => any = () => readClaudeJson()): CliMcpServer[] {
  let reg: Record<string, unknown>;
  try { reg = claudeJson()?.mcpServers ?? {}; } catch { return []; }
  const by = new Map<string, CliMcpServer>();
  for (const cap of CAPABILITIES) {
    const c = conns[cap];
    if (c.mode !== "mcp" || !SAFE.test(c.server) || c.server === RESERVED) continue;
    const def = defOf(reg[c.server]);
    if (!def) continue;
    const s = by.get(c.server) ?? { name: c.server, caps: [], tools: [], def };
    s.caps.push(CAP_LABELS[cap]);
    for (const t of Object.values(c.tools)) if (SAFE.test(t) && !s.tools.includes(t) && isReadOnlyCall(mcpTool(c.server, t), {}, conns).allow) s.tools.push(t);
    by.set(c.server, s);
  }
  return [...by.values()].filter((s) => s.tools.length);
}

// ── Codex ──────────────────────────────────────────────
const toml = (s: string) => JSON.stringify(s); // JSON 문자열은 TOML 기본 문자열로도 읽힌다
const tomlArr = (a: string[]) => `[${a.map(toml).join(",")}]`;

// -c 인자와 codex 프로세스에 더할 환경변수. 비밀값은 env 로만: stdio 는 env_vars(이름만 넘기면 codex 가 값을 서버에 전달),
// http 헤더는 env_http_headers(헤더 → 환경변수 이름). 셸 도구에는 그 값이 안 가게 inherit "core".
// used: 실제로 붙인 서버. 같은 이름 환경변수를 다른 값으로 쓰는 서버는 뺀다 — 앞 서버와 섞이면 다른 계정으로 읽고,
// codex 자신의 환경(base: PATH·HOME·CODEX_HOME 등)을 덮으면 채팅째 깨진다
export function codexMcpArgs(servers: CliMcpServer[], base: NodeJS.ProcessEnv = process.env): { args: string[]; env: Record<string, string>; used: CliMcpServer[] } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  const used: CliMcpServer[] = [];
  for (const s of servers) {
    const k = `mcp_servers.${s.name}`;
    const set: string[] = [];
    if ("command" in s.def) {
      const e = s.def.env;
      if (Object.entries(e).some(([n, v]) => (n in env && env[n] !== v) || (base[n] !== undefined && base[n] !== v))) continue;
      set.push(`${k}.command=${toml(s.def.command)}`, `${k}.args=${tomlArr(s.def.args)}`);
      if (Object.keys(e).length) set.push(`${k}.env_vars=${tomlArr(Object.keys(e))}`);
      Object.assign(env, e);
    } else {
      set.push(`${k}.url=${toml(s.def.url)}`);
      const hs = Object.entries(s.def.headers).map(([h, v]) => {
        const n = `USAGI_MCP_H${Object.keys(env).length}`;
        env[n] = v;
        return `${toml(h)}=${toml(n)}`;
      });
      if (hs.length) set.push(`${k}.env_http_headers={${hs.join(",")}}`);
    }
    set.push(`${k}.enabled_tools=${tomlArr(s.tools)}`, `${k}.default_tools_approval_mode="prompt"`, ...s.tools.map((t) => `${k}.tools.${t}.approval_mode="approve"`));
    for (const x of set) args.push("-c", x);
    used.push(s);
  }
  if (Object.keys(env).length) args.push("-c", `shell_environment_policy.inherit="core"`);
  return { args, env, used };
}

// ── agy ────────────────────────────────────────────────
// 우리가 쓰는 이름은 이 접두사로만(사용자가 agy 에 직접 넣은 같은 이름 서버를 덮지 않고, 커넥터에서 빠진 것은 지운다)
export const AGY_PREFIX = "usagi-";
export function agyMcpEntries(servers: CliMcpServer[]): { servers: Record<string, Record<string, unknown>>; allow: string[]; secret: boolean } {
  const out: Record<string, Record<string, unknown>> = {};
  const allow: string[] = [];
  let secret = false;
  for (const s of servers) {
    const name = AGY_PREFIX + s.name;
    const d = s.def;
    const extra = "command" in d ? d.env : d.headers;
    if (Object.keys(extra).length) secret = true;
    out[name] = "command" in d
      ? { command: d.command, args: d.args, ...(Object.keys(d.env).length ? { env: d.env } : {}), enabledTools: s.tools }
      : { serverUrl: d.url, ...(Object.keys(d.headers).length ? { headers: d.headers } : {}), enabledTools: s.tools };
    for (const t of s.tools) allow.push(`mcp(${name}/${t})`);
  }
  return { servers: out, allow, secret };
}

// 채팅 프롬프트 안내(서버·도구 이름만 — 정의·비밀값은 넣지 않는다). prefix: agy 는 "usagi-"
export function connectorGuide(servers: CliMcpServer[], prefix = ""): string {
  if (!servers.length) return "";
  const list = servers.map((s) => `${s.caps.join("·")} ${prefix}${s.name}(${s.tools.join(", ")})`).join(" · ");
  return `- 연결된 업무 도구(MCP, 읽기만): ${list}. 메일·이슈·일정·Slack 을 물으면 이걸로 찾는다. 보내기·게시·일정 바꾸기 같은 쓰기는 이 연결로 못 하니 사용자에게 직접 하라고 말한다.\n`;
}
