import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Settings, validatePatch, SettingsError } from "./settings.ts";

const cfgOf = (f: Record<string, unknown> = {}) => loadConfig({}, f);

test("나·MCP·Tine·연결 설정: 검증 · 파일에 합쳐 쓰기 · cfg 에 바로 반영 · 모르는 키 보존", () => {
  for (const bad of [{ allowMcp: "a" }, { allowMcp: ["a b"] }, { gitAuthor: {} }, { gitAuthor: { email: "x" } }, { gitAuthor: { name: "a\nb" } }, { tineGraph: "/nonexistent-xyz" },
    { user: { aliases: "a" } }, { user: { aliases: ["x".repeat(61)] } }, { connectors: { foo: {} } }, { connectors: { mail: { mode: "api" } } }, { connectors: { mail: { mode: "mcp", server: "a b" } } },
    { connectors: { slack: { timeZone: "Asia/Seoul" } } }, { connectors: { calendar: { timeZone: "Mars/Base" } } }, { connectors: { calendar: { email: "x" } } }])
    assert.throws(() => validatePatch(bad, cfgOf()), SettingsError, JSON.stringify(bad));
  assert.deepEqual(validatePatch({ connectors: { issues: { mode: "mcp", server: "github" } } }, cfgOf()).connectors, { issues: { mode: "mcp", server: "github", preset: "github" } });
  const dir = mkdtempSync(join(tmpdir(), "usagi-pe-"));
  const graph = join(dir, "graph");
  mkdirSync(join(graph, "logseq"), { recursive: true });
  writeFileSync(join(graph, "logseq", "config.edn"), "{}");
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ token: "keep", connectors: { calendar: { mode: "api", icsUrl: "https://x/basic.ics" } } }));
  const cfg = loadConfig({}, JSON.parse(readFileSync(p, "utf8")));
  const seen: string[][] = [];
  const s = new Settings(cfg, { path: p, env: {}, onChange: (k) => seen.push(k) });
  const r = s.put({
    user: { aliases: [" 레오 ", "레오", "reo"] }, gitAuthor: { name: "Reo", email: "r@x.org" }, tineGraph: graph, allowMcp: ["notion", "notion"],
    connectors: { calendar: { timeZone: "America/New_York", email: "R@X.org" }, mail: { mode: "mcp", server: "gmail" } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(cfg.user.aliases, ["레오", "reo"]);
  assert.deepEqual(cfg.gitAuthor, { name: "Reo", email: "r@x.org" });
  assert.equal(cfg.tineGraph, graph);
  assert.deepEqual(cfg.allowMcp, ["notion"]);
  const file = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(file.token, "keep");
  assert.equal(file.connectors.calendar.icsUrl, "https://x/basic.ics"); // 시간대만 바꿔도 주소는 그대로
  assert.equal(file.connectors.calendar.timeZone, "America/New_York");
  assert.deepEqual(file.connectors.mail, { mode: "mcp", server: "gmail", preset: "gmail" });
  assert.deepEqual(seen.map((k) => [...k].sort()), [["allowMcp", "connectors", "gitAuthor", "tineGraph", "user"]]);
  assert.equal(s.put({ tineGraph: null }).ok, true);
  assert.equal(cfg.tineGraph, undefined);
  assert.equal("tineGraph" in JSON.parse(readFileSync(p, "utf8")), false);
  s.put({ user: { name: "레오" } });
  assert.equal(cfg.user.aliases.length, 2); // 이름만 바꿔도 다른 이름은 남는다
});
