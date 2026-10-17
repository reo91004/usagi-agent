import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.ts";
import { ingestSessions } from "./sessions.ts";
import { loadSshSessionHosts, parseSshConfig, resolveSshHost } from "./ssh-hosts.ts";

const CFG = `
Host *
  ServerAliveInterval 30
Host pacl-reo
  HostName 100.118.253.134
  User reo
Host pacl-205 pacl-205b
  HostName 10.150.29.119
  User user
Host pacl-ugrp
  HostName 10.150.28.185
  User ugrp
  Port 50000
`;

test("resolveSshHost: 별칭은 그대로, user@IP 는 HostName·User 가 같은 별칭으로, 없으면 user@host", () => {
  const a = parseSshConfig(CFG);
  assert.equal(resolveSshHost("pacl-208", a), "pacl-208");
  assert.equal(resolveSshHost("reo@100.118.253.134", a), "pacl-reo");
  assert.equal(resolveSshHost("user@10.150.29.119", a), "pacl-205");
  assert.equal(resolveSshHost("other@10.150.29.119", a), "other@10.150.29.119"); // User 가 다르면 다른 서버
  assert.equal(resolveSshHost("ugrp@10.150.28.185:50000", a), "pacl-ugrp");
  assert.equal(resolveSshHost("ugrp@10.150.28.185:22", a), "ugrp@10.150.28.185"); // 포트가 다르면 별칭이 아니다
  assert.equal(resolveSshHost("reo@10.150.31.155", a), "reo@10.150.31.155");
  assert.equal(resolveSshHost("a b; rm", a), undefined);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ssh-hosts-"));
  const app = join(dir, "app", "acct", "org");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(dir, "ssh_config"), CFG);
  const local = (id: string, sshHost?: string) => writeFileSync(join(app, `local_${id}.json`), JSON.stringify({ cliSessionId: id, cwd: "/x", ...(sshHost ? { sshConfig: { sshHost } } : {}) }));
  local("aaa", "reo@100.118.253.134");
  local("bbb", "pacl-208");
  local("ccc"); // ssh 아님
  writeFileSync(join(app, "local_bad.json"), "{garbage");
  const projects = join(dir, "projects");
  const session = (folder: string, id: string, cwd: string) => {
    mkdirSync(join(projects, folder), { recursive: true });
    const p = join(projects, folder, `${id}.jsonl`);
    writeFileSync(p, JSON.stringify({ type: "user", sessionId: id, cwd, timestamp: new Date().toISOString(), message: { content: "안녕" } }));
    return p;
  };
  return { dir, root: join(dir, "app"), cfg: join(dir, "ssh_config"), projects, session };
}

test("loadSshSessionHosts: cliSessionId → 서버, 깨진 파일·없는 폴더는 건너뛴다", () => {
  const f = fixture();
  assert.deepEqual([...loadSshSessionHosts(f.root, f.cfg)].sort(), [["aaa", "pacl-reo"], ["bbb", "pacl-208"]]);
  assert.equal(loadSshSessionHosts(join(f.dir, "none"), join(f.dir, "none")).size, 0);
});

test("ingestSessions: ssh-<id> 세션은 서버:/경로 로, 서버를 모르던 때 읽은 파일도 한 번 다시 읽는다", () => {
  const f = fixture();
  const store = new Store(":memory:");
  const dirs = { claude: f.projects, codex: join(f.dir, "nocodex") };
  const p = f.session("ssh-aaa", "aaa", "/home/reo/dp");
  f.session("-Users-me-app", "mac1", "/Users/me/app");
  f.session("ssh-zzz", "zzz", "/srv/unknown"); // 앱 정보가 없는 ssh 세션은 접두 없이
  store.setMark(p, statSync(p).mtimeMs); // 옛 버전이 이미 읽은 파일(서버 표시 없음)
  const sshHosts = new Map([["aaa", "pacl-reo"]]);
  assert.equal(ingestSessions(store, dirs, { sshHosts }), 3);
  assert.equal((store.node("session:aaa")!.props as any).cwd, "pacl-reo:/home/reo/dp");
  assert.equal((store.node("session:mac1")!.props as any).cwd, "/Users/me/app");
  assert.equal((store.node("session:zzz")!.props as any).cwd, "/srv/unknown");
  assert.equal(ingestSessions(store, dirs, { sshHosts }), 0); // 두 번째부터는 그대로
});
