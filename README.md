# 우사기 비서 (usagi-agent)

화면 구석에 사는 작은 비서입니다. 캐릭터 「우사기」가 할 일, 회의, 브리핑을 말풍선으로 알려 주고, 캐릭터를 두 번 누르면 할 일·채팅·연구·작업 폴더를 모아 둔 패널이 열립니다. 대학원 연구 생활에 맞춰 서버 실험(usagi-run, tmux, GPU), 연구 노트(Tine 일지), Slack 지시사항을 한곳에서 볼 수 있습니다.
데이터는 이 맥의 `~/.cy-agent/`에 저장되고, AI 에게 묻는 글만 연결한 AI(Antigravity·Codex·Claude 등)로 갑니다([데이터와 개인정보](#데이터와-개인정보)). 맥 전용입니다.

이 레포는 [cheo0y/shisa-agent](https://github.com/cheo0y/shisa-agent)(「시사 비서」)에서 갈라져 나온 포크입니다. 자세한 것은 [원래 프로젝트와 라이선스](#원래-프로젝트와-라이선스)에 있습니다.

<p>
  <img src="assets/characters/usagi/eyes_open.png" width="140" alt="대기 중인 우사기">
  <img src="assets/characters/usagi/study.png" width="140" alt="집중하기: 필기구로 그림을 그리는 우사기">
  <img src="assets/characters/usagi/dance.png" width="140" alt="일정 알림: 선글라스를 쓰고 랩하는 우사기">
  <img src="assets/characters/usagi/cheer.png" width="140" alt="응원: 치타라를 들고 뛰는 우사기">
</p>

## 목차

- [설치와 업데이트](#설치와-업데이트)
- [처음 설정](#처음-설정)
- [화면별 기능](#화면별-기능)
- [연구 비서 기능](#연구-비서-기능)
- [연결할 수 있는 것](#연결할-수-있는-것)
- [설정 파일](#설정-파일-cy-agentconfigjson)
- [데이터와 개인정보](#데이터와-개인정보)
- [성능과 배터리](#성능과-배터리)
- [문제 해결](#문제-해결)
- [개발과 릴리스](#개발과-릴리스)
- [원래 프로젝트와 라이선스](#원래-프로젝트와-라이선스)

## 설치와 업데이트

### Homebrew (권장)

```sh
brew install --cask reo91004/tap/usagi-agent
brew upgrade --cask usagi-agent          # 업데이트
brew uninstall --cask usagi-agent        # 지우기 (할 일·설정은 남김)
brew uninstall --zap --cask usagi-agent  # ~/.cy-agent 까지 지움
```

cask가 `우사기.app`을 응용 프로그램 폴더에 넣고, 설치 뒤 격리 표시(quarantine)를 지워서 「그래도 열기」 없이 바로 열립니다. `usagi-run` 명령도 PATH에 연결합니다.

### dmg

[Releases](https://github.com/reo91004/usagi-agent/releases/latest)에서 `Usagi-<버전>-arm64.dmg`(애플 실리콘) 또는 `Usagi-<버전>-x64.dmg`(인텔)를 받아 dmg 안의 「우사기」를 「응용 프로그램」으로 끌어다 놓습니다. 새 버전은 같은 방법으로 덮어씁니다(먼저 메뉴 막대 아이콘에서 끄기).

애플 공증을 받지 않은 앱이라 dmg로 받으면 처음 한 번 「시스템 설정 → 개인정보 보호 및 보안 → 보안」에서 「그래도 열기」를 눌러야 합니다. 한 번 허용하면 다음부터 바로 열립니다. 앱은 자체 서명 인증서(「Usagi Code Signing」)로 서명되어 있어서, 같은 인증서로 낸 새 버전에서는 캘린더·미리알림 같은 macOS 허락이 풀리지 않습니다([docs/release.md](docs/release.md#업데이트해도-macos-허락이-남게-하는-서명-인증서)).

### 새 버전 알림

하루 한 번 GitHub(`api.github.com`)에서 최신 릴리스 번호를 읽고, 새 버전이 있으면 캐릭터가 말풍선으로 알려 줍니다. 내 데이터는 보내지 않고, 설정의 「이 앱」에서 끌 수 있습니다. 자동 업데이트는 하지 않으니 `brew upgrade`나 dmg로 직접 올립니다.

### 지우기

1. 설정 「이 앱」에서 「로그인할 때 우사기 켜기」를 끄고, 메뉴 막대 아이콘에서 끕니다.
2. `brew uninstall --cask usagi-agent` 또는 응용 프로그램 폴더의 우사기를 휴지통으로 옮깁니다.
3. 데이터까지 지우려면 `~/.cy-agent`(할 일, 대화, 설정, 기록)와 `~/Library/Application Support/cy-agent-desktop`(창 위치 같은 앱 설정)을 지웁니다.

### 터미널로 설치 (개발자용)

레포를 받아 `ops/install.sh`로 설치하면 데몬과 앱이 launchd에 등록됩니다(앱은 `~/Applications/cy.app`). 업데이트는 `./ops/update.sh`, 삭제는 `./ops/uninstall.sh`입니다. dmg나 Homebrew로 설치한 앱과 함께 쓰지 말고 하나만 고릅니다. Node.js 24 이상과 git이 필요합니다.

```sh
git clone https://github.com/reo91004/usagi-agent.git ~/usagi-agent && cd ~/usagi-agent && ./ops/install.sh
```

## 처음 설정

앱이 처음 뜨면 캐릭터가 화면 오른쪽 아래에 나타나고 패널의 연결 도우미가 열립니다. 건너뛰어도 되고, 나중에 패널 위쪽 「연결 도우미」 단추나 메뉴 막대의 「사용법 다시 보기」로 다시 열 수 있습니다. 마법사를 마칠 때까지는 작업 기록·레포를 읽지 않고 모델도 부르지 않습니다.

1. 이름: 뭐라고 부를지 정합니다.
2. AI 고르기(선택): 이 맥에 로그인된 Antigravity(agy), Codex, Claude Code가 있으면 「찾았어요」로 떠서 바로 고릅니다. Gemini·OpenAI·Claude API·Genspark 키를 붙여 넣어도 됩니다. 「AI 없이 쓰기」도 됩니다.
3. 더 연결하기: 이 Mac의 캘린더·미리알림(macOS 허락 한 번), 구글·Outlook 캘린더 ICS 주소, Slack(읽기 전용 앱의 사용자 토큰), 레포 폴더, 이 맥의 Claude Code·Codex 작업 기록 읽기.
4. 끝: 「사용법 둘러보기」로 캐릭터가 사용법을 장면별로 보여 줍니다.

마법사를 마치면 로그인할 때 우사기가 자동으로 켜집니다(설정 「이 앱」에서 끔). 캘린더와 Slack 연결을 바꾸면 앱이 데몬을 잠깐 껐다 켜서 반영합니다.

## 화면별 기능

### 캐릭터와 말풍선

| 동작 | 결과 |
|---|---|
| 한 번 클릭 | 그 자리에 말 걸기 입력창이 열립니다. AI가 없으면 「지금 할 일 뭐 있어요?」 같은 질문 칩이 뜨고 AI 없이 바로 답합니다 |
| 두 번 클릭 | 패널이 열립니다(집중하기 중이면 작업 세션 창) |
| 오른쪽 클릭 | 메뉴: 패널 열기, 작업 세션 열기, 지금 브리핑, 설정, 사용법 다시 보기, 말풍선 숨기기, 가장자리에 숨기, 캐릭터 숨기기, 끄기(메뉴 막대 아이콘도 같은 메뉴) |
| 끌기 | 화면 어디로든 옮깁니다 |

캐릭터가 작업 화면을 가리면 메뉴의 「가장자리에 숨기」를 켭니다. 캐릭터가 가장 가까운 왼쪽·오른쪽·아래 가장자리에 붙고, 할 말이 없을 때는 귀만 내밀고 들어가 있습니다. 말풍선이 뜨거나 귀에 마우스를 잠깐 올리면 나오고, 끝나면 다시 들어갑니다. 다른 가장자리로 옮기려면 끌어다 놓습니다. 「캐릭터 숨기기」는 캐릭터를 아예 감추고, 다음에 켤 때도 숨긴 채로 둡니다.

입력창에는 📎(파일 붙이기), ＋(정해진 답: 응원·춤·오늘 할 일), 그리고 빠른 단추 ⏱(집중하기 시작), ☑(할 일 열기), ▤(패널 열기)가 있습니다. 알림 말풍선은 종류(브리핑, 일정, 실험 끝, 승인 요청, 새 버전)에 따라 누르면 해당 화면으로 갑니다. 일정 알림은 캐릭터가 춤추며 알려 주고, 실험이 성공하면 응원합니다.

### 패널

패널은 사이드바(개요, 할 일, 채팅, 연구, 작업 폴더, 맨 아래 설정)와 위쪽 단추(▶ 집중하기, 연결 도우미, 작업 세션, 새로고침, 닫기)로 이루어집니다. 패널이 열려 있는 동안은 Dock과 ⌘Tab에도 나타납니다. 단축키는 ⌘0(패널), ⌘,(설정), ⌘⇧S(작업 세션), ⌘⇧D(도움 보내기), ⌘W(창 닫기), Esc(패널 닫기)입니다.

| 화면 | 내용 |
|---|---|
| 개요 | 오늘 일정, 이번 주 할 일, 오늘 집중, 대기 중 제안, 연구 한 줄 요약, 오늘 할 일 요약, 최근 브리핑과 「지금 브리핑」, 제안(코드 고치기 PR 상태), 항상 허용한 도구 목록(지우면 다시 묻습니다) |
| 할 일 | 아래 설명 |
| 채팅 | 왼쪽 대화 목록(검색, 보관함, 이름 바꾸기, ⌘N 새 대화)과 오른쪽 대화. 파일 붙이기, 이번 메시지 모델 고르기, 슬래시 명령 자동완성, 승인 카드, 돌고 있는 에이전트 표시. AI가 없으면 ＋ 버튼의 정해진 답으로 짧게 주고받습니다 |
| 연구 | 서버 실험, tmux, GPU, 오늘 연구 노트, Slack 지시사항([연구 비서 기능](#연구-비서-기능)) |
| 작업 폴더 | Claude Code·Codex로 작업한 폴더(최근 7일, 이 Mac이나 ssh 서버)와 커밋이 있는 레포. 칩으로 출처(이 Mac 또는 서버 이름)를 구분하고, 줄을 누르면 마지막 요청과 최근 커밋이 펼쳐집니다. 단추는 `VS Code`(서버 폴더는 Remote-SSH), `Finder`(이 Mac만), `숨기기`입니다. 숨긴 폴더는 집계와 AI 맥락에서도 빠집니다 |
| 설정 | 안쪽 탭: AI, 캐릭터, 알림, 연결, 작업 규칙, 이 앱 |

할 일 화면:

- 맨 위 「오늘」(내가 오늘 하려고 고른 일, 줄의 「오늘」 단추로 고름)과 우선순위 묶음 「오늘 꼭」(오늘 마감이거나 중요), 「이번 주」(일주일 안 마감), 「나중에」(마감이 멀거나 없음), 「언젠가」(규칙으로 미뤄 둔 일, 접힘)가 있습니다. 묶음 옆에 기준이 한 줄로 보이고, 줄의 출처(Slack, 커밋, 메일, 작업 세션, 일정, 이슈, 미리알림, 직접 추가)가 색 칩으로, 미리알림 날짜가 「10/21」·「오늘 14:00」 같은 칩으로 보입니다.
- 한 번 누르면 설명과 원본(Slack 메시지, 커밋, 메일, 세션)이 펼쳐지고, 두 번 누르면(또는 Shift+Enter) 제목·설명을 그 자리에서 고칩니다. 꾹 눌러 끌면 순서와 우선순위가 바뀌고, Alt+↑↓나 Alt+1~4로도 옮깁니다. ▶는 「(진행중)」 표시(캐릭터 머리 위에도 보임)입니다.
- 지운 할 일은 휴지통에 30일 남고 되살릴 수 있습니다(⌘Z로 방금 지운 것 되돌리기). 「규칙」 칩에서 "앞으로 세미나는 언젠가로"처럼 말해 둔 할 일 규칙을 켜고 끄고 지웁니다.
- 연결해 둔 Slack·캘린더·메일·이슈, 미리알림, 내 Claude Code·Codex 작업 기록에서 할 일을 모읍니다. 끝난 일은 작업 세션을 보고 자동 완료로 표시하고(되돌릴 수 있음) 하는 중인 일에는 진척을 한 줄 붙입니다(Codex·agy·Claude Code 중 하나가 있을 때).

집중하기는 패널 위쪽의 「▶ 집중하기」(또는 말 걸기 입력창의 ⏱)로 시작합니다. 캐릭터가 공부하는 모습으로 바뀌고 머리 위 말풍선에 시간이 흐르며, 일시정지·그만하기가 있습니다. 쉰 시간은 빼고 셉니다. 할 일 맨 아래 「오늘 집중」을 누르면 주·월 기록(잔디 모양, 날짜별 총 집중과 가장 길게 이어 간 시간)이 나옵니다. AI 없이도 됩니다.

설정 탭:

| 탭 | 내용 |
|---|---|
| AI | 연결된 AI(끊기), 단순 채팅 AI·모델, AI 우선순위(순서 바꾸기, 앞의 AI가 소진되면 자동으로 다음 AI), AI 더 연결하기, 코딩 작업 모델, Claude Code 세부 모델, 말투, 정해진 말 |
| 캐릭터 | 시사·하치와레·랏코·모몽가·우사기 고르기, 새 캐릭터 만들기, 대사 고치기(✎), 문구 고치기 |
| 알림 | 오늘 할 일 알림(N시간마다·정한 시각·끄기), 일정 알림(몇 분 전, 여러 번, 끄기) |
| 연결 | 연결 상태(모두 다시 확인), 기능별 연결과 연결 해제, 브리핑에 넣을 출처, 이 맥에서 읽는 것(작업 기록 읽기, 레포 폴더) |
| 작업 규칙 | 자동 머지 레포, 행동 지침(말투·답 모양·일하는 법, 대화·브리핑·코드 작업 프롬프트에 붙음) |
| 이 앱 | 버전, 로그인할 때 켜기, 새 버전 알림, Dock에 항상 보이기, 사용법 다시 보기 |

캐릭터를 바꾸면 그림, 영상, 말투, 앱 이름(「우사기 비서」, 「하치와레 비서」 등)이 같이 바뀝니다. 우사기 자산은 참고 자료를 바탕으로 만든 생성 팬 아트이며 공식 영상·음원은 없습니다([그림·대사·출처](docs/usagi-character.md), [원본과 재생성 방법](artwork/usagi/README.md)). 만든 캐릭터는 `~/.cy-agent/characters/`에 저장됩니다.

## 연구 비서 기능

### 서버 실험: usagi-run, tmux, GPU

긴 실험 앞에 `usagi-run`을 붙이면 끝났을 때 걸린 시간과 성공 여부를 말풍선으로 알려 줍니다.

```sh
usagi-run -n "resnet 학습" -- python train.py --epochs 100
usagi-run --pid 41237        # 이미 돌고 있는 프로세스가 끝날 때까지 지켜보기(종료 코드는 모름)
```

종료 코드가 0이면 응원하고, 아니면 종료 코드를 알려 줍니다. 명령의 종료 코드를 그대로 돌려주니 스크립트에서도 씁니다. Homebrew와 dmg 설치에서는 `우사기.app/Contents/Resources/bin/usagi-run`에 들어 있고(Homebrew는 PATH에도 연결), 터미널 설치는 `~/.local/bin/usagi-run`입니다.

서버에서는 `usagi-run` 파일 하나만 복사하면 됩니다(sh와 curl만 씁니다). 서버에는 우사기가 없으니, 끝나면 서버의 `~/.usagi-agent/jobs/`에 결과 파일이 남고, 맥의 우사기가 `config.json`에 적힌 서버를 2분마다 ssh로 읽어 알려 주고 읽은 파일은 지웁니다. 도는 동안은 `<id>.running` 표시가 있어서 지금 돌고 있는 실험을 알고, 표시만 남고 프로세스가 사라지면 「끊김」으로 봅니다. 끝날 때 작업 폴더, 명령, 실행 중 바뀐 파일(최근 8개, 깊이 3)도 남깁니다.

```sh
scp "$(command -v usagi-run)" gpu1:~/.local/bin/
ssh gpu1 && tmux new -s exp
usagi-run -n "resnet 학습" -- python train.py
```

```json
{ "sshHosts": ["pacl-reo", "pacl-205", "pacl-208"],
  "jobDirs": { "pacl-205": "~/reo/.usagi-agent/jobs", "pacl-208": "~/reo/.usagi-agent/jobs" } }
```

- `sshHosts`: `~/.ssh/config` 별칭이나 `user@host`. 키 인증이어야 합니다(`BatchMode=yes`). OTP 서버는 `ControlMaster`·`ControlPersist`로 연결을 열어 두세요. 서버에서 맥으로 들어오는 포트는 열지 않고, 맥을 덮어 두거나 ssh를 끊어도 결과 파일이 남아 다시 연결될 때 알려 줍니다.
- 혼자 쓰는 계정은 위처럼 `~/.local/bin`에 두면 되고 `jobDirs`가 필요 없습니다. 여러 사람이 한 계정을 쓰는 서버(예: pacl-205, pacl-208)는 내 폴더(예: `~/reo/bin/usagi-run`)에 두세요. `usagi-run`은 자기 위 폴더에 `.usagi-agent`가 있으면 거기에 결과를 남기고, `jobDirs`에 그 폴더를 적어 둡니다. 다른 사람의 결과를 가져오거나 지우는 일을 막으려는 것입니다. 파일 권한으로 막히지는 않으니 결과 파일에는 폴더·명령·바뀐 파일 이름만 들어 있다는 점을 알아 두세요.
- `jobHosts`는 같은 일을 하는 예전 이름이고 `sshHosts`의 서버도 자동으로 포함됩니다. 바꾼 값은 데몬을 다시 켜면 적용됩니다.

연구 탭에는 서버별로 다음이 보입니다.

| 항목 | 내용 |
|---|---|
| usagi-run 기록 | 도는 중, 끝, 실패(종료 코드), 끊김 칩과 이름 @서버, 시간, 바뀐 파일. 줄마다 「물어보기」(새 대화에 질문을 채워 줌)와 「기록 지우기」(우사기에서만 지움) |
| tmux | 내 tmux 세션의 「도는 중」·「쉬는 중」. 위의 2분 ssh 확인에 같이 실려 오고 따로 접속하지 않습니다. 여러 사람이 쓰는 서버(`jobDirs` 설정)는 내 폴더에서 연 세션만 보입니다 |
| GPU | 「GPU 보기」를 누를 때만 서버에 묻습니다. 사용률 막대, 메모리, 온도, 돌고 있는 프로세스 |

우사기에게 채팅으로 서버의 폴더·파일·로그·GPU를 물을 수도 있습니다(읽기만, 접속은 물어볼 때만, 키·토큰·`.env`·`~/.ssh` 같은 비밀 파일과 바이너리는 열지 않음, 서버는 GNU 리눅스를 가정). 서버에서 쓴 Claude Code·Codex 기록은 `sessionHosts`에 적으면 10분마다 늘어난 부분만 받아 이 맥의 기록과 합칩니다. 혼자 쓰는 계정의 서버만 적으세요(공용 계정에는 다른 사람의 기록이 있습니다). 받아 둔 기록은 `~/.cy-agent/remote-sessions/<서버>/`에 있고 「작업 기록 읽기」를 켠 경우에만 받습니다.

### 연구 노트: Tine 일지

그날 한 일을 Tine(Logseq 형식) 그래프의 그날 일지에 「오늘 한 일」 블록 하나로 남깁니다. `config.json`에 그래프 폴더를 적고 데몬을 다시 켜면 됩니다.

```json
{ "tineGraph": "~/Library/Mobile Documents/com~apple~CloudDocs/PKM" }
```

- 블록은 업무 보고처럼 요약, 실험, 작업(레포별), 일정, 할 일(완료·불필요로 종료·신규), 향후 계획 순으로 개조식으로 씁니다. 재료는 실험(`usagi-run`의 서버·명령·시간·종료 코드), 작업 세션의 요청과 마지막 답, `repoRoots`의 내 커밋, 일정, 할 일, 집중 시간입니다. 파일 이름이나 턴 수는 싣지 않습니다.
- AI가 있으면 이 재료로 「무엇을 돌려 어떤 결과가 나왔는지」를 한 줄씩 정리합니다(예: 「Qwen2.5-1.5B shift119 lane 실행 직후 종료 코드 1로 실패, 원인 확인 필요」). 기록에 없는 사실은 쓰지 않게 했고, 세션 글의 토큰 같은 비밀값은 가린 뒤 넘깁니다. AI가 없거나 아직 정리하기 전이면 기록을 그대로 짧게 씁니다.
- AI는 그날 재료가 바뀌었을 때만 부르고, 오늘 것은 3시간에 한 번까지, 지난날은 하루가 끝난 뒤 한 번만 부릅니다(보통 하루 몇 번, 연결 도우미를 마친 뒤에만). 정리한 문장은 `cy.db`에 날짜마다 몇 KB로 둡니다.
- 한 시간마다 오늘과 어제 일지의 블록을 다시 쓰고, 바뀐 게 있을 때만 씁니다. 한 일이 없는 날은 일지를 만들지 않습니다. 우사기는 이 블록만 다시 쓰고 일지의 나머지는 건드리지 않습니다. 블록을 직접 고치거나 지우면 그 날짜에는 더 이상 고쳐 쓰거나 다시 넣지 않습니다.
- 패널 연구 탭의 「오늘 연구 노트」에서 열기와 어제 요약을 볼 수 있습니다.

### Slack 지시사항

Slack을 읽기 전용으로 연결하면([docs/connect/slack.md](docs/connect/slack.md)) 연구 탭의 「지시사항」에서 지시를 줄 사람(교수님, 선배)을 고릅니다. 그 사람이 나에게 보낸 DM, 나를 멘션한 글, 내가 들어간 채널에 쓴 글이 따로 모이고, 지시마다 「할 일로」나 「괜찮아요」를 정합니다. 채팅에서 채널 목록과 채널 글도 물어볼 수 있습니다(수집해 둔 글 기준).

### AI 우선순위와 자동 전환

AI를 둘 이상 연결하면 설정 「AI」 탭의 「AI 우선순위」에서 순서를 정합니다(예: Antigravity, Codex, Claude Code 순). 앞의 AI가 사용량, 크레딧, 한도를 다 쓰거나 로그인이 풀리면 다음 AI가 같은 일을 이어서 하고, 말풍선으로 한 번 알립니다. 자세한 규칙은 [brain.md](docs/connect/brain.md#우선순위와-자동-전환)에 있습니다.

### 코드 고치기와 작업 세션

Claude Code, Codex, Antigravity 중 하나가 있으면 `repoRoots` 안의 레포 코드를 고쳐 달라고 시킬 수 있습니다. 별도 워크트리와 `cy/…` 브랜치에서 고치고 테스트가 통과하면 푸시와 PR까지 하고 「머지할까요?」 하고 묻습니다(✓로 머지, `autoMerge` 레포는 묻지 않음). 작업은 「작업 세션」 창(⌘⇧S)에서 도구 실행 기록을 보고, 「새 작업」, 「이어서 하기」, 「지금 보내기」를 할 수 있습니다. 워크트리와 백그라운드 에이전트는 Claude Code로만 돕니다. 안전 제한은 [데이터와 개인정보](#데이터와-개인정보)에 있습니다.

## 연결할 수 있는 것

AI는 선택입니다. AI 없이도 할 일, 집중하기, 일정 알림, 미리알림, 실험 끝 알림, 연구 노트, 정해진 말은 됩니다. 아래 표는 AI별로 되는 것입니다.

| 기능 | AI 없음 | API 키(Gemini, OpenAI, Claude API, Genspark) | Codex, Antigravity(agy) | Claude Code |
|---|:-:|:-:|:-:|:-:|
| 캐릭터·패널, 할 일, 집중하기, 일정 알림, 미리알림, usagi-run, 연구 노트, 정해진 말 | ✓ | ✓ | ✓ | ✓ |
| 말 걸기, 패널 채팅, 브리핑 요약 | | ✓ | ✓ | ✓ |
| 끝난 할 일 자동 완료·진척, 지식그래프, 프로필 학습(뒤에서 도는 기능) | | ✓ | ✓ | ✓ |
| 서버·Slack·할 일 같은 읽기 도구를 채팅에서 부르기 | | ✓(Genspark 제외) | ✓ | ✓ |
| 코드 고치기, 작업 세션, 자동 머지 | | | ✓ | ✓ |
| mcp 모드 연결(메일·이슈 등) 읽기 | | | 채팅·브리핑(읽기만), 캘린더 MCP 동기화는 Codex 만 | ✓ |
| 워크트리, 백그라운드 에이전트 | | | 채팅에서 「뒤에서 따로 해 줘」로 자기 워크트리에서 하나씩(서브에이전트 없음). agy 는 쓰기 허락 옵션이 없어 확인 전 | ✓ |
| 터미널에서 이어 간 대화 불러오기 | | | Codex 만(세션 창에서 터미널 Codex 로 이어 하기 포함) | ✓ |

AI 준비(모두 선택):

- Antigravity(agy): Google Antigravity CLI를 설치하고 터미널에서 `agy`로 로그인합니다. `agy models`에 모델 목록이 나오면 됩니다.
- Codex: [Codex CLI 안내](https://developers.openai.com/codex)대로 설치하고 로그인합니다.
- Claude Code: `curl -fsSL https://claude.ai/install.sh | bash` 후 `claude`로 로그인합니다. 기능이 가장 많습니다.
- API 키: 연결 도우미나 설정에 붙여 넣으면 맞는 키인지 바로 확인합니다.

AI별 차이와 모델은 [docs/connect/brain.md](docs/connect/brain.md)에 있습니다.

기능마다 어디서 읽어 올지는 `config.json`의 `connectors`에서 정합니다. `api`는 앱이 직접 읽고(모델 비용 없음), `mcp`는 Claude Code에 등록한 MCP 서버로 읽고, `off`는 쓰지 않습니다. 모두 읽기만 하며 메일 보내기, Slack 글쓰기, 일정 바꾸기 같은 쓰기 도구는 막아 두었습니다.

| 기능 | 추천 | 안내 |
|---|---|---|
| 캘린더 | 이 Mac 캘린더(EventKit)나 비공개 ICS 주소(`api`) | [calendar.md](docs/connect/calendar.md) |
| 미리알림 | 이 Mac 미리알림을 할 일로(EventKit, 10분마다·새로고침 때). 켜면 양방향으로 맞춤 | [calendar.md](docs/connect/calendar.md) |
| Slack | 내 Slack 앱의 읽기 전용 사용자 토큰(`api`) | [slack.md](docs/connect/slack.md) |
| 메일 | `mcp`(Gmail, Microsoft 365) 또는 `off` | [mail.md](docs/connect/mail.md) |
| 이슈 | `mcp`(GitHub, Jira, Linear) | [issues.md](docs/connect/issues.md) |
| 그 밖의 읽기용 MCP(노션 등) | `allowMcp`에 서버 이름 | [more-mcp.md](docs/connect/more-mcp.md) |
| 서버 | `sshHosts`, `jobDirs`, `sessionHosts` | [연구 비서 기능](#연구-비서-기능) |
| 연구 노트 | `tineGraph` | [연구 노트](#연구-노트-tine-일지) |

이 Mac의 캘린더·미리알림은 연결 도우미 「더 연결하기」에서 「연결하기」를 누르면 macOS가 허락을 한 번 묻습니다. 일정은 30분마다 다시 읽고, 메모 본문은 가져오지 않고 회의 링크(Meet, Zoom, Teams, Webex)만 뽑습니다. 안 끝난 미리알림은 날짜가 있으면 날짜로(오늘까지 「오늘 꼭」, 7일 안 「이번 주」, 그 뒤 「나중에」), 날짜가 없으면 「높음」·「보통」은 「이번 주」로 들어옵니다. 미리알림 앱에서 고친 제목·날짜도 따라오고, 끝내면 우사기에서도 끝납니다. 같은 칸의 「미리알림과 양방향으로 맞추기」를 켜면 우사기 할 일도 미리알림 「우사기 비서」 목록에 들어가고, 어느 쪽에서 끝내거나 제목·마감을 고쳐도 다른 쪽이 따라가고, 미리알림에서 지우면 우사기 휴지통으로 갑니다. 우사기에서 지우면 미리알림은 끝냄으로 바뀝니다(끄면 우사기에서 끝내거나 지워도 미리알림은 그대로). 허락을 거절했다면 시스템 설정 → 개인정보 보호 및 보안 → 캘린더·미리알림에서 켭니다.

## 설정 파일 (`~/.cy-agent/config.json`)

값은 환경변수, `config.json`, 기본값 순으로 적용됩니다. 설정 화면과 마법사에서 바꾼 값도 이 파일에 저장되고, 뇌·이름·레포 폴더·모델·알림·문구·자동 머지는 바로 적용됩니다. 그 밖의 키를 파일에서 고쳤다면 데몬을 다시 켭니다(`launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon`, 앱 설치는 앱을 껐다 켜도 됩니다). 전체 예시는 [ops/config.example.json](ops/config.example.json)입니다.

| 키 | 환경변수 | 기본값 | 설명 |
|---|---|---|---|
| `onboarded` | | 새 설치 `false` | `false`인 동안 모델 작업, 작업 기록, 레포 읽기를 하지 않습니다 |
| `readSessions` | | 새 설치 `false` | 이 맥의 Claude Code·Codex 작업 기록(`~/.claude/projects`, `~/.codex/sessions`) 읽기 |
| `character` | | `usagi` | 캐릭터 id |
| `brain.provider` | `CY_AGENT_BRAIN` | 새 설치 `local` | `claude-code`, `codex`, `agy`, `gemini`, `openai`, `anthropic`, `genspark`, `local`(AI 없음) |
| `brain.fallback` | | `[]` | 첫 AI 다음에 이어 쓸 AI 순서 `[{ "provider": "codex" }]` |
| `brain.geminiApiKey` 등 | `CY_AGENT_GEMINI_API_KEY`, `CY_AGENT_OPENAI_API_KEY`, `CY_AGENT_ANTHROPIC_API_KEY`, `CY_AGENT_GENSPARK_API_KEY` | | API 키. `ANTHROPIC_API_KEY`는 Claude Code도 쓰는 이름이라 일부러 읽지 않습니다 |
| `models.quick` / `general` / `code` / `light` | `CY_AGENT_MODEL_QUICK` 등 | | 말 걸기 / 브리핑·채팅 / 코드 고치기 / 가벼운 일 모델 |
| `user.name`, `user.aliases` | `CY_AGENT_USER_NAME` | git `user.name` | 부를 이름과 「나」로 볼 이름들 |
| `repoRoots` | | 새 설치 `[]` | 코드를 고쳐도 되는 레포 폴더. 개요의 내 커밋도 이 폴더에서만 읽습니다 |
| `sshHosts`, `jobHosts`, `jobDirs`, `sessionHosts` | | `[]`, `[]`, `{}`, `[]` | [서버 실험](#서버-실험-usagi-run-tmux-gpu) |
| `tineGraph` | | | [연구 노트](#연구-노트-tine-일지) |
| `appleReminders` | | `false` | 이 Mac 미리알림을 할 일로 |
| `remindersTwoWay` | | `false` | 미리알림과 할 일을 양방향으로 맞춤(`appleReminders` 가 켜져 있을 때만) |
| `connectors.<기능>` | `CY_AGENT_SLACK_USER_TOKEN`, `CY_AGENT_CALENDAR_ICS_URL` | 전부 `off` | `slack`, `calendar`, `mail`, `issues` |
| `directiveFrom` | | `[]` | 지시를 줄 사람의 Slack id(연구 탭에서 고름) |
| `allowMcp` | | `[]` | 커넥터 밖에서 채팅이 써도 되는 MCP 서버 이름(Claude Code 뇌일 때만) |
| `autoMerge` | | `[]` | 묻지 않고 머지할 레포(`owner/name`) |
| `briefing.exclude` | | `[]` | 브리핑에서 뺄 출처(`mail`, `calendar`, `slack`, `issues`, `sessions`) |
| `calendarAlert.minutesBefore` | | `[10]` | 일정 몇 분 전에 알릴지, `[]`이면 끔 |
| `todayReminder` | | 영업일 아침 | 오늘 할 일 알림 |
| `phrases` | | | 캐릭터가 하는 정해진 말 |
| `gitAuthor` | `CY_AGENT_GIT_NAME`, `CY_AGENT_GIT_EMAIL` | `git config --global` | 「내 커밋」 판정과 자동 수정 커밋 작성자 |
| `briefingIntervalMin`, `ingestIntervalMin`, `slackIngestIntervalMin`, `progressCheckMin` | | 60, 10, 5, 5 | 주기(분). `progressCheckMin: 0`이면 할 일 진행 확인을 끔 |
| `port` | `CY_AGENT_PORT` | `47823` | 데몬과 앱이 주고받는 로컬 포트 |
| | `CY_AGENT_HOME` | `~/.cy-agent` | 데이터 폴더 |

앱의 Dock 표시, 로그인 시 켜기, 새 버전 알림은 `config.json`이 아니라 앱 설정(`~/Library/Application Support/cy-agent-desktop/state.json`)에 저장됩니다.

## 데이터와 개인정보

| 무엇 | 어디 |
|---|---|
| 할 일, 대화, 지식그래프, 수집한 메시지·세션 기록, 연구 노트 재료 | `~/.cy-agent/cy.db` |
| 설정, 토큰, API 키, ICS 주소 | `~/.cy-agent/config.json`(권한 600, 평문) |
| 로그 | `~/.cy-agent/logs/` |
| ssh 서버에서 받은 작업 기록 | `~/.cy-agent/remote-sessions/` |
| 만든 캐릭터와 고친 대사 | `~/.cy-agent/characters/` |
| 서버 접속 재사용 소켓 | `~/.cy-agent/ssh/` |
| 창 위치, Dock·로그인 설정 | `~/Library/Application Support/cy-agent-desktop/` |
| 연구 노트 | 내 Tine 그래프의 그날 일지(`tineGraph`) |

레포에는 데이터가 들어가지 않습니다. 키와 ICS 주소는 로그와 오류 메시지에 남기지 않습니다.

맥 밖으로 나가는 것은 다음뿐입니다.

- 고른 AI(Antigravity·Codex·Claude Code CLI 나 Anthropic·OpenAI·Google·Genspark API)에 브리핑과 대화에 필요한 글. AI 없이 쓰면 없습니다.
- 연결한 서비스(Slack, ICS 캘린더, MCP 서버)에 대한 읽기 요청, `sshHosts`에 적은 서버로의 ssh.
- 하루 한 번 GitHub에 최신 버전 번호를 묻는 요청(내 데이터 없음, 끌 수 있음).

로컬 서버는 `127.0.0.1`에서만 열리고, 전용 헤더가 없는 쓰기 요청은 거절합니다. 브리핑과 대화는 읽기 전용이며 커넥터의 쓰기 도구는 훅에서 막습니다(`agent/src/guard.ts`). ssh 서버 접근은 우사기가 정한 읽기 명령만 보냅니다.

코드 고치기의 제한입니다.

- `repoRoots` 안의 git 레포에서, 별도 워크트리와 `cy/…` 브랜치에서만 작업합니다.
- 에이전트가 직접 커밋·푸시·머지하지 못하고, 테스트가 통과했을 때만 데몬이 커밋합니다. 머지는 ✓를 눌러야 하며 `autoMerge`의 레포만 예외입니다. 채팅에서 "머지해"라고 직접 말하면 확인 카드 없이 머지합니다.
- 고치라고 시키면 워크트리 안에서는 파일 수정과 셸 명령이 하나하나 묻지 않고 실행되고, 테스트가 통과하면 브랜치를 푸시하고 PR까지 엽니다.
- Codex는 Codex 샌드박스(워크트리만 쓰기, 네트워크 끔)로, agy는 agy 샌드박스와 훅으로 막고 돕니다(자세한 것은 [brain.md](docs/connect/brain.md)).

## 성능과 배터리

저장소에 측정해 둔 대기 시 CPU·메모리 수치는 없고(agy 미리 띄우기의 80~200MB 정도만 [brain.md](docs/connect/brain.md)에 있음), 아래는 코드에 있는 주기입니다.

| 일 | 주기 |
|---|---|
| 작업 세션 기록 반영 | 10분 |
| Slack 수집(연결했을 때) | 5분 |
| 할 일 진행 확인(새 세션이 없으면 모델을 안 부름) | 5분(`progressCheckMin`) |
| 서버 usagi-run·tmux 확인(`sshHosts`·`jobHosts`를 적었을 때) | 2분 |
| 서버 작업 기록 받기(`sessionHosts`) | 10분 |
| 미리알림 가져오기·맞추기 | 10분, ↻ 새로고침 때 바로(양방향이면 할 일을 고친 뒤 5초에도 한 번) |
| 캘린더 가져오기 | 30분 |
| 브리핑(평일 9~19시) | 60분 |
| 지식그래프 갱신, 프로필 학습 | 60분 |
| 연구 노트 쓰기(`tineGraph`를 적었을 때) | 60분(AI 정리는 재료가 바뀌었을 때 3시간에 한 번까지) |
| MCP 서버 도달 확인 | 2분 |
| 휴지통 정리 | 하루 한 번 |
| 새 버전 확인 | 하루 한 번 |

서버 GPU와 폴더·파일은 물어볼 때만 접속하고, 주기적으로 훑지 않습니다. 연결 도우미를 마치기 전에는 모델을 부르는 작업을 하나도 돌리지 않습니다. AI를 연결하지 않으면 모델 호출이 없습니다. 주기는 `config.json`의 `briefingIntervalMin` 등으로 바꿀 수 있습니다.

## 문제 해결

| 증상 | 해결 |
|---|---|
| 「"우사기"을(를) 열 수 없습니다」, 「악성 코드가 없음을 확인할 수 없습니다」 | dmg로 받은 경우입니다. 시스템 설정 → 개인정보 보호 및 보안 → 「그래도 열기」. Homebrew 설치는 이 과정이 필요 없습니다 |
| 「손상되었기 때문에 열 수 없습니다」 | 맥에 맞지 않는 dmg(애플 실리콘/인텔)이거나 받다가 끊겼습니다. 맞는 파일을 다시 받습니다 |
| 캐릭터가 안 보임 | 응용 프로그램에서 우사기를 다시 엽니다. 메뉴 막대에 아이콘이 있으면 켜져 있는 것이니 그 메뉴의 「캐릭터 숨기기」 체크를 풉니다(윈도우 메뉴의 「캐릭터 보이기·숨기기」도 같음) |
| 패널에 「꺼짐」이 계속 보임 | 앱을 끄고 다시 엽니다. 데몬이 죽으면 앱이 1초부터 최대 1분 간격으로 다시 띄웁니다. 로그는 `~/.cy-agent/logs/`에 있습니다 |
| 업데이트 뒤 캘린더·미리알림 허락이 풀림 | 서명 인증서가 달라졌을 때 생깁니다. 말풍선의 「다시 허락하기」를 눌러 다시 허락합니다 |
| 캘린더·Slack 연결을 바꿨는데 반영이 안 됨 | 앱을 껐다 켭니다(터미널 설치는 `launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon`) |
| 서버 실험이 안 보임 | `sshHosts`에 서버를 적었는지, `ssh <서버>`가 비밀번호 없이 되는지, 서버에 `usagi-run`이 있는지 확인합니다. 공용 계정이면 `jobDirs`를 확인합니다. 바꾼 뒤에는 데몬을 다시 켭니다 |
| AI가 갑자기 다른 것으로 바뀜 | 앞의 AI가 사용량을 다 쓰면 우선순위의 다음 AI로 넘어갑니다. 설정 「AI」 탭에서 상태를 봅니다 |
| 그래도 안 됨 | 캐릭터에서 ⌘⇧D를 누르면 「도움 보내기」 창이 기록을 모아 줍니다. [Issues](https://github.com/reo91004/usagi-agent/issues)에 올려 주세요 |

## 개발과 릴리스

| 경로 | 역할 |
|---|---|
| `agent/` | 데몬. TypeScript를 빌드 없이 Node.js 24로 바로 돌립니다. 수집, AI, 브리핑, 코드 고치기, 로컬 서버(`127.0.0.1:47823`) |
| `desktop/` | Electron 앱. 캐릭터 오버레이, 패널, 작업 세션 창([desktop/README.md](desktop/README.md)) |
| `assets/` | 캐릭터 그림·영상·스티커 |
| `ops/` | 터미널 설치·업데이트·삭제, 릴리스 스크립트(`release.sh`), `usagi-run`, Slack 앱 매니페스트, 설정 예시 |
| `docs/` | 연결 안내(`connect/`), 데몬과 앱 사이 HTTP/SSE 계약([contract.md](docs/contract.md)), 릴리스([release.md](docs/release.md)) |
| `windows/` | 윈도우 버전(이 포크에서는 쓰지 않음) |

```bash
cd agent && npm ci && npm test        # 타입 검사 + 단위 테스트
npm start                             # 데몬 실행(포그라운드)
cd desktop && npm ci && npm test
npm run fake-daemon & npm start       # 진짜 데몬 없이 가짜 데이터로 앱만
npm run dist                          # 우사기.app과 dmg(dist/Usagi-<버전>-<arch>.dmg)
```

릴리스는 `sh ops/release.sh --publish`입니다. dmg 만들기, 서명 인증서와 키 백업, Homebrew tap 갱신은 [docs/release.md](docs/release.md)에 있습니다. 앱 번들 ID(`com.cy-agent.desktop`)와 데이터 폴더(`~/.cy-agent`)는 원래 프로젝트와 합치기 쉽게 그대로 두었습니다.

## 원래 프로젝트와 라이선스

이 프로젝트는 [cheo0y/shisa-agent](https://github.com/cheo0y/shisa-agent)(「시사 비서」)를 바탕으로, 연구실 생활(서버 실험, 연구 노트, Slack 지시사항)에 맞게 고친 포크입니다. 원래 프로젝트의 의견 창구는 인스타그램 [@cheo0y](https://www.instagram.com/cheo0y/)와 chaeyoung@cyhuh.com입니다. 이 포크에 대한 의견은 이 레포의 Issues에 올려 주세요.

코드는 [MIT 라이선스](LICENSE)를 따릅니다.

다만 `assets/`와 `docs/images/`에 있는 시사·하치와레·랏코·모몽가 그림과 영상은 치이카와(ちいかわ, © Nagano)의 팬아트이며 MIT 라이선스에 포함되지 않습니다. 비상업적 용도로만 쓸 수 있고, 원작의 권리는 원저작자에게 있습니다. 우사기 자산은 참고 자료를 바탕으로 만든 생성 팬 아트입니다. 앱을 고쳐서 배포하거나 상업적으로 쓰려면 이 그림들을 직접 만든 그림으로 바꿔 주세요([캐릭터 바꾸기](desktop/README.md#캐릭터-바꾸기)).

`desktop/renderer/vendor/`에 들어 있는 외부 라이브러리의 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 정리해 두었습니다.
