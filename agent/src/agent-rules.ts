// 연구·프로젝트 폴더의 AGENTS.md·CLAUDE.md 에 usagi-run 규칙을 넣는다(GET·POST /research/projects/rules).
// 쓰기는 두 가지뿐이다: 있는 파일 끝에 덧붙이기(appendFileSync·셸 >>)와 없을 때 새로 만들기(flag "wx"·셸 set -C). 기존 파일을 다시 쓰거나 자르지 않는다.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { splitHost } from "./dashboard.ts";
import { okJobDir, okJobHost, runSsh, type RunSsh } from "./jobs.ts";

export const MARK = "usagi-run:v1";
// 넣을 글. 표시(MARK)로 알아보니 글은 서버마다 달라도 된다.
// 공용 계정 서버는 usagi-run 이 내 폴더(jobDirs 의 .usagi-agent 옆 bin)에만 있어 전체 경로를 쓰고, 그 밖은 PATH 의 usagi-run
export const rulesFor = (cmd = "usagi-run") => `<!-- usagi-run:v1 -->
## 실험 실행 (usagi-run)

- 1분 넘게 걸리는 실험·학습·평가·캡처는 \`${cmd} -n "<짧은 실험 이름>" -- <명령>\`으로 돌린다. 백그라운드면 \`nohup ${cmd} -n "<이름>" -- <명령> > <로그> 2>&1 &\`로 둔다. 끝나면 연구 비서(우사기)가 알리고 연구 탭에 기록한다.
- 종료 코드는 명령 그대로 돌려준다. ls·git·1분 안에 끝나는 명령에는 쓰지 않는다.
`;
export const RULES = rulesFor();
// jobDirs 의 「…/.usagi-agent/jobs」 → 「…/bin/usagi-run」(usagi-run 이 자기 위 폴더의 .usagi-agent 를 쓰는 짝)
export const usagiRunCmd = (jobDir?: string) => { const m = jobDir ? /^(.+)\/\.usagi-agent\/jobs\/?$/.exec(jobDir) : null; return m ? `${m[1]}/bin/usagi-run` : "usagi-run"; };
const IMPORT = "@AGENTS.md";

export type Rules = { agents: "added" | "missing" | "absent"; claude: "added" | "imports" | "missing" | "absent" };

const importsAgents = (t: string) => /^\s*@AGENTS\.md\s*$/m.test(t);
const stateOf = (t: string | null, imports: boolean) => (t === null ? "absent" : t.includes(MARK) ? "added" : imports && importsAgents(t) ? "imports" : "missing");
// 덧붙일 글: 끝 줄바꿈이 없으면 하나 넣고, 빈 줄 하나 뒤에 규칙
const tail = (t: string, rules: string) => `${t === "" || t.endsWith("\n") ? "" : "\n"}\n${rules}`;

// 이 Mac 폴더. apply 면 필요한 만큼만 넣고 새 상태를 돌려준다
export function macRules(dir: string, apply: boolean, rules = RULES): Rules {
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);
  if (apply) {
    const a = read("AGENTS.md");
    if (a === null) writeFileSync(join(dir, "AGENTS.md"), rules, { flag: "wx" });
    else if (stateOf(a, false) === "missing") appendFileSync(join(dir, "AGENTS.md"), tail(a, rules));
    const c = read("CLAUDE.md");
    if (c === null) writeFileSync(join(dir, "CLAUDE.md"), `${IMPORT}\n`, { flag: "wx" });
    else if (stateOf(c, true) === "missing") appendFileSync(join(dir, "CLAUDE.md"), tail(c, rules));
  }
  return { agents: stateOf(read("AGENTS.md"), false) as Rules["agents"], claude: stateOf(read("CLAUDE.md"), true) as Rules["claude"] };
}

// 서버: ssh 한 번에 도는 고정 스크립트. dir 은 okJobDir 를 거친 절대 경로라 작은따옴표 안에 그대로 넣는다
export const rulesScript = (dir: string, apply: boolean, rules = RULES) => `set -e
cd '${dir}' || exit 3
rules() { cat <<'USAGI_RULES_EOF'
${rules}USAGI_RULES_EOF
}
st() { if [ ! -e "$1" ]; then echo absent; elif grep -qF '${MARK}' "$1"; then echo added; elif [ "$2" = 1 ] && grep -Eq '^[[:space:]]*@AGENTS\\.md[[:space:]]*$' "$1"; then echo imports; else echo missing; fi; }
app() { [ -z "$(tail -c1 "$1")" ] || echo >> "$1"; { echo; rules; } >> "$1"; }
${apply ? `case $(st AGENTS.md 0) in missing) app AGENTS.md;; absent) (set -C; rules > AGENTS.md);; esac
case $(st CLAUDE.md 1) in missing) app CLAUDE.md;; absent) (set -C; echo '${IMPORT}' > CLAUDE.md);; esac
` : ""}echo "agents=$(st AGENTS.md 0)"; echo "claude=$(st CLAUDE.md 1)"`;

// path 는 지금 연구·프로젝트 폴더 키(allowed) 중 하나여야 한다. 아니면 { error }(→ 400)
// jobDirs: 공용 계정 서버의 내 폴더(넣을 글의 usagi-run 경로를 정한다)
export async function agentRules(path: unknown, allowed: string[], apply: boolean, run: RunSsh = runSsh, jobDirs: Record<string, string> = {}): Promise<Rules | { error: string }> {
  if (typeof path !== "string" || !allowed.includes(path)) return { error: "path must be a folder of a research or project" };
  const { host, dir } = splitHost(path);
  if (!host) {
    if (!isAbsolute(dir) || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return { error: "folder not found on this Mac" };
    return macRules(dir, apply);
  }
  if (!okJobHost(host) || !okJobDir(dir) || !dir.startsWith("/")) return { error: "server folder path is not allowed" };
  const out = await run(["--", host, rulesScript(dir, apply, rulesFor(usagiRunCmd(jobDirs[host])))], 20e3);
  const m = /^agents=(\w+)\nclaude=(\w+)$/m.exec(out.replace(/\r/g, ""));
  if (!m) throw new Error("서버 응답을 읽지 못했어요");
  return { agents: m[1], claude: m[2] } as Rules;
}
