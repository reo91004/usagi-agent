# 데몬 ↔ 데스크톱 계약 (127.0.0.1:47823)

데몬(`agent/src/bus.ts`)은 `127.0.0.1`에서만 연다. 포트는 `CY_AGENT_PORT`로 바꿀 수 있다.

**공통 규칙**
- 쓰기(POST·PUT·DELETE)는 `X-CY-Agent: 1` 헤더가 필수다. `Origin`이 있으면 거부한다(`file://` 제외) → 403. 첨부 파일 읽기(GET)도 같은 규칙이다.
- 본문은 JSON 객체(`content-type: application/json`)이고, 본문이 없어도 되는 곳은 `{}`로 본다.
- 처리기가 없으면(모듈이 꺼짐) 503, 모양이 틀리면 400, 없는 id면 404다.
- `Host` 헤더가 `127.0.0.1:<포트>`나 `localhost:<포트>`가 아니면 모든 경로(`/events` 포함)를 403으로 막는다. 다른 이름이 127.0.0.1을 가리키게 하는 DNS 리바인딩을 막기 위해서다.
- 응답과 상태 어디에도 키·토큰·ICS 주소 값은 넣지 않는다(있나 없나만).

## SSE `GET /events`

접속 직후 `state`를 한 번 보낸다. 그다음 결정을 기다리는 버튼 말풍선과 최근 말풍선 3개, `runs`(`{ active }`)를 보낸다. 최근 말풍선은 띄운 지 `ttlMs`(없으면 3분) 안의 것만 다시 보낸다. 로컬 뇌의 시간대 인사는 고정 id `local-greet`로 와서 겹쳐 쌓이지 않는다. 25초마다 ping, `retry: 3000`.

| 이벤트 | 데이터 | 뜻 |
|---|---|---|
| `bubble` | `Bubble`(아래) | 말풍선. 같은 `id`로 다시 오면 통째로 바꾼다 |
| `clear` | `{ id }` | 말풍선 걷기 |
| `state` | `{ mood: idle\|thinking\|working\|alert, activity: idle\|studying\|dancing, runs: [{ id, kind, title, startedAt }], danceId?, character }` | 캐릭터 상태. `character`는 고른 캐릭터 id(`shisa`·`hachi`·`rakko`·`momonga`·`usagi` 또는 사용자가 만든 `u-…`)이고, 바뀌면 바로 다시 보낸다 |
| `status` | `{ status: Status }` | 연결 상태가 바뀜(`GET /status`와 같은 모양) |
| `dashboard` | `{}` | 대시보드를 다시 가져오라는 신호 |
| `open_panel` | `{ section: overview\|projects\|todos\|chat\|null }` | 패널을 그 탭으로 열기 |
| `chat` | `{ chatId, status: thinking\|step\|done\|error, … }` | 채팅 진행·답 |
| `threads` | `{ thread?, deleted? }` | 대화 목록이 바뀜 |
| `agents` | `{ threadId }` | 그 대화의 백그라운드 에이전트·작업 세션 카드가 바뀜 → `GET /chat/threads/:id/agents` |
| `action` | `{ action }` | 확인 카드 상태 변화(pending → running → done\|failed, cancelled, expired) |
| `run` | `{ id, seq, event }` | 작업 세션 이벤트 한 줄 |
| `runs` | `{ run?, active: [run] }` | run 시작·끝·상태 변화 |
| `focus` | `FocusView`(아래 「집중하기」) | 집중하기 시작·일시정지·다시 시작·그만. 접속 직후에도 한 번 |
| `characters` | `{ rev }` | 캐릭터를 만들거나 고치거나 지움 → `GET /characters`를 다시 읽는다(아래 「캐릭터 만들기·대사 고치기」) |

```ts
type Bubble = {
  id: string; text: string; kind: "info" | "todo" | "proposal" | "done" | "error";
  ttlMs?: number; proposalId?: string; link?: string;           // link: http(s)·slack 만 연다
  image?: "merge" | "merge_complete" | "lots" | "daily" | "daily_all_complete" | "daily_half_complete" | "to_do_new"; // 스티커(~/.cy-agent/assets/reactions)
  detail?: string;                                              // 긴 본문
  open?: { section: "overview" | "projects" | "todos" | "chat"; id?: string }; // 누르면 패널 그 자리
  actions?: "merge" | "action" | "permission"; actionId?: string; always?: boolean; blocked?: string;
};
```

