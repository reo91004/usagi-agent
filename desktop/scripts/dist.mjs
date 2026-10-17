// 배포용 dmg 만들기: 데몬(agent/)까지 든 「우사기.app」 → ad-hoc 서명 → hdiutil 로 「우사기.app + 응용 프로그램 바로가기」 dmg.
// 사용: npm run dist                 (이 맥의 아키텍처: 애플 실리콘이면 arm64)
//       npm run dist -- --arch=x64   (인텔 맥용. 데몬 의존성은 npm 이 x64 용으로 받고, Electron x64 는 packager 가 받는다)
//       npm run dist -- --no-dmg     (앱 번들만)
// 결과: dist/Usagi-<버전>-<arch>.dmg (버전은 desktop/package.json version)
// 인터넷이 필요하다(npm ci, 처음 한 번 Electron 받기). 애플 개발자 서명·공증은 하지 않는다(README 「쉬운 설치」의 「그래도 열기」 참고).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); // desktop/
const REPO = path.join(ROOT, '..');
const APP_NAME = '우사기';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const args = process.argv.slice(2);
const argOf = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const ARCH = argOf('arch') ?? process.arch;
if (!['arm64', 'x64'].includes(ARCH)) throw new Error(`--arch 는 arm64 또는 x64: ${ARCH}`);
const MAKE_DMG = !args.includes('--no-dmg');

// @electron/packager: desktop/node_modules 에서. 거기 없으면(워크트리 등) SHISA_BUILD_MODULES=<다른 곳에 npm ci 한 node_modules>
async function loadPackager() {
  try {
    return (await import('@electron/packager')).packager;
  } catch (err) {
    const dir = process.env.SHISA_BUILD_MODULES;
    if (!dir) throw new Error(`@electron/packager 를 못 찾았어요. desktop 에서 npm ci 를 먼저 하거나 SHISA_BUILD_MODULES=<node_modules 경로> 로 알려 주세요 (${err.message})`);
    return (await import(pathToFileURL(path.join(dir, '@electron', 'packager', 'dist', 'index.js')).href)).packager;
  }
}
const packager = await loadPackager();
const ELECTRON_VERSION = String(pkg.devDependencies?.electron ?? '').replace(/^[^\d]*/, '');

const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'stage', ARCH);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts });
const step = (s) => console.log(`\n→ ${s}`);

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 1) 데몬: agent/src(시험 파일 빼고) + package.json·lock → 런타임 의존성만(devDeps 빼고) 그 아키텍처용으로 받는다
step(`데몬 준비 (${ARCH})`);
const AGENT = path.join(STAGE, 'agent');
fs.mkdirSync(AGENT, { recursive: true });
fs.cpSync(path.join(REPO, 'agent', 'src'), path.join(AGENT, 'src'), {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    return !base.endsWith('.test.ts') && base !== 'fixtures' && base !== '.DS_Store';
  },
});
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(REPO, 'agent', f), path.join(AGENT, f));
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--os=darwin', `--cpu=${ARCH}`], { cwd: AGENT });
// node_modules/.bin 의 심볼릭 링크는 앱에 복사될 때 빌드 폴더의 절대 경로를 가리켜 서명이 깨진다. 데몬은 안 쓰니 뺀다
const dropBins = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.name === '.bin') fs.rmSync(p, { recursive: true, force: true });
    else dropBins(p);
  }
};
dropBins(path.join(AGENT, 'node_modules'));
// 앱 용량 줄이기: 런타임에 아무도 불러오지 않는 패키지(Agent SDK 의 선택적 피어·타입 전용 라이브러리)와,
// Node 가 node_modules 에선 읽지 않는 타입·소스맵·문서·TS 원본. 라이선스 파일은 남긴다. undici 는 Slack 소켓 모드가 불러서 남긴다
for (const n of ['@anthropic-ai/sdk', 'json-schema-to-ts', '@babel/runtime', 'ts-algebra', 'standardwebhooks', '@stablelib', 'fast-sha256', '@types', 'undici-types']) {
  fs.rmSync(path.join(AGENT, 'node_modules', n), { recursive: true, force: true });
}
const pruneFiles = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) pruneFiles(p);
    else if (!/^licen[cs]e/i.test(e.name) && /(\.d\.[cm]?ts|\.map|\.md|\.markdown|(?<!\.d)\.[cm]?ts)$/i.test(e.name)) fs.rmSync(p);
  }
};
pruneFiles(path.join(AGENT, 'node_modules'));
const links = execFileSync('find', [AGENT, '-type', 'l'], { encoding: 'utf8' }).trim();
if (links) throw new Error(`데몬 폴더에 심볼릭 링크가 남았어요(서명이 깨져요):\n${links}`);
// Agent SDK 의 플랫폼 패키지(Claude Code 실행 파일, 풀어서 약 225MB)는 넣지 않는다. 데몬은 이 Mac 에 설치된 claude 를 쓴다(agent/src/claude-sdk.ts, #64)
for (const name of fs.readdirSync(path.join(AGENT, 'node_modules', '@anthropic-ai'))) {
  if (/^claude-agent-sdk-/.test(name)) fs.rmSync(path.join(AGENT, 'node_modules', '@anthropic-ai', name), { recursive: true, force: true });
}

