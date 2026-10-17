// 데몬은 Agent SDK 의 query 를 여기서 가져다 쓴다: 맥에서는 이 Mac 에 설치된 claude 를 SDK 에 넘긴다(pathToClaudeCodeExecutable).
// 그래서 맥 앱에는 SDK 의 플랫폼 패키지(claude 실행 파일, 풀어서 약 225MB)를 넣지 않는다(desktop/scripts/dist.mjs, #64).
// 윈도우·리눅스는 SDK 에 든 실행 파일을 그대로 쓴다(윈도우의 npm claude.cmd 는 SDK 가 셸 없이 띄우지 못한다).
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_MISSING = "claude 명령을 찾을 수 없어요. Claude Code 를 설치해 주세요(터미널: curl -fsSL https://claude.ai/install.sh | bash).";

// SDK 가 함께 낸 Claude Code 버전. 이보다 옛 claude 도 돌지만 새 모델 이름을 몰라 비용을 잘못 센다(2.1.285 로 확인, #64)
export const SDK_CLAUDE_VERSION: string = JSON.parse(readFileSync(new URL("package.json", import.meta.resolve("@anthropic-ai/claude-agent-sdk")), "utf8")).claudeCodeVersion ?? "0.0.0";

// 공식 설치(~/.local/bin) → Homebrew → PATH 순(desktop/src/agent-login.js findBin 과 같은 순서).
// 셸 함수·alias 로 감싼 claude 는 데몬에 안 보이니 실제 파일만 본다
export function findClaude({ home = homedir(), pathEnv = process.env.PATH ?? "", exists = existsSync as (f: string) => boolean } = {}): string | undefined {
  const dirs = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", ...pathEnv.split(":").filter(Boolean)];
  return dirs.map((d) => join(d, "claude")).find((f) => exists(f));
}

// 매번 찾는다(앱을 켠 뒤에 claude 를 깔아도 바로 쓰게). 못 찾으면 SDK 의 영어 오류 대신 설치 안내로 멈춘다
export const query: typeof sdkQuery = (params) => {
  if (process.platform !== "darwin" || params.options?.pathToClaudeCodeExecutable) return sdkQuery(params);
  const bin = findClaude();
  if (!bin) throw new Error(CLAUDE_MISSING);
  return sdkQuery({ ...params, options: { ...params.options, pathToClaudeCodeExecutable: bin } });
};

// `claude --version` → "2.1.301" (맥이 아니거나·못 찾으면 undefined)
export async function claudeVersion(): Promise<string | undefined> {
  const bin = process.platform === "darwin" ? findClaude() : undefined;
  if (!bin) return undefined;
  const { stdout } = await promisify(execFile)(bin, ["--version"], { timeout: 10_000 });
  return /\d+\.\d+\.\d+/.exec(stdout)?.[0];
}

export function olderThan(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