- `studying`: 데몬이 스스로 돌리는 세션(run)이 있을 때다(사용자 대화 `chat` 제외).
- `dancing`: 일정 알림(기본 10분 전, 설정 `calendarAlert`) 때 8초 동안이다.
- 앱은 캐릭터마다 다른 영상을 튼다. 시사는 `assets/character/`의 `studying`·`dance`이고, 다른 캐릭터는 `assets/characters/<id>/`의 `study`(집중·공부 중)와 `plan`(일정 알림·춤)이다.

## 상태·설정

### `GET /status`

지금 무엇이 연결됐나. 앱은 이걸로 화면을 가른다(뇌 없음 → 더블클릭 춤 + 「연결하기」, Claude Code 없음 → 코드 기능 숨김).

```jsonc
{
  "brain": { "provider": "claude-code|codex|anthropic|gemini|openai|local", "label": "Claude Code",
             "ready": true,          // null = 아직 모름(Claude Code 로그인 확인 전)
             "local": false, "detail": "Claude Code 연결됨" },
  "chat": true,                      // 말 걸 수 있나(뇌 준비 + local 아님). null = 모름
  "coder": { "claude": true, "codex": false },
  "connectors": [{ "cap": "slack|calendar|mail|issues", "label": "Slack", "mode": "api|mcp|off", "ready": true }],
  "user": { "name": "길동" },
  "onboarded": true,
  "configError": "설정 파일(config.json)에 문법 오류가 있어 …",  // 있을 때만. 파일을 못 읽어 안전 모드로 켬
  "configNotes": ["ingestIntervalMin 값이 이상해서 …"],        // 있을 때만. 이상한 설정 값을 기본값으로 바꾼 것들
  "daemon": "shisa",                 // 늘 같은 값: 이 포트의 주인이 시사 데몬이다(GET /status 에만, SSE status 엔 없음)
  "pid": 12345,                      // 데몬 프로세스 id
  "stopping": true                   // 있을 때만. 꺼지는 중(곧 포트가 빈다)
}
```

- `daemon`·`pid`·`stopping`: 앱(desktop `daemonAlive`)은 2xx JSON 에 `daemon: "shisa"`가 있어야 그 포트에 시사 데몬이 있다고 본다. 이 칸이 생기기 전의 데몬은 `brain.provider`가 있는 모양으로 알아본다. 다른 프로그램이 답하면 데몬을 띄워 본다.
- 데몬은 `cy.db`를 열기 전에 포트부터 잡는다. 이미 누가 쓰고 있으면 한 줄 남기고 종료 코드 75로 끝난다. 앱은 이걸 충돌로 세지 않고 그 포트를 다시 지켜본다(처음 1분은 2초마다, 그 뒤로는 1분마다).

- `configError`: `config.json`이 JSON 문법 오류이거나 `{ … }` 모양이 아니면 데몬은 안전 모드로 켠다. 설치 마법사 전처럼 작업 기록·레포를 읽지 않고, 뇌는 `local`이다. 로그에도 크게 남긴다. 파일을 고친 뒤 데몬을 다시 켜면 풀린다.
- `configNotes`: 모르는 `brain.provider`(→ `local`), 1분보다 작거나 숫자가 아닌 분 간격(`briefingIntervalMin`·`ingestIntervalMin`·`slackIngestIntervalMin`·`progressCheckMin`, `progressCheckMin`만 0 = 끔), 0이 아니면서 0.25시간보다 작은 `todayReminder.everyHours`, 숫자가 아닌 `port`(→ 47823), `repoRoots`의 상대 경로·`/` 같은 값. 위쪽 상한은 없다.
- API 키 뇌(`openai`·`gemini`·`anthropic`)가 401·403을 받으면 `brain.ready: false`, `detail`은 「… API 키가 맞지 않아요. 키를 확인해 주세요」가 되고 SSE `status`로 알린다. 그 키로는 정기 브리핑을 쉬어서 실패 말풍선이 매번 뜨지 않는다. 키를 바꾸거나 호출이 한 번 성공하면 풀린다.

### `GET /settings` · `PUT /settings`

