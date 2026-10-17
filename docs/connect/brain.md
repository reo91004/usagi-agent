# 뇌(대화하는 AI) 고르기

뇌(AI)는 선택입니다. 뇌가 없어도 할 일 보기, 할 일의 「오늘」, 정해진 말(인사·응원), 회의 알림(이 Mac 캘린더·ICS)은 동작합니다. 말 걸기·채팅·브리핑 요약까지 쓰고 싶을 때 뇌를 하나 연결하면 됩니다.

가장 쉬운 방법은 연결 도우미의 「뇌 고르기」입니다. 패널 위쪽의 「연결 도우미」 단추나 설정 「연결」 탭의 「연결 도우미 열기」에서 열 수 있습니다.

이 맥에 Claude Code·Codex·Antigravity(agy)가 로그인돼 있으면 「찾았어요 ✓」로 떠서 누르기만 하면 됩니다. API 키는 붙여 넣는 순간 맞는 키인지 확인해 줍니다. AI 없이 쓰려면 「AI 없이 쓰기」를 고르세요. 뇌가 `local`로 정해지고 마법사는 다음 단계로 이어집니다.

고른 뇌는 `~/.cy-agent/config.json`의 `brain`에 저장되고, 데몬을 다시 켜지 않아도 바로 적용됩니다(`PUT /settings`).

| 뇌 | `brain.provider` | 필요한 것 | 할 수 있는 것 |
|---|---|---|---|
| Claude Code | `claude-code`(기본) | Claude Code 설치·로그인(Pro·Max·Team·Enterprise 또는 Console), [claude-code.md](claude-code.md) 참고 | 전부: 대화·브리핑, 할 일 자동 완료·진척, 지식그래프, mcp 연결, 코드 고치기·작업 세션·자동 머지 |
| Codex | `codex` | Codex CLI 설치·로그인(ChatGPT 유료 계정) | 대화·브리핑, 할 일 자동 완료·진척, 지식그래프·나에 대해 배우기, mcp 연결(채팅에서만), 코드 고치기·이어 하기·자동 머지 |
| Antigravity | `agy` | Antigravity CLI(`agy`) 설치·로그인(Google 계정) | 대화·브리핑, 할 일 자동 완료·진척, 지식그래프·나에 대해 배우기, mcp 연결(채팅에서만), 코드 고치기·이어 하기·자동 머지 |
| Gemini | `gemini` | Google AI Studio 키 | 대화·브리핑 |
| OpenAI | `openai` | OpenAI 플랫폼 키(크레딧 필요) | 대화·브리핑 |
| Claude API | `anthropic` | Anthropic 콘솔 키(크레딧 필요) | 대화·브리핑 |
| Genspark | `genspark` | Genspark 유료 플랜 + `gsk login` 한 키 또는 붙여 넣은 `gsk-` 키 | 대화·브리핑 |
| 없음(AI 없이 쓰기) | `local` | 없음 | 정해진 말, 할 일, 할 일의 「오늘」, 회의 알림 |

코드 고치기, 작업 세션의 「새 작업」·「이어서 하기」, 자동 머지는 뇌가 Codex·Antigravity 면 그 CLI 로, 그 밖에는 Claude Code 로 돌아갑니다. 고칠 수 있는 AI 가 없으면(키·로컬 뇌에 Claude Code 도 없음) 이 버튼들은 보이지 않습니다. 워크트리와 백그라운드 에이전트는 Claude Code 로만 돕니다.

Gemini·OpenAI·Claude API·Genspark 뇌는 도구를 쓰지 못하고 답만 받습니다. 그래서 브리핑도 Slack(api)이나 캘린더(이 Mac 캘린더·ICS)처럼 앱이 직접 모아 둔 자료만 가지고 합니다.

## Codex·Antigravity 뇌에서 mcp 연결 읽기

`connectors` 를 `mcp` 모드로 둔 메일·이슈·캘린더·Slack 은 Codex·Antigravity 뇌일 때 채팅에서만 씁니다. Codex 는 쓰기 도구도 승인 카드를 거쳐 쓰고, Antigravity 는 읽기만 합니다. 브리핑과 캘린더 동기화에서 MCP 를 읽는 것은 지금도 Claude Code 뇌일 때만입니다.

