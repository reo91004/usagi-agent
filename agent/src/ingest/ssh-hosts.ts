// Claude 데스크탑 앱의 SSH 세션(~/.claude/projects/ssh-<세션 id>/)은 기록 안에 서버 이름이 없다.
// 앱이 따로 적어 둔 세션 정보(claude-code-sessions/<계정>/<조직>/local_*.json 의 cliSessionId · sshConfig.sshHost)에서 찾는다.
// sshHost 는 ssh 별칭(pacl-208)이거나 user@IP[:포트] — 후자는 ~/.ssh/config 에서 HostName·User 가 같은 별칭으로 바꾼다.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_APP_SESSIONS = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");

export type SshAlias = { names: string[]; hostName: string; user: string; port: string };

// ~/.ssh/config 글 → 구체적인 Host 별칭들(* ? ! 패턴은 뺀다)과 HostName · User · Port
export function parseSshConfig(text: string): SshAlias[] {
  const out: SshAlias[] = [];
  let cur: SshAlias | undefined;
  for (const raw of text.split("\n")) {
    const m = /^(host|hostname|user|port)\s*[=\s]\s*(.+)$/i.exec(raw.replace(/#.*$/, "").trim());
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "host") {
      cur = { names: val.split(/\s+/).filter((n) => /^[A-Za-z0-9._-]+$/.test(n)), hostName: "", user: "", port: "" };
      out.push(cur);
    } else if (cur) {
      const f = key === "hostname" ? "hostName" : (key as "user" | "port");
      cur[f] ||= val;
    }
  }
  return out.filter((a) => a.names.length);
}

// sshHost → 접두로 쓸 서버 이름. 별칭이면 그대로, user@host[:포트] 는 HostName·User(포트가 있으면 Port)가 같은 별칭, 없으면 user@host
export function resolveSshHost(sshHost: string, aliases: SshAlias[]): string | undefined {
  const m = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(sshHost);
  if (!m) return undefined;
  const [, user = "", host, port = ""] = m;
  if (!user && !port) return host; // 별칭 그대로
  const hit = aliases.find((a) => a.hostName === host && a.user === user && (!port || (a.port || "22") === port));
  return hit ? hit.names[0] : user ? `${user}@${host}` : host;
}

// 세션 id(cliSessionId) → 서버 이름
export function loadSshSessionHosts(root = CLAUDE_APP_SESSIONS, sshConfigPath = join(homedir(), ".ssh", "config")): Map<string, string> {
  const map = new Map<string, string>();
  let aliases: SshAlias[] = [];
  try { aliases = parseSshConfig(readFileSync(sshConfigPath, "utf8")); } catch { /* ssh config 없음 — 주소를 별칭으로 못 바꿀 뿐 */ }
  const ls = (d: string) => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  for (const acct of ls(root)) for (const org of ls(join(root, acct.name))) for (const f of ls(join(root, acct.name, org.name))) {
    if (!/^local_.*\.json$/.test(f.name)) continue;
    let j: any;
    try { j = JSON.parse(readFileSync(join(root, acct.name, org.name, f.name), "utf8")); } catch { continue; }
    const host = typeof j?.sshConfig?.sshHost === "string" ? resolveSshHost(j.sshConfig.sshHost, aliases) : undefined;
    if (host && typeof j.cliSessionId === "string") map.set(j.cliSessionId, host);
  }
  return map;
}