// 2) 캐릭터 그림·영상(레포 assets/) — 앱 Resources/assets 로. 대사(lines.json)는 렌더러용 사본도 맞춘다
step('캐릭터 그림 준비');
execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'sync-character-lines.mjs')], { stdio: 'inherit' });
const ASSETS = path.join(STAGE, 'assets');
fs.cpSync(path.join(REPO, 'assets'), ASSETS, { recursive: true, filter: (src) => path.basename(src) !== '.DS_Store' });

// 긴 작업 알림 명령(ops/usagi-run) — Resources/bin. brew cask 가 PATH 에 링크한다
const BIN = path.join(STAGE, 'bin');
fs.mkdirSync(BIN, { recursive: true });
fs.copyFileSync(path.join(REPO, 'ops', 'usagi-run'), path.join(BIN, 'usagi-run'));
fs.chmodSync(path.join(BIN, 'usagi-run'), 0o755);
// 이 Mac 의 캘린더·미리알림 도우미(native/usagi-eventkit.swift, #53). Command Line Tools 의 swiftc 로 이 아키텍처만.
// 호환 라이브러리를 빼야 인텔(x86_64) 링크가 된다 — Swift 동시성은 macOS 12 부터 OS 에 들어 있다
step('캘린더·미리알림 도우미 빌드');
run('xcrun', ['swiftc', '-O', '-swift-version', '5', '-runtime-compatibility-version', 'none', '-target', `${ARCH === 'x64' ? 'x86_64' : 'arm64'}-apple-macos12`,
  '-o', path.join(BIN, 'usagi-eventkit'), path.join(ROOT, 'native', 'usagi-eventkit.swift')]);

// 3) 아이콘: 개인 그림(~/.cy-agent/assets)이 아니라 레포 그림으로
step('아이콘 만들기');
const ICON_DIR = path.join(STAGE, 'icon');
fs.mkdirSync(ICON_DIR, { recursive: true });
run(process.execPath, [path.join(ROOT, 'scripts', 'make-icon.mjs')], { env: { ...process.env, CY_ICON_OUT: ICON_DIR } });

// 4) 앱 번들. 앱 코드(asar)에는 실행에 필요한 것만 넣는다(허용 목록) — 생성 아이콘·개발용 파일이 섞이지 않게
step('앱 번들 만들기');
const KEEP = [/^\/package\.json$/, /^\/main\.js$/, /^\/preload[\w-]*\.cjs$/, /^\/renderer(\/|$)/, /^\/src(\/|$)/,
  /^\/assets$/, /^\/assets\/(character\.(png|svg)|trayTemplate(@2x)?\.png)$/];
