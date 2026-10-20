# 캘린더 연결

캘린더는 일정 알림(기본 10분 전에 캐릭터가 춤추면서 알려 줍니다. 설정 「알림」 탭의 「일정 알림」에서 5·10·15·30분이나 직접 적은 분으로, 여러 번으로 바꾸거나 끌 수 있습니다)과 브리핑의 "오늘·내일 일정"에 쓰입니다. 30분마다 오늘·내일 일정을 다시 가져와 `~/.cy-agent/cy.db`에 둡니다.

| 모드 | 어떻게 읽나 | 추천 |
|---|---|---|
| `api` + `local: true` | 이 Mac 의 캘린더 앱(iCloud, 인터넷 계정에 넣은 Google 등)을 EventKit 으로 직접 읽습니다. macOS 허락 한 번, 네트워크·모델 없음 | **맥이면 추천** |
| `api` | 캘린더의 비공개 ICS 주소를 코드가 직접 읽습니다. MCP·OAuth·모델 없음, 비용 0. `local: true` 와 같이 쓸 수 있습니다 | **추천** |
| `mcp` | Claude Code에 등록한 캘린더 MCP. 경량 모델이 일정 목록 도구를 한 번 부르고 결과를 정해진 모양으로 옮깁니다(동기화마다 약간의 비용). 뇌가 Claude Code일 때만 동기화합니다 | ICS를 못 쓸 때 |
| `off` | 일정 알림 없음 | |

---

## 이 Mac 의 캘린더·미리알림

패널 위쪽 「연결 도우미」 → 「더 연결하기」 맨 위 「이 Mac 의 캘린더·미리알림」에서 [연결하기]를 누르면 macOS 가 캘린더·미리알림 허락을 한 번 묻습니다. 허락하면 앱이 `connectors.calendar` 에 `local: true`(주소가 있으면 그대로 두고 더함), 미리알림은 `appleReminders: true` 를 넣고 데몬이 바로 다시 읽습니다.

- 캘린더: 캘린더 앱에 보이는 일정(iCloud, 시스템 설정 → 인터넷 계정에 넣은 Google 계정 등)을 30분마다 읽습니다.
- 미리알림: 미리알림이 바뀔 때(미리알림 앱·아이폰 iCloud), 그리고 패널의 ↻ 새로고침 때 바로 안 끝난 미리알림을 할 일로 가져오고(출처 「미리알림」), 미리알림 앱에서 고친 제목·날짜를 따라가고(우사기에서 직접 고친 제목은 그대로), 끝낸 것은 할 일도 끝냅니다. 우사기에서 체크하거나 체크를 풀면(자동 완료 되돌리기 포함) 그 미리알림에도 바로 씁니다. 그 뒤 미리알림에서 끝내면 우사기에서 상태를 고친 적이 있어도 따라갑니다. 미리알림에서 체크를 푼 것은 한 방향에서는 우사기에 옮기지 않습니다(양방향에서만). 날짜가 있으면 날짜로 묶음을 정하고(오늘까지 「오늘 꼭」, 7일 안 「이번 주」, 그 뒤 「나중에」), 날짜가 없으면 「높음」·「보통」을 「이번 주」로 둡니다.
- 미리알림을 연결하면 같은 칸에 「미리알림과 양방향으로 맞추기」가 생깁니다(`remindersTwoWay: true`). 켜면 미리알림에서 오지 않은 우사기 할 일을 미리알림 「우사기 비서」 목록에 넣고, 이어 둔 짝끼리 끝내기·다시 열기·제목·마감·지우기를 서로 맞춥니다. 양쪽에서 같이 고쳤으면 우사기 쪽을 따릅니다. 미리알림에서 지운 것은 우사기 휴지통으로 가서 30일 동안 되살릴 수 있습니다. 우사기에서 휴지통에 넣으면 미리알림은 끝냄으로만 바뀌고(되살리면 다시 열림), 영구 삭제하면 우사기가 넣은 미리알림만 지웁니다. 미리알림 앱에서 만든 미리알림은 메모·하위 항목이 있을 수 있어 지우지 않습니다. 열린 짝의 절반 넘게(4개 넘게) 한꺼번에 사라지면 iCloud 로그아웃 같은 일로 보고 지우지 않고, 끝낸 짝이 사라진 것(끝낸 미리알림 정리)은 그냥 놓습니다. 우사기에서 할 일을 고치면 5초 뒤에(체크는 바로) 맞춥니다.
- 바뀜 알림: 데몬이 도우미 `usagi-eventkit watch` 를 하나 띄워 두고, macOS 가 미리알림·캘린더 DB 가 바뀌었다고 알려 줄 때(EKEventStoreChanged)만 1초 모아서 맞춥니다. 도우미는 타이머 없이 잠들어 있다가 그때만 깨어납니다(측정: 2분 동안 CPU 0.02초, 깨어남 0회/초, 메모리 약 14MB). 데몬이 꺼지면 같이 끝납니다. 알림을 받는 동안에는 주기 맞추기를 30분에 한 번(날짜가 바뀌어 묶음을 다시 정하는 용도)으로 줄이고, 도우미가 없거나 죽으면 10분마다 맞추면서 다시 띄웁니다.
- 캘린더는 읽기만 하고 바꾸지 않습니다. 허락을 거절했다면 같은 칸의 [캘린더 허락 열기]·[미리알림 허락 열기]로 시스템 설정을 엽니다.
- 지금 캘린더를 `mcp` 로 읽고 있으면 이 Mac 캘린더로 바뀝니다(화면에 미리 알려 줍니다).

