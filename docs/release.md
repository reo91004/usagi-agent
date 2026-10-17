# 앱(dmg) 만들기와 내보내기

「우사기.app」 dmg를 만들어 GitHub Releases(`reo91004/usagi-agent`)에 올리고 Homebrew tap을 갱신하는 방법입니다. 애플 개발자 서명과 공증은 하지 않고, 자체 서명 인증서로 서명합니다.

## 앱 안에 든 것

| 위치(`우사기.app/Contents/`) | 내용 |
|---|---|
| `MacOS/usagi` | Electron 앱. 같은 실행 파일을 `ELECTRON_RUN_AS_NODE=1`로 띄우면 Node.js(Electron에 든 Node 24)로 동작합니다 |
| `Resources/app.asar` | 데스크톱 앱 코드(`desktop/`의 main.js, preload, renderer, src) |
| `Resources/agent/` | 데몬 소스(`agent/src`, 테스트 파일 제외)와 런타임 의존성(`npm ci --omit=dev`). Claude Agent SDK의 그 아키텍처용 실행 파일 패키지도 여기 들어갑니다 |
| `Resources/assets/` | 캐릭터 그림·영상·스티커(레포 `assets/`) |

앱이 켜지면 `Resources/agent/src/main.ts`를 자식 프로세스로 띄웁니다(`desktop/src/bundle.js`, `desktop/src/daemon-host.js`).

- 그 포트(기본 47823)에 이미 데몬이 떠 있으면 띄우지 않고 그 데몬을 씁니다. 1분마다 다시 보고, 사라지면 그때 띄웁니다.
- 터미널 설치(`~/Library/LaunchAgents/com.cy-agent.daemon.plist`가 있음)나 launchd가 띄운 앱(`CY_AGENT_SUPERVISED=1`)이면 띄우지 않습니다.
- 데몬이 죽으면 1초, 2초, 4초 … 최대 1분 간격으로 다시 띄웁니다. 1분 넘게 살아 있었으면 다시 1초부터입니다.
- 앱을 끄면 데몬에 SIGTERM을 보내고, 4초 안에 안 꺼지면 SIGKILL로 끕니다.
- 데몬의 출력은 `~/.cy-agent/logs/com.cy-agent.daemon.log`, 데몬 자신의 기록은 `~/.cy-agent/logs/daemon.log`에 남습니다.
- 앱이 받은 환경 변수(`CY_AGENT_HOME`, `CY_AGENT_PORT` 등)는 데몬에 그대로 넘어갑니다. 데몬에는 `CY_AGENT_SUPERVISED=1`이 붙어서, 캘린더·Slack 연결이 바뀌면 데몬이 스스로 꺼지고 앱이 다시 띄웁니다.

개발 실행(`cd desktop && npm start`)은 예전처럼 데몬을 띄우지 않습니다. 레포의 `agent/`를 앱이 띄우게 해 보려면 `CY_BUNDLED_DAEMON=1 npm start`를 씁니다.

로그인할 때 자동 실행(`app.setLoginItemSettings`)은 dmg로 깐 앱에서만 다룹니다. 설치 마법사를 마치면 켜지고, 설정의 「이 앱」에서 끌 수 있습니다. 터미널 설치(launchd), 개발 실행, `CY_AGENT_HOME`이나 기본이 아닌 `CY_AGENT_PORT`를 준 시험 실행, `CY_NO_LOGIN_ITEM=1`에서는 건드리지 않습니다.

새 버전 알림은 하루 한 번 `https://api.github.com/repos/reo91004/usagi-agent/releases?per_page=100`을 인증 없이 읽어서, 이 PC용 파일이 든 가장 높은 정식 버전이 `desktop/package.json`의 version보다 새로우면 캐릭터 말풍선으로 한 번 알립니다(`desktop/src/update-check.js`). 윈도우용 `v<버전>-windows` 릴리스는 윈도우 PC만 봅니다.

## 만들기

```bash
cd desktop
npm ci                 # 처음 한 번(@electron/packager)
npm run dist           # 이 맥의 아키텍처 → dist/Usagi-<버전>-arm64.dmg
npm run dist:x64       # 인텔 맥용 → dist/Usagi-<버전>-x64.dmg
npm run dist -- --no-dmg   # dmg 없이 dist/app/우사기-darwin-<arch>/우사기.app 만
```

