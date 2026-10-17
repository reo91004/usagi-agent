// 사용자가 Claude Code 에 등록한 MCP 연결(connectors mode "mcp" — 메일·이슈·캘린더·Slack)을 Codex·agy 채팅에도 붙인다(#15 3단계).
//   서버 정의(command/args/env 또는 url/headers)는 ~/.claude.json 에서, 읽기 도구는 커넥터 매핑 중 guard.ts isReadOnlyCall 을 통과하는 것.
//   Codex: 서버를 직접 붙이지 않고 데몬의 문지기 주소(mcp-http.ts openGate)를 -c mcp_servers.<이름>.url 로 준다(#65). 데몬이 진짜 서버에 붙어
//          서버의 도구를 다 보여 주고, 부르기는 승인 브로커(permissions.ts)를 거친다 — 읽기는 바로, 쓰기는 Claude Code 뇌와 같은 승인 카드.
//          그래서 Codex 쪽 승인은 "approve"(codex exec 는 승인 정책 never 라 prompt 면 바로 거절), 비밀값은 codex 프로세스에 가지 않는다
//   agy:   전역 mcp_config.json 의 "usagi-<이름>"(enabledTools — 읽기 도구만) + settings.json permissions.allow "mcp(usagi-<이름>/<도구>)"(mcp-http.ts ensureAgyMcp)
//          headless agy 는 허용 규칙이 없는 MCP 호출을 자동 거절한다(2026-10-17 agy 1.4.0 확인). 쓰기 승인 카드는 못 붙인다(#42)
// 도구별로 열 수 없는 서버(매핑이 비었거나 sse·headersHelper)는 붙이지 않는다. 비밀값(env·헤더 값)은 argv·로그·프롬프트에 넣지 않는다.
import { CAP_LABELS, CAPABILITIES, CONNECTORS, mcpTool, type Connectors } from "./connectors.ts";
import { isReadOnlyCall } from "./guard.ts";
import { readClaudeJson } from "./mcp.ts";
import { PERMISSION_TTL_MS } from "./permissions.ts";

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

// 도구 하나를 기다리는 시간: 승인 카드 10분 + 허용 뒤 실제 호출. codex 기본값으로는 카드를 다 못 기다린다
export const CODEX_TOOL_TIMEOUT_S = PERMISSION_TTL_MS / 1000 + 120;

// -c 인자. gate: 이 실행의 문지기 주소(mcp-http.ts openGate — <맥락 도구 주소>/<열쇠>), 서버마다 <gate>/<이름>
export function codexMcpArgs(servers: CliMcpServer[], gate: string): string[] {
  return servers.flatMap((s) => {
    const k = `mcp_servers.${s.name}`;
    return ["-c", `${k}.url=${toml(`${gate}/${s.name}`)}`, "-c", `${k}.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_S}`, "-c", `${k}.default_tools_approval_mode="approve"`];
  });
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

// 채팅 프롬프트 안내(서버·도구 이름만 — 정의·비밀값은 넣지 않는다). prefix: agy 는 "usagi-". write: 쓰기 도구도 승인 카드로 부른다(Codex)
export function connectorGuide(servers: CliMcpServer[], prefix = "", write = false): string {
  if (!servers.length) return "";
  const list = servers.map((s) => `${s.caps.join("·")} ${prefix}${s.name}(${s.tools.join(", ")})`).join(" · ");
  if (write) return `- 연결된 업무 도구(MCP): ${list}. 메일·이슈·일정·Slack 을 물으면 이걸로 찾는다. 그 서버의 보내기·게시·일정 바꾸기 같은 쓰기 도구도 부를 수 있다 — 부르면 사용자 화면에 승인 카드가 뜨고, 사용자가 허용해야 실행된다. 거부되거나 취소되면 같은 호출을 되풀이하지 말고 그렇다고 답한다.\n`;
  return `- 연결된 업무 도구(MCP, 읽기만): ${list}. 메일·이슈·일정·Slack 을 물으면 이걸로 찾는다. 보내기·게시·일정 바꾸기 같은 쓰기는 이 연결로 못 하니 사용자에게 직접 하라고 말한다.\n`;
}
