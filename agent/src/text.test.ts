import { test } from "node:test";
import assert from "node:assert/strict";
import { clip, clipText, oneLine } from "./text.ts";

test("text helpers", () => {
  assert.equal(clip("abcdef", 4), "abc…");
  assert.equal(clip("abcd", 4), "abcd");
  assert.equal(oneLine("  a \n\t b  "), "a b");
  assert.equal(clipText(undefined, 5), "");
  assert.equal(clipText(" a  b\nc d ", 5), "a b …");
});