- 버전은 `desktop/package.json`의 `version`입니다. 내보내기 전에 올려 둡니다.
- 인터넷이 필요합니다. 데몬 의존성은 `npm ci --omit=dev --os=darwin --cpu=<arch>`로 그 아키텍처용을 받고, Electron은 `@electron/packager`가 그 아키텍처용을 받습니다. 그래서 애플 실리콘 맥에서 인텔용(x64)도 만들 수 있습니다.
- 아이콘은 개인 그림(`~/.cy-agent/assets`)이 아니라 레포 `assets/`의 그림으로 만듭니다.
- `desktop/node_modules`가 없는 폴더(워크트리 등)에서는 다른 곳에 `npm ci`한 desktop 의존성을 `SHISA_BUILD_MODULES=<그 node_modules 경로>`로 알려 줍니다.
- 서명은 키체인에 `Usagi Code Signing` 코드 서명 인증서가 있으면 그 인증서로, 없으면 ad-hoc(`codesign --force --deep --sign -`)으로 합니다. `USAGI_SIGN_IDENTITY=<인증서 이름이나 SHA-1>`로 다른 인증서를 고를 수 있습니다. 애플 실리콘은 서명이 아예 없으면 실행을 막기 때문에 어느 쪽이든 서명은 넣습니다. 빌드 끝에 지정 요구 사항(`codesign -d -r-`)을 출력합니다.
- dmg는 macOS 기본 `hdiutil`로 「우사기.app」과 「응용 프로그램」 바로가기를 담아 압축(UDZO)합니다.

## 업데이트해도 macOS 허락이 남게 하는 서명 인증서