- 서버 정의는 Claude Code 에 등록한 것(`~/.claude.json`)을 그대로 씁니다. stdio 서버와 http 서버만 넘길 수 있고, sse 서버나 `headersHelper` 를 쓰는 서버, 이름에 영문·숫자·`_`·`-` 밖의 글자가 있는 서버·도구는 넘기지 못합니다. Claude Code 안에서 OAuth 로 로그인한 http 서버는 넘기더라도 Codex·agy 가 그 로그인을 쓰지 못해 읽지 못합니다.
- 커넥터 매핑(프리셋이나 `tools`)에 읽기 도구가 하나도 없으면 그 연결은 붙이지 않고 패널에 이유를 보여 줍니다. 쓰기 이름(보내기·만들기·고치기 등)은 매핑에 적어도 읽기 도구로 열리지 않습니다.
- Codex 에는 서버를 직접 붙이지 않습니다. 채팅할 때마다 `-c mcp_servers.<이름>.url` 로 데몬 주소(`/mcp/<토큰>/<열쇠>/<이름>`, 열쇠는 그 codex 실행 동안만 있습니다)를 주고, 데몬이 진짜 서버에 대신 붙습니다. Codex 는 그 서버의 도구를 모두 보지만, 부를 때마다 Claude Code 뇌와 같은 승인 판정을 거칩니다. 읽기 도구와 [항상 허용] 규칙에 맞는 호출은 바로 넘기고, 보내기·만들기 같은 쓰기 도구는 채팅에 승인 카드를 띄운 뒤 [허용]을 눌러야 진짜 서버로 넘깁니다. 거부하거나 10분 동안 답이 없거나 대화를 멈추면 그 호출은 거절되고 Codex 는 그 결과를 보고 이어서 답합니다. env 와 헤더 값은 데몬만 쓰고 Codex 프로세스에는 넘기지 않습니다.
- 카드를 기다리는 동안에도 Codex 는 모델을 여러 번 다시 불러 기다리는 중이라고 적습니다. 오래 기다릴수록 Codex 사용량이 늘어납니다(Codex 0.163 시험에서 도구 하나를 75초 기다렸을 때 입력 토큰이 약 20만, 330초 기다렸을 때 약 84만이었고 그중 96%가 캐시였습니다). Codex 의 MCP 도구 기본 대기는 300초라서 서버마다 `tool_timeout_sec` 를 720초로 늘리고, 승인 카드가 붙는 채팅은 codex 실행 시간 상한도 2분에서 12분으로 늘립니다.
- Antigravity 는 실행마다 MCP 를 넘길 수 없어서 전역 설정에 넣습니다. `~/.gemini/config/mcp_config.json` 에 `usagi-<이름>` 서버(`enabledTools` 는 읽기 도구만)를, `~/.gemini/antigravity-cli/settings.json` 의 `permissions.allow` 에 `mcp(usagi-<이름>/<도구>)` 를 하나씩 넣습니다. env·헤더에 비밀값이 있으면 `mcp_config.json` 권한을 600 으로 바꿉니다. 커넥터에서 빠진 `usagi-…` 항목은 다음 채팅 때 지웁니다. 전역 설정이라 터미널에서 agy 를 직접 쓸 때나 뒤에서 하는 정리 때도 이 읽기 도구가 묻지 않고 허용되고, 뇌를 다른 것으로 바꿔도 항목은 남습니다.

## API 키 뇌(Gemini, OpenAI, Claude API)의 도구와 뒤에서 도는 기능

- 채팅에서 서버(remote_ls 등), Slack, 할 일, 지식그래프 같은 읽기 전용 맥락 도구를 부를 수 있습니다. 한 번의 답에서 도구를 부르는 차례는 4번, 호출은 8번까지이고, 쓰기 도구는 없습니다. 캐릭터 말 걸기는 도구 없이 답합니다. Genspark 는 도구 호출을 받는지 확인하지 못해 맥락을 통째로 받습니다. `contextMode` 를 `inline` 으로 두면 모든 API 뇌가 예전처럼 맥락을 통째로 받습니다.
- 끝난 할 일 판정, 할 일 진행 확인, 지식그래프 추출·다듬기, 프로필 학습은 구조화 JSON 호출 한 번으로 돕니다. 금액은 API 가 알려 준 토큰에 모델별 어림 단가를 곱해 예산에 셉니다(모르는 모델은 비싼 쪽으로 잡습니다. Genspark 는 크레딧제라 0으로 두고 호출 수 상한만 걸립니다). 증분 지식그래프·다듬기에는 Codex·agy 와 같은 호출 수 상한이 같이 걸립니다.
- 코드 고치기, 작업 세션, 자동 머지, 워크트리는 API 뇌로 되지 않습니다.