const OUT = path.join(DIST, 'app');
const paths = await packager({
  dir: ROOT,
  out: OUT,
  overwrite: true,
  platform: 'darwin',
  arch: ARCH,
  electronVersion: ELECTRON_VERSION,
  name: APP_NAME, // 우사기.app · Dock·Cmd+Tab·Finder 에 보이는 이름
  executableName: 'usagi',
  appVersion: VERSION,
  buildVersion: VERSION,
  appBundleId: 'com.cy-agent.desktop',
  appCategoryType: 'public.app-category.productivity',
  appCopyright: 'MIT License',
  icon: path.join(ICON_DIR, 'icon.icns'),
  asar: true,
  prune: true,
  ignore: (p) => p !== '' && !KEEP.some((re) => re.test(p)),
  extraResource: [AGENT, ASSETS, BIN],
  extendInfo: {
    CFBundleDisplayName: APP_NAME,
    CFBundleName: APP_NAME,
    LSUIElement: true, // Dock 아이콘 없이 켠다(설정에서 켜면 app.dock.show)
    LSMinimumSystemVersion: '12.0',
    // 이 Mac 의 캘린더·미리알림(EventKit, 데몬이 bin/usagi-eventkit 으로 읽기만). 14 이상은 FullAccess 문구를 본다
    NSCalendarsUsageDescription: '우사기가 오늘 일정과 회의를 알려 드리려고 캘린더를 읽습니다. 일정을 바꾸지는 않습니다.',
    NSCalendarsFullAccessUsageDescription: '우사기가 오늘 일정과 회의를 알려 드리려고 캘린더를 읽습니다. 일정을 바꾸지는 않습니다.',
    NSRemindersUsageDescription: '우사기가 미리알림을 할 일 목록에 보여 드리려고 읽습니다. 미리알림을 바꾸지는 않습니다.',
    NSRemindersFullAccessUsageDescription: '우사기가 미리알림을 할 일 목록에 보여 드리려고 읽습니다. 미리알림을 바꾸지는 않습니다.',
  },
  quiet: true,
});
const APP = path.join(paths[0], `${APP_NAME}.app`);
for (const need of ['Contents/Resources/agent/src/main.ts', 'Contents/Resources/agent/node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'Contents/Resources/assets/character/eyes_open.png', 'Contents/Resources/bin/usagi-run', 'Contents/Resources/bin/usagi-eventkit']) {
  if (!fs.existsSync(path.join(APP, need))) throw new Error(`앱 번들에 ${need} 가 없어요`);
}

// Electron 언어 파일(220개 가까이)은 한국어·영어만 남긴다. 다른 언어 맥에서는 Electron 기본(영어)으로 보인다
for (const res of [path.join(APP, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources'), path.join(APP, 'Contents', 'Resources')]) {
  for (const d of fs.readdirSync(res)) if (d.endsWith('.lproj') && !/^(en|ko)([_-].*)?\.lproj$/i.test(d)) fs.rmSync(path.join(res, d), { recursive: true, force: true });
}

// packager 가 CFBundleDisplayName 을 실행 파일 이름(usagi)으로 덮어써서 서명 전에 다시 쓴다(Spotlight·Launchpad 이름)
run('plutil', ['-replace', 'CFBundleDisplayName', '-string', APP_NAME, path.join(APP, 'Contents', 'Info.plist')]);

// 5) ad-hoc 서명: 애플 실리콘은 서명이 아예 없으면 실행을 막는다. 개발자 인증서 없이 「-」(ad-hoc)로
step('ad-hoc 서명');
run('codesign', ['--force', '--deep', '--sign', '-', APP]);
run('codesign', ['--verify', '--deep', '--strict', APP]);

if (MAKE_DMG) {
  // 6) dmg: 우사기.app + 응용 프로그램(/Applications) 바로가기, 압축(UDZO)
  step('dmg 만들기');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shisa-dmg-'));
  fs.chmodSync(root, 0o755); // dmg 맨 위 폴더(mkdtemp 는 700)
  try {
    run('ditto', [APP, path.join(root, `${APP_NAME}.app`)]);
    fs.symlinkSync('/Applications', path.join(root, '응용 프로그램'));
    const dmg = path.join(DIST, `Usagi-${VERSION}-${ARCH}.dmg`); // 파일 이름은 영문(GitHub 릴리스가 한글 파일 이름을 못 받는다). 앱 이름은 그대로 「우사기」
    fs.rmSync(dmg, { force: true });
    run('hdiutil', ['create', '-volname', `${APP_NAME} ${VERSION}`, '-srcfolder', root, '-fs', 'HFS+', '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', dmg]);
    const mb = (fs.statSync(dmg).size / 1024 / 1024).toFixed(1);
    console.log(`\n✓ ${path.relative(ROOT, dmg)} (${mb} MB)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  console.log(`\n✓ ${path.relative(ROOT, APP)}`);
}