`GET` 응답은 아래 값을 준다.
- `models{quick,general,code,light}`, `modelRoles`, `modelOptions`, `envLocked`
- `briefing{exclude,sources}`, `phrases[]`, `autoMerge[]`
- `todayReminder{mode,everyHours,times}`, `calendarAlert{minutesBefore[]}`
- `brain{provider,model,keys{gemini,openai,anthropic: boolean}}`
- `sshHosts[]`(GPU·tmux·작업 결과를 볼 서버), `sessionHosts[]`(작업 기록을 받을 서버), `jobDirs{서버: 결과 폴더}`(config.json 과 같은 키)
- `slackMuted[]`(끈 Slack 채널·DM id), `slackChannels[{id,name,type}]`(GET 에만, 내가 들어간 채널(public·private) → 그룹 DM(mpim, 참여자 실명) → DM(im, 상대 이름), 묶음 안은 이름순)
- `slackTeam{url,id}`(GET 에만, Slack 워크스페이스 주소와 팀 id. 앱이 permalink 를 slack:// 로 바꿀 때 씀. 모르면 null)
- `user{name?}`, `repoRoots[]`, `configPath`
- `onboarded`(설치 마법사를 마쳤나), `readSessions`(이 맥의 Claude Code·Codex 작업 기록을 읽나)
- `character`(고른 캐릭터 id), `characters[{id,name}]`(고를 수 있는 캐릭터)

`PUT` 본문(전부 선택, 모르는 키는 400):

```jsonc
{
  "models": { "general": "claude-sonnet-5-5" },          // GET 의 modelOptions 안의 id
  "briefing": { "exclude": ["mail"] },                    // mail·calendar·slack·issues·sessions
  "phrases": { "<키>": ["줄", "…"] | null },              // null = 기본값
  "autoMerge": ["owner/name"],
  "slackMuted": ["C01ABC", "D02DEF"],                      // 끈 채널·DM 은 수집·할 일·브리핑·반응·지시사항·지식그래프에서 뺀다(멘션 포함). 빈 목록 = 전부 받음
  "sshHosts": ["gpu1"], "sessionHosts": ["gpu1"],           // ~/.ssh/config 별칭 목록(통째로, 50개까지). 바로 반영: 새 서버는 30초쯤 뒤 첫 확인
  "jobDirs": { "gpu1": "~/reo/.usagi-agent/jobs" },        // 공용 계정이면 <내 폴더>/.usagi-agent/jobs (통째로). 그 폴더 아래 tmux·결과·기록만 내 것
  "brain": { "provider": "gemini", "keys": { "gemini": "…" | null }, "model": "gemini-2.5-flash" | null },
  "user": { "name": "길동" | null },
  "repoRoots": ["/Users/me/code"],                        // 절대 경로만
  "readSessions": true,                                   // 작업 기록 읽기 켜고 끄기
  "onboarded": true,                                      // 설치 마법사를 마침(마법사가 보낸다)
  "calendarAlert": { "minutesBefore": [15, 5] },          // 일정 몇 분 전(양의 정수, 개수·크기 상한 없음). [] = 알림 끔, 기본 [10]
  "character": "hachi"                                    // shisa·hachi·rakko·momonga·usagi. 모르는 값은 400
}
```

- 결과는 200 `{ ok, settings, applied: "live", restartNeeded: false }`다.
- 사용자 캐릭터는 `~/.cy-agent/characters/<id>/`의 그림·영상을 `cy-asset://app/user-characters/<id>/<저장 이름>`으로 튼다. gif·png·jpg·webp 클립은 `<img>`로, webm·mp4는 `<video>`로 보인다. 빈 칸은 대신 쓴다: 응원이 없으면 춤, 춤이 없으면 응원, 일정 알림이 없으면 춤(그것도 없으면 응원), 집중이 없으면 평소 그림 그대로다. 눈 감은 그림이 없으면 깜빡이지 않는다.

- `config.json`이 깨져 있으면 덮어쓰지 않고 409 `{ error }`(몇 번째 줄인지 담은 한 줄)를 준다. 파일을 쓰지 못하면 500.
- `config.json`에 원자적으로 합쳐 쓰고 메모리 설정도 바로 바꾼다. 데몬을 다시 켤 필요가 없다.
- 뇌가 바뀌면 SSE `status`를 보낸다.
- `onboarded`가 `false`인 동안(새 설치)은 브리핑·Slack 할 일·할 일 자동 완료·진행 확인·지식그래프·프로필 학습을 돌리지 않고 작업 기록·git 도 읽지 않는다. `true`가 되면 그때 첫 정리를 한 번 한다. 처음 `true`를 적을 때 빈 칸(`readSessions`·`repoRoots`·`brain.provider`)은 지금 쓰는 값으로 같이 적는다.
- `calendarAlert`가 바뀌면 알림 시각을 바로 다시 잡는다. 일정마다 알린 분을 `meeting_alerts`에 남기고(키 `id@start#분`), 이미 알린 분보다 작은 분만 남은 알림으로 본다. 그래서 설정을 바꿔도 이미 울린 알림은 다시 울리지 않는다.
- `character`가 바뀌면 다음 말풍선과 답부터 그 캐릭터 말투가 된다. 모델에 넣는 시스템 프롬프트의 첫 문장과 말투 줄, 고정 문구의 기본값, AI 없이 하는 정해진 말이 모두 바뀐다. 사용자가 「문구」에서 고친 줄은 캐릭터와 상관없이 그대로 쓴다. 앱은 SSE `state`로 그림·영상·앱 이름(「하치와레 비서」)을 바꾼다.
- 일정 알림 말풍선은 문구 `meeting_alert`(`{mins}` `{title}` `{time}` `{where}`)다. `{mins}`는 실제로 남은 분이다(늦게 켜졌으면 설정보다 작다). `{mins}`가 없는 예전 고친 문구도 그대로 쓴다.
- 커넥터(`connectors`)는 여기서 바꾸지 않는다. 파일을 고친 뒤 데몬을 다시 켜야 한다.

### 캐릭터 만들기·대사 고치기

설정 「캐릭터」가 쓴다(`agent/src/character-store.ts`). 쓰기(POST·PUT·DELETE)는 다른 쓰기처럼 `X-CY-Agent: 1` 헤더가 있어야 한다. 바뀌면 SSE `characters`를 보내고, 지금 캐릭터의 말투도 바로 바뀐다.

| | |
|---|---|
| `GET /characters` | `{ current, characters, slots, types, help, schema }`. `characters`는 기본 다섯(`builtin`, `defaults` 기본 대사, `override` 고친 칸 또는 `null`, `lines` 둘을 합친 것)과 사용자 캐릭터(`custom`, `from`, `media { 칸: 저장 이름 }`, `frames { 칸: 테두리 }`, `lines`)다. `schema`는 고칠 수 있는 칸 목록 `[{ path, kind: text\|list, vars, oneLine?, label? }]`, `help`는 `lines.json`의 `_help`다 |
| `POST /characters { name, from?, lines?, frames? }` | 새 캐릭터. `from`(기본 `shisa`)의 대사를 전부 복사하고 이름이 든 줄은 새 이름으로 바꾼다. `lines`를 주면 그 위에 덮는다(시사의 정해진 답처럼 앱에만 있는 칸). 201 `{ character }` |
| `GET /characters/:id` · `PUT /characters/:id` | 사용자 캐릭터는 `{ name?, lines?, frames? }`(`lines`는 통째로, `frames`는 준 칸만). 기본 캐릭터는 `{ lines }`만 받고 기본값과 다른 칸만 `overrides/<id>.json`에 남긴다 |
| `DELETE /characters/:id/lines` | 기본 캐릭터 대사를 기본값으로(덮어쓰기 파일을 지운다) |
| `DELETE /characters/:id` | 사용자 캐릭터를 폴더째 지운다. 지금 쓰던 캐릭터면 시사로 돌아가고 `config.json`도 고친다. 기본 캐릭터는 400 |
| `PUT /characters/:id/media/:slot` · `DELETE …` | 그림·영상 올리기(본문 = 파일 바이트, 이름은 `x-file-name`) · 빼기. 칸은 `eyes_open`·`eyes_closed`·`cheer`·`dance`(꼭 넣을 넷)와 `study`·`plan`(고를 둘) |

- 저장 위치는 사용자 데이터 폴더뿐이다. 사용자 캐릭터는 `~/.cy-agent/characters/<id>/character.json`과 올린 파일, 기본 캐릭터에서 고친 칸은 `~/.cy-agent/characters/overrides/<id>.json`이다. 레포와 앱 번들은 건드리지 않는다.
- id는 `u-` 뒤에 소문자·숫자를 붙여 새로 짓고, 기본 id와 겹치지 않는다.
- 받는 파일은 png·jpg·webp·gif·webm·mp4다. 이름이 아니라 파일 첫 바이트로 종류를 보고, 그 밖은 400이다. 저장 이름은 `<칸>-<무작위 8자>.<확장자>`로 새로 짓는다. 크기와 개수 상한은 없다.
- 테두리(둥근 네모 카드)는 칸마다 고른다. 고르지 않은 칸은 png·webm이면 끄고, 그 밖(배경이 있는 jpg·gif·mp4 등)은 켠다.
- 대사의 칸은 `lines.json`과 같다(`name`, `prompt`, `flair`, `phrases`, `local`, `cheer`, `canned`, `setup`, `overlay`, `tour`). 모르는 칸이나 그 칸에서 못 쓰는 자리표시(`{title}` 등)가 있으면 400이다. 정해진 답(`canned`)은 어느 칸에서나 `{next}` `{open}` `{done}` `{total}` `{rest}`를 쓸 수 있다.
- 모델 프롬프트에 들어가는 건 `prompt.intro`와 `prompt.tone` 두 칸뿐이고, 둘 다 한 줄로 다듬는다. 프롬프트의 시사 첫 문장·말투 줄 자리만 바꾸므로 그 밖의 규칙과 안전 지시는 그대로다.
- 앱은 `cy-asset`으로 사용자 캐릭터 파일을 줄 때 `GET /characters` 목록에 그 캐릭터의 그 파일이 있는지, 심볼릭 링크를 풀었을 때 그 캐릭터 폴더 안의 보통 파일인지 본다.

### `GET /connections` · `POST /connections/check { id? }`

- 설정의 「연결 상태」 줄이다. 응답은 `{ rows: ConnRow[], checkedAt }`.
- `ConnRow` 필드: `id`, `label`, `group: core|service|local`, `state: ok|warn|error|off|unknown`, `detail`, `error?`(가림), `check`, `pending?`, `doc?`, `used?`, `briefing?`.
- `check`는 `id`(`net|claude|gh|local`)만 다시 확인한다.

### 그 밖

| | |
|---|---|
| `GET /health` | `{ ok, mood, activity }` |
| `GET /models` | 고를 수 있는 모델 `{ choices: [{ id, label, role }], defaults: { fix, chat } }`. 요청의 `model`은 이 안의 id만 받는다(아니면 400) |
| `GET /commands` | 채팅 슬래시 명령 `{ commands: [{ name, description, argumentHint }] }` |
| `GET /repos` | 「새 작업」 레포 목록(`repoRoots` 아래) |
| `GET /guidelines` · `POST /guidelines` · `GET\|PUT\|DELETE /guidelines/:id` | 행동 지침(말투·답 모양·일하는 법) |
| `GET /permissions` · `POST /permissions/:id/delete` | [항상 허용]으로 저장한 도구 권한 규칙 |

## 대시보드·브리핑

- `GET /dashboard` → 200. 패널 전체 데이터다.
  - `generatedAt`, `briefing{at,bubble,replyMd}|null`, `commitsToday`
  - `projects[]`: `name`, `path`, `lastActive`, `sessions24h`, `lastTitle`, `lastPrompt`, `branch`, `commitsToday`, `recentCommits`, `hidden`
  - `todos[]`(아래), `recentDone[]`, `proposals[]`, `today{date,asked,items}`
  - `connectors[]{cap,label,mode,ready,detail,doc}`, `meetings[]{id,subject,start,end,link?}`, `todoRules[]`
  - `important[]{id,title,start,end,allDay}`: 이 Mac 캘린더 중 이름에 「중요」가 든 캘린더의 1년 안 일정(되풀이는 가장 가까운 한 번, 시작 순, 최대 50). 이 Mac 캘린더를 연결하지 않았으면 빈 배열. 개요 「중요 일정」 D-day 칸이 쓴다.
  - 미리알림 할 일 중 우선순위 「높음」(1~4)이거나 목록·제목에 「긴급」이 든 것은 `todos[].urgent{list,high}` 가 붙는다(「우사기 비서」 목록 제외). 개요 「긴급 미리알림」 칸이 쓴다.
  - `projects[]` 에는 연구 프로젝트에 속한 폴더에 `hiddenByResearch: true` 가 붙는다.
  - `researchProjects[]`: 연구 탭 목록. `key`(대표 폴더 키: 이 Mac 은 레포 루트 절대 경로, 서버는 `서버:/경로`), `kind`(`research`|`project`|null=후보), `name`, `folders[]{path,onMac?}`, `subs[]{venue,stage,deadline?,at}`, `url?`, `lastActive`, `running[]`(tmux 에서 도는 AI CLI 는 `ai`=도구 이름이 붙고 실험이 아니다), `recent{done,failed,lost,items}`(30일), `sessions[]{title,tool,at}`(30일 중 최근 5개, 작업 기록을 읽을 때만). 후보는 30일 안의 job, 지금 도는 tmux(AI CLI 제외), 30일 안의 세션 2개 이상 중 하나가 있는 폴더로 최대 8개, kind `none` 은 빠진다. 작업 폴더 `projects[]` 는 7일 창 그대로다.
  - `research.jobs[]` 와 `research.tmux[host].sessions[]` 에는 `label`(실험 이름), `project?`(속한 key), `ai?`(첫 단어가 claude·codex·agy·gemini·aider·cursor-agent·opencode 일 때 도구 이름)가 붙는다.
- `PUT /research/projects { key, kind?: research|project|none, name?: string|null, subs?: Submission[], url?: string|null, mergeInto?: string|null }` → 200 `{ok:true}` / 400 `{error}`. `x-cy-agent: 1` 헤더 필요. subs 는 통째로 바꾼다(at 없으면 지금). key ≤500자·name ≤80자·venue 1~60자 한 줄, stage 8종, deadline YYYY-MM-DD, subs ≤20, url http(s) ≤500자. 이미 합쳐진 폴더에는 합칠 수 없다.
- `GET /research/projects/rules?path=<폴더 키>` → `{agents: added|missing|absent, claude: added|imports|missing|absent}`. `POST /research/projects/rules {path}` → 같은 모양의 새 상태(400 `{error}`). 둘 다 `x-cy-agent: 1` 헤더 필요. path 는 지금 연구·프로젝트(kind research/project) folders[].path 중 하나여야 한다. 그 폴더의 AGENTS.md·CLAUDE.md 에 `usagi-run:v1` 표시가 붙은 규칙 글을 넣는다: 파일이 있고 표시가 없으면 끝에 덧붙이기(append)만, 없으면 새로 만들기(exclusive create: AGENTS.md 는 규칙 글, CLAUDE.md 는 `@AGENTS.md` 한 줄)만 한다. 기존 파일을 다시 쓰거나 자르지 않는다. 서버 폴더는 ssh BatchMode 한 번(상태 읽기도 한 번), 이 Mac 은 fs. 완료는 agents=added 이고 claude 가 added|imports 일 때.
- `POST /briefing` → 202. 지금 브리핑(오래 걸리니 기다리지 않는다).
- `POST /refresh` → 202. Slack 다시 훑기 → 새 할 일 → 브리핑.
- `POST /projects/hide|unhide { id: 경로 }` → 200 / 404. 숨긴 프로젝트는 집계·프롬프트에서 빠진다.

## 할 일

`todos[]` 항목 필드:
- `id`, `title`, `source`, `link?`, `priority: 1–4`(4 = 언젠가·백로그), `note?`, `description?`, `userEdited`
- `doing?`(사용자가 ▶로 정한 진행중), `progress?`·`progressAt?`(작업 세션에서 본 진척)
- `appliedRule?`, `doneBy?: user|auto|briefing`, `autoReason?`, `autoEvidence?`

화면에 「(진행중)」은 `doing`이 있으면 그 값으로, 없으면 `progress`가 있을 때 붙는다.

| | |
|---|---|
| `POST /todos { title, priority?, link?, note? }` | 201 `{ id }`(`user:<uuid>`) |
| `POST /todos/:id { title?, priority?, link?, note?, description?, status?: open\|done, doing?: boolean\|null }` | 200 `{ ok, todo }`. 사용자가 고친 필드는 브리핑이 덮지 않는다(`doing`은 예외) |
| `POST /todos/:id/done` | 완료 |
| `POST /todos/:id/delete` → `/restore` → `/purge`, `POST /todos/trash/empty` | 휴지통(30일 뒤 자동 비움) |
| `POST /todos/:id/revert` | 자동 완료 되돌리기. 409 = 자동 완료가 아님 |
| `POST /todos/reorder { id, priority, beforeId? }` | 그 우선순위 묶음의 `beforeId` 앞으로 옮김 |
| `GET /todos/:id/detail` | `{ description, source: { kind, ref, excerpt?, author?, at?, channel?, permalink?, repo?, sha?, title? } \| null, link }` |
| `GET /todos/:id/thread/last` | `{ todo: { id, title, status, priority }, threadId \| null }`. 없는/휴지통 할 일은 404 `{ trashed, threadId? }` |

### 할 일 규칙(`todo-rules.ts`)

- "앞으로 모든 X는 …" 같은 지속 지시는 규칙(`{ text, match{keywords?,sources?,titleRegex?}, effect{priority?,backlog?,skip?,note?} }`)이 된다.
- 새 할 일이 생기는 모든 경로에 모델 없이 적용된다. 사용자가 직접 정한 우선순위가 이긴다.
- 관련 엔드포인트:
  - `GET /todo-rules` → `{ rules }`
  - `POST /todo-rules/:id { enabled?, text? }`
  - `POST /todo-rules/:id/delete`

### 오늘 할 일

따로 표를 두지 않고 할 일에 "오늘로 고른 날"(`today`, KST `YYYY-MM-DD`)을 단다. 패널 할 일 맨 위 「오늘」 묶음에 그날 고른 것이 모인다. 이 맥의 SQLite에만 둔다.

- 새로 적기: `POST /todos { title, priority?, today: true }`
- 고르기·빼기: `POST /todos/:id { today: true | false | null }` (빼도 할 일은 남는다)
- `GET /dashboard` 의 `todos[].today`, `today: { date, asked, items: [{ id, title, done, priority, source }] }`
- 예전 `POST /today` 표 저장은 없다. 예전 표의 오늘 줄은 데몬이 켜질 때 할 일로 옮긴다
- 알림: 설정 `todayReminder: { mode: "auto" | "off", everyHours, times: ["HH:MM"] }` (`PUT /settings`, 바로 반영). 기본은 영업일 아침 첫 실행 때 한 번. 모델 없이 정해진 말로 알린다

### 집중하기

할 일 목록의 [집중하기]. 캐릭터가 공부 영상을 틀고 말풍선에 경과 시간을 보인다. 기록은 cy.db 의 `focus_sessions`(세션: 시작·끝·집중한 초)와 `focus_spans`(실제로 집중한 구간)에 둔다. 일시정지한 동안은 구간이 없으니 빠진다. 날짜는 이 맥의 로컬 시간 기준 하루이고, 자정을 넘긴 구간은 날마다 나눠 센다. 돌고 있는 구간은 30초마다 저장하고, 데몬이 꺼졌다 3분 안에 다시 켜지면 같은 세션을 이어 간다(꺼진 동안은 뺀다). 더 오래 꺼져 있었으면 마지막 저장 시각에 끝낸다. AI 연결과 무관하다.

- `GET /focus` → `FocusView`
- `POST /focus/start` · `/focus/pause` · `/focus/resume` · `/focus/stop` → `FocusView`(같은 걸 두 번 눌러도 안전). `stop`은 `stopped: { id, seconds } | null`도 주고, 1초 이상이면 「25분 집중했어요」 말풍선을 띄운다
- `GET /focus/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ from, to, days: [{ date, seconds, longest }], total }` (양끝 포함, 집중 중인 것은 지금까지. longest = 그날 일시정지 없이 가장 길게 이어서 집중한 초). `from > to`이거나 3660일보다 넓으면 400
- 맥이 잠들었다 깨서 마지막 저장에서 3분 넘게 지났으면, 돌던 구간을 마지막 저장 시각에 닫고 깬 때부터 새 구간을 연다(잠든 시간은 빠진다). `stop`의 초와 `today`는 둘 다 버림이라 서로 맞는다

```ts
type FocusView = {
  active: null | { id: string; startedAt: number; paused: boolean; baseMs: number; since: number | null; seconds: number };
  day: string; today: number; now: number; // today = 오늘 집중한 초(집중 중인 것 포함)
};
```

지금 경과 = `(baseMs + (since ? 지금 - since : 0)) / 1000`초.

## 채팅

### `POST /chat`

본문:
- `text`(필수)
- `threadId?`: 이어 말할 대화
- `todoId?`: 대화 대상 할 일
- `kind?: chat|hover`: 새 대화 종류. `hover`는 더블클릭 대화(threadId 없이 보내면 가장 최근의 보관 안 한 hover 대화에 이어 말하고, 없으면 새로 만든다)
- `parentRunId?`, `model?`, `clientId?`
- `attachments?`: `POST /chat/attachments`로 올린 id

응답은 202 `{ chatId, threadId, queued?, position? }`. 진행은 SSE `chat`으로 온다.
- `{ status: "step", step }`
- `{ status: "done", text, show? }`
- `{ status: "error", text }`

같은 대화 안에서는 차례로, 다른 대화끼리는 동시에 돈다.

| | |
|---|---|
| `GET /chat/threads?limit&before&archived=0\|1` · `POST /chat/threads { title?, kind?, todoId? }` | 대화 목록·새 대화 |
| `POST /chat/threads/:id { title?, archived? }` · `POST /chat/threads/:id/delete` | 이름·보관·삭제 |
| `GET /chat/threads/:id/messages?limit&before` | 대화 내용 |
| `GET /chat/threads/:id/agents` | `{ agents, sessions?, worktrees? }`: 대화 속 백그라운드 에이전트·작업 세션·워크트리 카드 |
| `POST /chat/agents/:toolUseId/stop` | 백그라운드 에이전트 멈추기 |
| `POST /chat/:chatId/stop` · `/now` · `/edit { text }` | 답하는 중 멈추기 · 줄 선 말 지금 보내기 · 줄 선 말 고치기 |
| `POST /chat/threads/:id/messages/:n/edit { text, stopAgents?, model? }` | 마지막 사용자 말 고쳐 그 턴을 다시 |
| `POST /chat/threads/:id/sync` | 터미널 Claude Code에서 이어 간 대화 불러오기 |
| `GET /chat/queue` | 대기·답하는 중인 말(패널을 다시 열어도 되살림) |
| `POST /chat/attachments`(본문 = 파일 바이트, `x-file-name`) → 201 `{ attachment }` · `GET /chat/attachments/:thread/:file` · `POST …/open` | 첨부(크기·개수 상한 없음) |

## 확인 카드·머지

- `GET /actions?status&threadId&limit` · `GET /actions/:id`: 쓰기 동작 확인 카드.
- `POST /actions/:id/confirm { always? }` · `POST /actions/:id/cancel`.
- 머지 승인은 PR까지 간 작업에 `merge` 스티커 + 「머지할까요?」로 온다.
  - `POST /proposals/:id/merge` → 200 `{ ok, state: "merged" }`, 409(이미 안 하기로 함), 500(실패, 다시 시도 가능)
  - `POST /proposals/:id/decline-merge` → 200 `{ ok, state: "declined" }`
  - `POST /proposals/:id/ask { text }` → 200 `{ ok, reply }`: 그 PR에 대해 한 번 묻기
- `autoMerge`에 있는 레포는 검사를 통과하면 ✓ 없이 머지한다.
- `POST /proposals/:id/approve|hold`: 수정 제안 승인·보류.

## 작업 세션(run): Claude Code 필요

데몬이 띄운 Agent SDK 세션 하나가 run 하나다.
- `kind`: `fix|briefing|chat|profile|kg|calendar|slack-ingest|todo-auto|action|other`
- `status`: `running|done|failed|stopped`
- 기록은 `cy.db`의 `runs`·`run_events`에 14일 동안 둔다. 비밀은 `«redacted»`로 가린다.

| | |
|---|---|
| `GET /runs?limit&status` · `GET /runs/:id?since=<seq>` | 목록 · 한 run 과 이벤트. `status` 없이 부르면 내 작업과 정기 작업을 따로 `limit`개씩 모아 주므로 최대 `limit`의 2배가 온다 |
| `POST /proposals { repo, text }` → 201 | 「새 작업」(승인 대기 제안) |
| `POST /runs/:id/message { text, model?, attachments?, clientId? }` | 돌고 있는 수정 run 의 다음 턴. 전달 대기 중이면 `{ msgId, pending: true }` |
| `POST /runs/:id/messages/:msgId/now\|cancel` | 대기 중인 말 지금 보내기·빼기 |
| `POST /runs/:id/interrupt` · `/stop` | 지금 턴 멈추기 · 세션 끝내기(커밋·푸시 안 함, 워크트리 정리) |
| `POST /runs/:id/continue { text, model? }` → 202 | 끝난 run 이어서 하기(수정 run → 연결된 새 수정 run) |
| `POST /runs/:id/btw { text }` | 곁질문. 그 run 기록만 보고 바로 답(끼어들지 않음) |
| `POST /runs/:id/sync { watch? }` · `POST /runs/import { sessionId }` | 터미널 Claude Code 세션 불러오기 |

수정 run의 안전장치:
- 워크트리(`cy/…` 브랜치)에서만 돈다.
- 에이전트의 git commit·push·merge와 gh pr merge·create는 훅이 막는다.
- 커밋·푸시·PR은 데몬이 하고, 테스트가 실패하면 커밋하지 않는다.

대화 에이전트의 하드 차단(`permissions.ts` `HARD_DENY`: 비밀 파일 읽기·데몬 API 직접 호출 등)은 따옴표 쪼개기·glob·루프백 다른 표기(127.1·2130706433·[::1] 등)까지 걷어 보고, `.env`·`~/.cy-agent`를 언급하는 셸 명령은 묻지 않고 허용하지 않고 승인 카드로 돌린다. 그래도 이 목록은 셸 명령을 글로 읽어 맞춰 보는 것이라 완벽한 방어선이 아니다. 비밀은 애초에 에이전트가 닿는 폴더에 두지 않는 편이 안전하다.

## 가짜 데몬

`desktop/scripts/fake-daemon.mjs`가 위 계약의 대부분을 데모 데이터로 흉내 낸다. 녹화용 데모(`npm run demo`)는 여기에 `scripts/demo-data.mjs`의 `/demo/*` 경로를 더해 쓴다.
