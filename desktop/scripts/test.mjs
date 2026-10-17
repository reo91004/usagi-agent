// npm test: node --test 를 실행마다 전용 임시 폴더(TMPDIR, Windows 는 TMP·TEMP)로 돌리고 끝나면 지운다 — 시험이 mkdtemp 로 만든 폴더가 쌓이지 않게
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "cy-test-"));
const r = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), "test/**/*.test.js"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), stdio: "inherit", env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
});
rmSync(tmp, { recursive: true, force: true });
if (r.error) throw r.error;
process.exit(r.status ?? 1);