## Antigravity(agy)

키 없이 이 맥에 로그인된 Antigravity CLI를 씁니다. 시사는 `agy -p … --output-format json --sandbox`를 한 번씩 부르고(코드 수정 없음), 답은 한 번에 10~20초쯤 걸립니다. mcp 연결은 채팅에서만 읽고([위](#codexantigravity-뇌에서-mcp-연결-읽기)), 코드 고치기·이어 하기도 agy 로 합니다. 워크트리·백그라운드 에이전트는 Claude Code로 돌아갑니다.

1. Antigravity CLI를 설치하고 터미널에서 `agy`를 실행해 로그인한 뒤 나옵니다.
2. 로그인됐는지는 `agy models`로 확인합니다. 종료 코드 0과 함께 `<id>  <이름>` 목록이 나오면 됩니다. 목록이 비거나 실패하면 로그인 전으로 봅니다.
3. 연결 도우미의 「뇌 고르기」에서 Antigravity를 고르거나 `brain.provider`를 `agy`로 정합니다.

모델은 설정 「AI」 탭에 `agy models` 목록이 나오고, 고르지 않으면 Gemini 3.8 Flash 를 씁니다(캐릭터 말 걸기는 `gemini-3.8-flash-low`, 채팅·브리핑·뒤에서 하는 정리는 `gemini-3.8-flash-medium`). agy 자체 기본(Gemini 4 Argon Medium)보다 빠르고 사용량이 적습니다. 그 이름이 agy 목록에서 없어지면 agy 기본 모델로 한 번 더 부릅니다. 코드 고치기는 고른 모델이 없으면 agy 기본 모델입니다. 파일로 정하려면 `models.general`에 목록의 id(예: `gemini-4-argon-medium`)를 넣습니다. 시사는 agy를 데몬의 `~/.cy-agent/brain` 폴더에서 돌리고, 레포 안에서는 돌리지 않습니다. 프롬프트는 명령줄 인자로 넘기므로 너무 긴 맥락(약 400KB 초과)은 오류로 알려 줍니다.

캐릭터에게 말을 걸려고 입력창을 열면 agy 를 하나 미리 띄워 둡니다. 보낸 말 한 턴만 처리하고 끝나며, 끝나면 다음 것을 다시 띄웁니다. 캐릭터 채팅을 쓰는 동안에만 켜 두고, 3분 동안 말이 없거나 설정이 바뀌거나 데몬이 꺼지면 닫습니다. 켜 둔 동안 메모리는 80~200MB 쯤, CPU는 거의 0%입니다. 답 형식은 글에 적어 알리고, 형식이 틀렸을 때만 `--json-schema` 를 붙여 한 번 더 부릅니다.

## Genspark

Genspark의 LLM 프록시(OpenAI 호환)로 Claude·GPT 등 여러 회사 모델을 키 하나로 씁니다.

1. [genspark.ai](https://www.genspark.ai)에 가입하고 [요금제](https://www.genspark.ai/pricing)에서 유료 플랜을 고릅니다. 무료 플랜 키로는 모델 목록만 열리고 대답은 하지 않습니다.
2. 터미널에서 공식 CLI를 깔고 로그인합니다.

   ```bash
   npm install -g @genspark/cli
   gsk login
   ```

3. 연결 도우미의 「뇌 고르기」에서 Genspark를 고르고 「gsk login 한 키 쓰기」를 누릅니다. 키를 직접 붙여 넣어도 됩니다.

「gsk login 한 키 쓰기」를 고르면 시사는 키를 따로 저장하지 않고, 쓸 때마다 `~/.genspark-tool-cli/config.json`의 키를 읽습니다. 다시 로그인해서 키가 바뀌어도 그대로 따라갑니다. 시사는 이 파일을 읽기만 하고 고치지 않습니다.

모델은 프록시의 모델 목록(`GET /models`)에 있는 것만 고를 수 있습니다. 설정 「AI」 탭에 그 목록이 그대로 나옵니다. 기본값은 목록에 있으면 `claude-sonnet-5-5`, 없으면 `gpt-5.4-mini`, 그것도 없으면 목록의 첫 모델입니다. 목록에 없는 모델을 고르면 요청을 보내기 전에 막고 알려 줍니다.

연결 상태에 「Genspark 키는 맞지만 크레딧이 필요해요」가 보이면 키는 맞은 것입니다. 유료 플랜을 고른 뒤 다시 말을 걸면 바로 됩니다. 「Genspark 키가 맞지 않아요」가 보이면 `gsk login`을 다시 해 주세요.

## 우선순위와 자동 전환

AI를 둘 이상 연결했다면 설정 「AI」 탭의 「AI 우선순위」에서 순서를 바꿀 수 있습니다. 맨 위가 먼저 쓰는 AI이고, 앞의 AI가 사용량이나 크레딧을 다 쓰면 다음 AI가 같은 일을 이어서 합니다. 넘어갈 때 말풍선이 한 번 뜨고, 이 탭에는 지금 쓰는 AI와 쉬는 AI가 언제까지 쉬는지 한 줄로 나옵니다.

- 파일에서는 `brain.fallback`에 첫 뇌 다음 순서를 적습니다. 모델은 AI마다 따로 적고, 없으면 그 AI의 기본 모델을 씁니다(첫 뇌는 `models.general`). `local`은 넣을 수 없습니다.
  ```json
  { "brain": { "provider": "claude-code", "fallback": [{ "provider": "codex" }, { "provider": "gemini", "model": "gemini-3.8-flash" }] } }
  ```
- 사용량 소진, 크레딧 부족, 한도 초과, 로그인이나 키 오류가 나면 그 AI를 건너뜁니다. 풀리는 시각을 알면 그때까지, 모르면 사용량·크레딧·로그인 문제는 60분, 분당 한도는 2분 동안 건너뜁니다. 이 기록은 메모리에만 있어서 데몬을 다시 켜거나 뇌·키 설정을 바꾸면 사라집니다.
- 채팅, 슬래시 명령, 브리핑, 할 일 묻기처럼 `ask()`를 지나는 일과 Codex·Antigravity로 도는 뒤 작업(할 일 판정, 진행 확인, 지식그래프, 프로필 학습)에 적용됩니다. 설정 파일은 바뀌지 않고 그 호출에만 다른 AI를 씁니다.
- 한도가 아닌 오류(네트워크, 잘못된 요청 등)는 넘기지 않고 그대로 알립니다. 모든 AI가 안 되면 첫 AI의 오류에 시도한 AI의 이유를 덧붙입니다.

한계입니다.

- 코드 고치기 작업은 도중에 다른 AI로 넘어가지 않습니다. 다음 작업부터 순서를 따릅니다.
- 캘린더 MCP 동기화, `/btw`, 백그라운드 에이전트처럼 Claude Code에만 있는 기능은 그대로입니다. Claude Code가 쉬는 동안 브리핑은 MCP 출처 없이 만들어집니다.
- Claude Code로 돌던 뒤 작업은 한도를 스스로 알아보지 못하고, 채팅 등에서 한도가 확인된 뒤에야 다음 CLI 뇌로 넘어갑니다.
- Codex·Antigravity의 한도 문구는 공개된 표본이 없어 「usage limit」「rate limit」「quota」 같은 흔한 문구로 알아봅니다.

## 파일로 직접 넣기

```json
{ "brain": { "provider": "gemini", "geminiApiKey": "..." } }
```

| 키 | 환경변수(파일보다 우선) |
|---|---|
| `brain.provider` | `CY_AGENT_BRAIN` |
| `brain.geminiApiKey` | `CY_AGENT_GEMINI_API_KEY`, `GEMINI_API_KEY` |
| `brain.openaiApiKey` | `CY_AGENT_OPENAI_API_KEY`, `OPENAI_API_KEY` |
| `brain.anthropicApiKey` | `CY_AGENT_ANTHROPIC_API_KEY`(`ANTHROPIC_API_KEY`는 Claude Code도 쓰는 이름이라 읽지 않습니다) |
| `brain.gensparkApiKey` | `CY_AGENT_GENSPARK_API_KEY`(둘 다 없으면 `gsk login`이 남긴 `~/.genspark-tool-cli/config.json`) |
| `models.general` | `CY_AGENT_MODEL_GENERAL`(대화·브리핑 모델. 비우면 뇌마다 기본 모델) |

파일을 직접 고쳤다면 데몬을 다시 켜 주세요.

```bash
launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon
```

키는 로그나 오류 메시지에 남지 않습니다. 연결 상태는 설정 「연결」 탭의 「연결 상태」(`GET /status`)에서 볼 수 있고, 여기에도 키 값은 나오지 않습니다.
