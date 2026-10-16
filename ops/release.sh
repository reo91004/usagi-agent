#!/bin/sh
# 새 버전 내보내기: 앱(dmg)을 만들고 GitHub Releases 에 올린다. 자세한 순서는 docs/release.md.
#   sh ops/release.sh             dmg 를 만들고, 올릴 명령을 보여 주기만 한다(아무것도 올리지 않음)
#   sh ops/release.sh --publish   gh release create 까지 실행한다(gh 로그인 계정이 reo91004/usagi-agent 에 쓸 수 있어야 함)
# 버전은 desktop/package.json 의 version(태그는 v<버전>). 만들 아키텍처는 SHISA_ARCHS="arm64 x64"(기본)로 고른다.
# desktop/node_modules 가 없으면 SHISA_BUILD_MODULES=<다른 곳에 npm ci 한 desktop node_modules> 를 앞에 붙인다.
set -eu
PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_SLUG="${SHISA_RELEASE_REPO:-reo91004/usagi-agent}"
VER=$(node -p "JSON.parse(require('fs').readFileSync('$ROOT/desktop/package.json','utf8')).version")
TAG="v$VER"
ARCHS="${SHISA_ARCHS:-arm64 x64}"
DIST="$ROOT/desktop/dist"

for a in $ARCHS; do
  echo "→ $a 빌드"
  (cd "$ROOT/desktop" && node scripts/dist.mjs --arch="$a")
done

FILES=""
for a in $ARCHS; do FILES="$FILES $DIST/Usagi-$VER-$a.dmg"; done
# 받은 파일이 맞는지 확인할 수 있게 SHA-256 목록도 함께 올린다
(cd "$DIST" && shasum -a 256 $(for a in $ARCHS; do printf '%s ' "Usagi-$VER-$a.dmg"; done) > "SHA256SUMS-$VER.txt")
FILES="$FILES $DIST/SHA256SUMS-$VER.txt"

# Homebrew cask(reo91004/homebrew-tap 의 Casks/usagi-agent.rb 로 복사): 두 아키텍처 dmg 가 다 있을 때만
CASK="$DIST/usagi-agent.rb"
rm -f "$CASK"
case " $ARCHS " in *" arm64 "*) case " $ARCHS " in *" x64 "*)
  sha() { shasum -a 256 "$DIST/Usagi-$VER-$1.dmg" | cut -d' ' -f1; }
  cat > "$CASK" <<EOF
cask "usagi-agent" do
  arch arm: "arm64", intel: "x64"

  version "$VER"
  sha256 arm:   "$(sha arm64)",
         intel: "$(sha x64)"

  url "https://github.com/$REPO_SLUG/releases/download/v#{version}/Usagi-#{version}-#{arch}.dmg"
  name "우사기 비서"
  desc "Desktop character assistant for todos, briefings and focus timers"
  homepage "https://github.com/$REPO_SLUG"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :monterey"

  app "우사기.app"
  binary "#{appdir}/우사기.app/Contents/Resources/bin/usagi-run"

  # ad-hoc 서명(개발자 인증서 없음)이라 받은 그대로면 Gatekeeper 가 열지 못하게 막는다
  postflight do
    system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{appdir}/우사기.app"]
  end

  uninstall quit:       "com.cy-agent.desktop",
            login_item: "우사기"

  zap trash: [
    "~/.cy-agent",
    "~/Library/Application Support/cy-agent-desktop",
    "~/Library/Preferences/com.cy-agent.desktop.plist",
    "~/Library/Saved Application State/com.cy-agent.desktop.savedState",
  ]
end
EOF
  echo "✓ $CASK  →  cp \"$CASK\" \"\$(brew --repo reo91004/tap)/Casks/\""
;; esac;; esac

NOTES="$DIST/release-notes-$VER.md"
cat > "$NOTES" <<EOF
## 받기

Homebrew: \`brew install --cask reo91004/tap/usagi-agent\` (업데이트는 \`brew upgrade --cask usagi-agent\`)

- 애플 실리콘 맥(M1 이후): \`Usagi-$VER-arm64.dmg\`
- 인텔 맥: \`Usagi-$VER-x64.dmg\`

어느 쪽인지 모르겠다면 화면 왼쪽 위 사과 메뉴 → 이 Mac에 관하여 에서 「칩」이 Apple 로 시작하면 애플 실리콘, 「프로세서」가 Intel 이면 인텔입니다.

dmg 를 열어 우사기를 응용 프로그램 폴더로 끌어다 놓으면 됩니다. 이미 쓰고 있었다면 덮어쓰면 되고, 할 일과 설정(~/.cy-agent)은 그대로 남습니다.
처음 열 때 경고가 뜨면 README 의 「쉬운 설치(앱)」를 봐 주세요.

터미널로 설치해 쓰고 있다면 레포 폴더에서 \`./ops/update.sh\` 를 실행하면 됩니다.
EOF

set -- gh release create "$TAG" $FILES --repo "$REPO_SLUG" --title "우사기 $TAG" --notes-file "$NOTES"
if [ "$PUBLISH" = 1 ]; then
  if gh release view "$TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
    echo "✗ $TAG 릴리스가 이미 있습니다. desktop/package.json 의 version 을 올리거나, 파일만 바꾸려면 gh release upload $TAG <파일> --clobber --repo $REPO_SLUG"
    exit 1
  fi
  "$@"
  echo "✓ https://github.com/$REPO_SLUG/releases/tag/$TAG"
else
  echo
  echo "올릴 준비가 끝났습니다. 아래 명령을 실행하거나 sh ops/release.sh --publish 로 다시 실행하세요:"
  for x in "$@"; do printf "'%s' " "$x"; done
  echo
fi
