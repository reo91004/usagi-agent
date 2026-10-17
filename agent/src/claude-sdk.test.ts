import { test } from "node:test";
import assert from "node:assert/strict";
import { findClaude, olderThan, SDK_CLAUDE_VERSION } from "./claude-sdk.ts";

test("findClaude: ~/.local/bin → Homebrew → PATH 순, 없으면 undefined", () => {
  const at = (...files: string[]) => (f: string) => files.includes(f);
  const o = { home: "/Users/me", pathEnv: "/Users/me/.nvm/versions/node/v24/bin:/usr/bin" };
  assert.equal(findClaude({ ...o, exists: at("/Users/me/.local/bin/claude", "/opt/homebrew/bin/claude", "/Users/me/.nvm/versions/node/v24/bin/claude") }), "/Users/me/.local/bin/claude");
  assert.equal(findClaude({ ...o, exists: at("/opt/homebrew/bin/claude", "/Users/me/.nvm/versions/node/v24/bin/claude") }), "/opt/homebrew/bin/claude");
  assert.equal(findClaude({ ...o, exists: at("/Users/me/.nvm/versions/node/v24/bin/claude") }), "/Users/me/.nvm/versions/node/v24/bin/claude");
  assert.equal(findClaude({ ...o, exists: () => false }), undefined);
});

test("olderThan: 숫자로 비교 · SDK 가 함께 낸 claude 버전을 읽는다", () => {
  assert.equal(olderThan("2.1.285", "2.1.293"), true);
  assert.equal(olderThan("2.1.301", "2.1.293"), false);
  assert.equal(olderThan("2.1.293", "2.1.293"), false);
  assert.equal(olderThan("2.0.999", "2.1.0"), true);
  assert.match(SDK_CLAUDE_VERSION, /^\d+\.\d+\.\d+$/);
});
