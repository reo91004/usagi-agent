# 메일 연결

메일은 로컬에 따로 모아 두지 않습니다. 브리핑이나 더블클릭 채팅 때 모델이 매핑된 읽기 도구(`search`·`read`)로 그때그때 "최근 24시간 동안 받은 메일 중 답장이나 조치가 필요한 것"을 봅니다. 그래서 api 모드는 없습니다.

| 모드 | 어떻게 읽나 |
|---|---|
| `mcp` | Claude Code에 등록한 메일 MCP 서버(Claude Code 뇌는 브리핑·채팅, Codex·Antigravity 뇌는 채팅에서만 읽습니다. [brain.md](brain.md#codexantigravity-뇌에서-mcp-연결-읽기)) |
| `off` | 브리핑에서 메일 단계가 빠집니다(기본) |

발송·삭제·라벨 변경 같은 쓰기 도구는 서버에 있어도 쓰이지 않습니다. 허용 목록에는 매핑한 읽기 도구만 들어가고, 쓰기 이름은 훅이 막습니다(`agent/src/guard.ts`).

## 프리셋 `gmail`: [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)

> 이 저장소는 2025년 8월부터 보관(archived) 상태라 더 이상 고쳐지지 않습니다(2026-10 확인). 오래 쓰실 거라면 다른 Gmail MCP를 아래 "직접 채우기"로 붙이는 편이 낫습니다.

1. [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 만들기 → **Gmail API** 사용 설정
2. OAuth 동의 화면 → 테스트 사용자에 내 이메일 추가
3. API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID 만들기 → 유형 **데스크톱 앱**(또는 웹 애플리케이션 + 리디렉션 URI `http://localhost:3000/oauth2callback`) → JSON 내려받기
4. 파일 이름을 `gcp-oauth.keys.json`으로 바꿔 `~/.gmail-mcp/`에 둡니다.
   ```bash
   mkdir -p ~/.gmail-mcp && mv ~/Downloads/client_secret_*.json ~/.gmail-mcp/gcp-oauth.keys.json
   ```
5. 인증합니다(브라우저가 열리고, 토큰은 `~/.gmail-mcp/`에 저장됩니다).
   ```bash
   npx @gongrzhe/server-gmail-autoauth-mcp auth
   ```
6. 등록:
   ```bash
   claude mcp add --scope user --transport stdio gmail -- npx -y @gongrzhe/server-gmail-autoauth-mcp
   ```
7. 설정:
   ```json
   { "connectors": { "mail": { "mode": "mcp", "preset": "gmail" } } }
   ```

매핑: `search` → `search_emails`, `read` → `read_email`.

## 프리셋 `ms-365`: [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server)

캘린더와 같은 서버를 함께 쓸 수 있습니다([calendar.md](calendar.md#프리셋-ms-365-softeriams-365-mcp-server)). 이미 등록했다면 1·2단계는 건너뛰세요.

```bash
npx -y @softeria/ms-365-mcp-server --login
claude mcp add --scope user --transport stdio ms365 -- npx -y @softeria/ms-365-mcp-server --read-only
# 회사·학교 계정이면 두 명령 끝에 --org-mode
```

```json
{ "connectors": { "mail": { "mode": "mcp", "preset": "ms-365" } } }
```

매핑: `search` → `list-mail-messages`, `read` → `get-mail-message`(출처: 저장소 `src/endpoints.json`).

## 다른 메일 MCP: 직접 채우기

```json
{ "connectors": { "mail": { "mode": "mcp", "server": "<등록한 이름>", "tools": { "search": "<메일 검색/목록 도구>", "read": "<메일 하나 읽기 도구>" } } } }
```

`tools`를 비우면 서버 전체가 허용되고, 가드가 읽기 이름(get·list·search·read …)만 통과시킵니다.