macOS(TCC)는 캘린더·미리알림·문서 폴더 허락을 줄 때 앱의 지정 요구 사항을 함께 저장하고, 다음 접근 때 지금 앱이 그 요구 사항을 만족하는지 봅니다. ad-hoc 서명의 지정 요구 사항은 `cdhash H"…"`라서 내용이 바뀐 새 버전은 만족하지 못하고, 업데이트할 때마다 허락이 풀립니다(#81, #84). 권한을 쓰는 프로세스는 `bin/usagi-eventkit`이지만 TCC가 확인하는 것은 책임 프로세스인 앱(`com.cy-agent.desktop`)의 서명입니다.

인증서로 서명하면 지정 요구 사항이 `identifier "com.cy-agent.desktop" and certificate leaf = H"<인증서 SHA-1>"`처럼 인증서 기준이 되어, 같은 인증서로 서명한 다음 버전도 만족합니다. 애플 개발자 계정이 없으면 이 Mac 로그인 키체인의 자체 서명 인증서로 충분합니다. 서명에 인증서가 들어가므로 brew로 설치한 다른 Mac에도 똑같이 적용됩니다.

릴리스를 만드는 Mac에서 한 번 만듭니다(키체인을 바꾸는 일이라 직접 실행합니다).

```bash
D=$(mktemp -d); P=$(openssl rand -hex 16)   # p12 비밀번호는 옮길 때만 쓰고 버립니다
printf '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Usagi Code Signing\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n' > "$D/cs.cnf"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$D/cs.cnf" -keyout "$D/key.pem" -out "$D/cert.pem"
openssl pkcs12 -export -inkey "$D/key.pem" -in "$D/cert.pem" -out "$D/usagi.p12" -passout "pass:$P"
security import "$D/usagi.p12" -k ~/Library/Keychains/login.keychain-db -P "$P" -T /usr/bin/codesign
rm -rf "$D"
security find-identity -p codesigning   # "Usagi Code Signing" 이 보이면 됩니다(신뢰 안 됨 표시는 괜찮습니다)
```

- 인증서를 신뢰로 바꿀 필요는 없습니다. 처음 서명할 때 키체인이 codesign의 키 사용을 물으면 「항상 허용」을 누릅니다.
- 인증서로 처음 내보낸 버전에서 한 번 더 허락해야 하고, 그 뒤로는 같은 인증서로 서명하는 동안 허락이 남습니다. 다시 ad-hoc이나 다른 인증서로 내보내면 그때 또 한 번 풀립니다.
- 키를 잃거나 다른 키로 내보내면 그 버전에서 모든 사용자가 허락을 한 번 더 해야 합니다. 아래 「서명 키 .p12 백업」을 해 둡니다.
- 이 키를 가진 사람은 macOS가 우사기로 여기는 앱을 서명할 수 있으니 p12 파일은 나누지 않습니다.
- 애플 Developer ID(유료 개발자 계정)로 바꾸면 같은 효과에 공증까지 할 수 있습니다. 그때는 `USAGI_SIGN_IDENTITY="Developer ID Application: …"`로 고르고 공증 단계를 더합니다.

### 서명 키 .p12 백업

- 왜: 서명 키는 이 Mac의 로그인 키체인에만 있습니다. Mac을 초기화하거나 바꾸면 사라지고, 새로 만든 인증서로 서명한 버전은 macOS가 다른 앱으로 보기 때문에 캘린더·미리알림 허락이 모두 풀립니다.
- 내보내기: 키체인 접근 → 로그인 → 내 인증서에서 `Usagi Code Signing`을 고르고 파일 → 항목 내보내기. 형식은 개인 정보 교환(.p12)이고 비밀번호를 지정합니다. 인증서 왼쪽 화살표를 펼쳤을 때 개인 키가 딸려 있어야 합니다(키가 없는 p12는 서명에 쓸 수 없습니다).
- 보관: p12 파일과 비밀번호를 비밀번호 관리자 같은 안전한 곳에 따로 둡니다. Mac에 내려받은 파일은 지우고, 다른 사람에게 주지 않습니다.
- 다른 Mac에서 복원: `security import <파일> -k ~/Library/Keychains/login.keychain-db -P <비밀번호> -T /usr/bin/codesign` 후 `security find-identity -p codesigning`에 `Usagi Code Signing`이 보이는지 확인합니다.

## 손으로 확인하기

실제 데이터(`~/.cy-agent`)와 포트(47823)를 건드리지 않게 임시 폴더와 빈 포트로 띄웁니다. 이때는 로그인 항목도 건드리지 않습니다.

```bash
hdiutil attach dist/Usagi-<버전>-arm64.dmg -nobrowse -readonly -mountpoint /tmp/usagi-mnt
ditto /tmp/usagi-mnt/우사기.app /tmp/usagi-test/우사기.app && hdiutil detach /tmp/usagi-mnt
mkdir -p /tmp/usagi-home
CY_AGENT_HOME=/tmp/usagi-home CY_AGENT_PORT=48300 /tmp/usagi-test/우사기.app/Contents/MacOS/usagi
curl -s http://127.0.0.1:48300/status   # 다른 터미널에서
```

## GitHub Releases에 올리기

```bash
sh ops/release.sh             # arm64·x64 dmg와 SHA256SUMS를 만들고, 올릴 명령만 보여 줍니다
sh ops/release.sh --publish   # gh release create v<버전> 까지 실행합니다
SHISA_ARCHS=arm64 sh ops/release.sh   # 한 아키텍처만
```

`--publish`가 실행하는 명령은 아래와 같습니다. `gh`에 로그인한 계정이 `reo91004/usagi-agent`에 쓸 수 있어야 합니다.

```bash
gh release create v<버전> desktop/dist/Usagi-<버전>-arm64.dmg desktop/dist/Usagi-<버전>-x64.dmg desktop/dist/SHA256SUMS-<버전>.txt \
  --repo reo91004/usagi-agent --title "우사기 v<버전>" --notes-file desktop/dist/release-notes-<버전>.md
```

같은 태그가 이미 있으면 멈춥니다. 파일만 바꾸려면 `gh release upload v<버전> <파일> --clobber --repo reo91004/usagi-agent`를 씁니다.

## Homebrew tap 갱신

`ops/release.sh`는 두 아키텍처 dmg가 다 있을 때 `desktop/dist/usagi-agent.rb`(cask)를 만듭니다. 릴리스를 올린 뒤 tap에 복사해서 올립니다(tap 저장소는 `reo91004/homebrew-tap`).

```bash
cp desktop/dist/usagi-agent.rb $(brew --repo reo91004/tap)/Casks/
cd $(brew --repo reo91004/tap) && git add Casks/usagi-agent.rb && git commit -m "usagi-agent <버전>" && git push
brew update && brew upgrade --cask usagi-agent   # 설치한 Mac에서
```

cask는 `우사기.app`을 설치하고 `usagi-run`을 PATH에 연결하며, 받은 앱의 격리 표시(quarantine)를 지웁니다. `brew uninstall --zap --cask usagi-agent`는 `~/.cy-agent`까지 지웁니다.

## 남은 것

- 애플 개발자 서명과 공증을 하지 않아서, 처음 열 때 「그래도 열기」를 한 번 거쳐야 합니다(README 「설치와 업데이트」의 dmg 항목, Homebrew 설치는 격리 표시를 지워서 필요 없음). 개발자 계정이 생기면 `@electron/packager`의 `osxSign`·`osxNotarize` 옵션으로 바꿀 수 있습니다.
- 자동 업데이트는 하지 않습니다. 새 버전 알림을 보고 `brew upgrade --cask usagi-agent`를 하거나 dmg를 받아 덮어씁니다.