## (a) 추천: api 모드, 비공개 ICS 주소

> **ICS 주소는 비밀번호와 같습니다.** 주소만 있으면 누구든 일정 전체(제목·참석자·설명)를 볼 수 있습니다. 채팅·이슈·레포에 붙이지 말고 `~/.cy-agent/config.json`(권한 600)에만 두세요. 실수로 노출했다면 아래 "재설정"으로 새 주소를 만드세요.

### Google 캘린더: "iCal 형식의 비공개 주소"

출처: [Google 캘린더 고객센터: 다른 캘린더 애플리케이션과 공유](https://support.google.com/calendar/answer/37648?hl=ko) (2026-10 확인)

1. 컴퓨터 브라우저에서 Google Calendar를 엽니다(앱이 아니라 웹).
2. 오른쪽 위 톱니바퀴 → **설정**
3. 왼쪽 **내 캘린더의 설정** 아래에서 읽어 올 캘린더(보통 내 이름)를 클릭
4. **캘린더 통합**으로 내려갑니다.
5. **iCal 형식의 비공개 주소** 칸의 복사 버튼을 누르면 `https://calendar.google.com/calendar/ical/…/private-…/basic.ics` 꼴의 주소가 복사됩니다.
6. 노출됐다면 같은 칸의 **재설정**으로 새 주소를 만듭니다(예전 주소는 끊깁니다).

회사·학교 Google 계정은 관리자가 공유 설정을 바꿔 둬서 이 칸이 안 보일 수 있습니다. 그럴 때는 관리자에게 문의하거나 (b) mcp 모드를 쓰세요.

### Outlook(Microsoft 365 · Outlook.com): 캘린더 게시

출처: [Microsoft 지원: 웹용 Outlook에서 일정 공유](https://support.microsoft.com/ko-kr/office/7ecef8ae-139c-40d9-bae2-a23977ee58d5) (2026-10 확인). 한국어 UI에서는 Calendar가 "일정"으로 나옵니다.

1. 웹용 Outlook(outlook.office.com 또는 outlook.live.com) → 왼쪽 **일정**
2. 오른쪽 위 톱니바퀴(**설정**) → **일정** → **공유 일정**
3. **일정 게시** 아래에서 캘린더(보통 "일정")를 고르고, 공개 수준은 **모든 세부 정보 볼 수 있음**(영문 UI "Can view all details")으로 고릅니다.
   - "다른 용무 중일 때만 볼 수 있음"으로 게시하면 제목이 빠지고 "바쁨"만 보입니다. 회의 알림 자체는 오지만 제목과 회의 링크가 없습니다.
4. **게시**를 누르면 아래에 HTML 링크와 **ICS 링크**가 생깁니다. **ICS 링크**를 복사하세요.
5. 노출됐다면 같은 화면에서 **게시 취소** 후 다시 게시하면 새 주소가 나옵니다.

- 클래식 웹용 Outlook은 설정 → 일정 → **일정 게시** 경로이고, 고른 뒤 **저장**을 누릅니다.
- 정확한 메뉴 이름(특히 공개 수준 항목 이름)은 Microsoft 문서에 다 나와 있지 않아서 실제 화면과 조금 다를 수 있습니다.
- 회사 계정은 관리자가 외부 게시를 막아 둔 경우가 많습니다(게시 메뉴가 없거나 "조직 내부만"으로만 됩니다). 그럴 때는 (b)의 `ms-365` 프리셋을 쓰세요.

### 설정

**연결 도우미로 하기(쉬움)**: 패널 위쪽 「연결 도우미」 → 「더 연결하기」 → 「구글 캘린더」 또는 「Outlook 캘린더」에 복사한 주소를 붙이면, 앱이 `connectors.calendar`(`mode: "api"`, `icsUrls`, `timeZone: "Asia/Seoul"`)에 넣고 데몬에 다시 읽게 알립니다. 반영되지 않으면 데몬을 한 번 다시 켜 주세요(`launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon`).

**캘린더 여러 개**: 캘린더는 몇 개든 더할 수 있습니다. 하나를 연결한 뒤 같은 화면의 「연결된 캘린더」에서 **구글 캘린더 하나 더 추가**나 **Outlook 캘린더 하나 더 추가**를 누르면 같은 안내로 주소를 하나 더 붙입니다(이미 붙인 주소는 「이미 연결된 캘린더예요」로 막습니다). 목록에는 주소 대신 캘린더 id 앞부분과 도메인만(예: `gild…@gmail.com`) 보이고, 줄마다 **빼기**로 그 캘린더만 뺄 수 있습니다. 설정 창 「연결 상태」의 캘린더 줄 아래에도 같은 목록이 있습니다. 마지막 하나를 빼면 주소로 읽는 캘린더가 꺼집니다. 이 Mac 캘린더를 같이 쓰고 있으면 그건 남습니다. 패널·설정의 캘린더 **연결 해제**는 주소와 이 Mac 캘린더를 모두 끕니다(미리알림은 그대로). 여러 캘린더에 같은 일정이 들어 있어도(같은 UID·시작 시각) 회의 알림은 한 번만 울립니다.

**직접 넣기**:

```json
{
  "connectors": {
    "calendar": {
      "mode": "api",
      "icsUrl": "https://calendar.google.com/calendar/ical/.../basic.ics",
      "timeZone": "Asia/Seoul",
      "email": "gildong@example.com"
    }
  }
}
```

| 키 | 설명 |
|---|---|
| `icsUrl` / `icsUrls` | 주소 하나 또는 배열(캘린더 여러 개). `webcal://`도 됩니다(https로 바꿔 읽음) |
| `timeZone` | 떠 있는 시각(시간대 없는 일정) 해석과 하루 경계에 씁니다. 기본 `Asia/Seoul` |
| `email` | 내 캘린더 이메일. 있으면 참석자 목록에서 내 응답(수락·거절·미정)과 주최자 여부를 보고, 거절한 회의는 알리지 않습니다. 비워 두면 전부 "응답 없음"으로 치고 알립니다 |

환경변수 `CY_AGENT_CALENDAR_ICS_URL`(공백으로 여러 개)을 주면 파일의 주소 대신 그 값을 씁니다.

### 확인

```bash
./ops/install.sh     # 또는: launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon
grep -E '\[connectors\] 캘린더|\[calendar\]' ~/.cy-agent/logs/com.cy-agent.daemon.log | tail
# [connectors] 캘린더: api · ICS 1개
# [calendar] {"meetings":3,"events":4,"calls":1,"errors":0,"costUsd":0}
# [calendar] ICS 실패: ICS HTTP 404      ← 주소가 틀렸거나 재설정됨 (주소 자체는 로그에 남기지 않음)
```

주소가 맞는지 직접 보려면 아래처럼 확인할 수 있습니다(터미널 기록에 남으니 끝나면 지워도 좋습니다).

```bash
curl -s "<ICS 주소>" | head -3      # BEGIN:VCALENDAR 로 시작하면 정상
```

### ICS 모드가 다루는 것과 안 다루는 것 (`agent/src/ics.ts`)

- **다룸**: 줄 접기·이스케이프, TZID(IANA 이름·Windows 시간대 이름·VTIMEZONE 고정 오프셋), UTC·떠 있는 시각, 종일 일정, 반복 일정 기본(RRULE의 FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY(서수 포함), BYMONTHDAY, BYMONTH), EXDATE, 바뀌거나 취소된 회차(RECURRENCE-ID), 취소(STATUS:CANCELLED), 한가함 표시(TRANSP:TRANSPARENT), 참석자 응답(PARTSTAT), 회의 링크(Meet·Zoom·Teams)
- **안 다룸**: RDATE, BYSETPOS, BYWEEKNO·BYYEARDAY, VTIMEZONE의 서머타임 규칙(IANA 이름으로 바꿀 수 없는 시간대는 표준시 오프셋 하나로 봅니다)
- 게시 주소는 Google·Microsoft 쪽 캐시 때문에 바뀐 내용이 몇 분에서 몇 시간까지 늦게 반영될 수 있습니다. 방금 잡은 회의는 알림이 늦을 수 있습니다.

---

## (b) mcp 모드: 캘린더 MCP 서버

경량 모델이 매핑된 `listEvents` 도구 하나만 부르고, 결과를 시사의 일정 모양으로 옮깁니다(다른 도구는 훅이 막습니다). 동기화(30분)마다 작은 모델 비용이 듭니다.

### 프리셋 `google-calendar`: [nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp) (npm `@cocal/google-calendar-mcp`)

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만들고 **Google Calendar API**를 사용 설정합니다.
2. OAuth 동의 화면(대상) → 테스트 사용자에 내 이메일 추가
3. 사용자 인증 정보 → OAuth 클라이언트 ID 만들기. 애플리케이션 유형은 꼭 **데스크톱 앱**으로 고릅니다(README에서도 따로 강조합니다). JSON을 내려받아 예를 들어 `~/.config/google-calendar-mcp/gcp-oauth.keys.json`에 둡니다.
4. 인증:
   ```bash
   GOOGLE_OAUTH_CREDENTIALS=~/.config/google-calendar-mcp/gcp-oauth.keys.json npx -y @cocal/google-calendar-mcp auth
   ```
5. 등록:
   ```bash
   claude mcp add --scope user -e GOOGLE_OAUTH_CREDENTIALS=$HOME/.config/google-calendar-mcp/gcp-oauth.keys.json \
     --transport stdio google-calendar -- npx -y @cocal/google-calendar-mcp
   ```
6. 설정:
   ```json
   { "connectors": { "calendar": { "mode": "mcp", "preset": "google-calendar" } } }
   ```

매핑: `listEvents` → `list-events`, `search` → `search-events`.
주의: OAuth 앱이 "테스트" 상태면 **토큰이 7일마다 만료**됩니다(README). 만료되면 4번을 다시 하면 됩니다.

### 프리셋 `ms-365`: [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server)

```bash
npx -y @softeria/ms-365-mcp-server --login        # 터미널에 뜨는 URL·코드로 로그인
claude mcp add --scope user --transport stdio ms365 -- npx -y @softeria/ms-365-mcp-server --read-only
```

- 회사·학교(Entra ID) 계정이라면 두 명령 모두 끝에 `--org-mode`를 붙입니다(README: "조직 모드는 처음부터 켜야 한다"). 테넌트 정책에 따라 관리자 동의가 필요할 수 있습니다.
- `--read-only`는 쓰기 도구를 아예 끕니다.

```json
{ "connectors": { "calendar": { "mode": "mcp", "preset": "ms-365" } } }
```

매핑: `listEvents` → `get-calendar-view`(출처: 저장소 `src/endpoints.json`). 같은 서버를 메일에도 쓸 수 있습니다([mail.md](mail.md)).

### 다른 캘린더 MCP: 직접 채우기

```json
{ "connectors": { "calendar": { "mode": "mcp", "server": "<등록한 이름>", "tools": { "listEvents": "<기간으로 일정 목록을 주는 도구>" } } } }
```

`listEvents`가 없으면 동기화가 실패로 끝납니다(쓰기처럼 보이는 이름도 거부합니다). `/mcp`에서 도구 이름을 확인해 적어 주세요.
