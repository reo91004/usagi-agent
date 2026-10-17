// npm test — macOS·Linux·Windows 공용(POSIX 의 `TZ=… CY_AGENT_HOME=… node --test` 를 대신한다. 새 의존성 없음).
// 1) tsc -p .(typecheck)  2) TZ=Asia/Seoul · CY_AGENT_HOME=<임시>/cy-agent-test-home 으로 node --test 'src/**/*.test.ts'
// TZ: Node 는 Windows 에서도 TZ 환경 변수를 ICU 로 따른다(IANA 이름 Asia/Seoul 그대로) — 자식 프로세스 시작 때 넘기므로 확실히 먹는다.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (args, env = process.env) => {
  const r = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (r.error) throw r.error;
  return r.status ?? 1;
};

// typescript 의 bin(셸 껍데기 tsc.cmd 를 거치지 않고 node 로 바로)
const tsPkg = join(root, "node_modules", "typescript");
const tscBin = JSON.parse(readFileSync(join(tsPkg, "package.json"), "utf8")).bin.tsc;
const tsc = run([join(tsPkg, tscBin), "-p", "."]);
if (tsc !== 0) process.exit(tsc);

// 시험이 mkdtemp 로 만든 폴더는 대부분 남는다 — 실행마다 전용 임시 폴더를 TMPDIR(Windows 는 TMP·TEMP)로 주고 끝나면 통째로 지운다
const tmp = mkdtempSync(join(tmpdir(), "cy-test-"));
const env = { ...process.env, TZ: "Asia/Seoul", TMPDIR: tmp, TMP: tmp, TEMP: tmp, CY_AGENT_HOME: join(tmp, "cy-agent-test-home") };
// node --test 는 glob 을 스스로 푼다(셸 없이 그대로 넘긴다). 뒤에 붙인 인자(npm test -- …)는 node --test 로
const code = run(["--test", ...process.argv.slice(2), "src/**/*.test.ts"], env);
rmSync(tmp, { recursive: true, force: true });
process.exit(code);
