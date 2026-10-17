// 시사에게 줄 AI, 연결 안내(캘린더·슬랙). 슬랙 쿠키 복사는 넣지 않는다.
import { modKey } from './os-hint.js';
import { SETUP_SAY } from './character-say.js';

const MOD = modKey();

export { SISA_BASE as DEFAULT_PERSONA } from './persona.js';

export const AI_PROVIDERS = [
  {
    id: 'gemini',
    title: 'Gemini',
    blurb: '구글 AI입니다. 카드 없이 무료로 키를 만들 수 있습니다.',
    note: '무료 한도가 있어서 아주 많이 쓰면 잠시 막힐 수 있습니다. 그럴 땐 조금 뒤에 다시 됩니다.',
    keyHint: '',
    url: 'https://aistudio.google.com/apikey',
    rows: [
      { text: '브라우저에 **Google AI Studio** 가 열립니다.', link: true },
      '구글 계정으로 로그인합니다. 처음이면 약관이 나오는데, **동의**를 누릅니다.',
      '**Create API key** (API 키 만들기)를 누릅니다.',
      '프로젝트를 고르라고 하면 **Create API key in new project** 를 누릅니다.',
      '키가 생기면 그 줄의 **복사**를 누릅니다. **AQ.** 또는 **AIza**로 시작합니다.',
      { keys: [MOD, 'V'], text: '아래 칸에 붙이고 **확인**을 누릅니다.' },
    ],
    stuck: [
      '결제 카드를 넣으라는 화면이 나오면 멈추세요. 새 프로젝트로 다시 만들면 보통 나오지 않습니다.',
      '회사 구글 계정은 관리자가 막았을 수 있습니다. 개인 구글 계정을 쓰세요.',
      '챗지피티 무료 계정으로는 이런 키를 만들 수 없습니다. 그래서 Gemini를 권합니다.',
    ],
  },
  {
    id: 'claude',
    title: 'Claude',
    blurb: '앤트로픽 AI입니다. 키를 만들 수는 있지만, 크레딧을 사야 대답합니다.',
    note: '무료로는 안 됩니다. 결제 크레딧이 없으면 키가 맞아도 확인이 실패합니다.',
    keyHint: 'sk-ant-',
    url: 'https://console.anthropic.com/settings/keys',
    rows: [
      { text: '브라우저에 **Anthropic 콘솔**이 열립니다.', link: true },
      '로그인합니다. **Claude 앱 구독과는 별개**라서 콘솔 계정이 따로 필요합니다.',
      '왼쪽 **Billing** 에서 크레딧을 삽니다. 가장 적은 금액이면 됩니다.',
      '**Create Key** 를 누르고 이름을 아무거나 적습니다.',
      '**sk-ant-** 로 시작하는 키는 **한 번만** 보입니다. 바로 **Copy** 를 누릅니다.',
      { keys: [MOD, 'V'], text: '아래 칸에 붙이고 **확인**을 누릅니다.' },
    ],
    stuck: ['키를 못 복사하고 창을 닫았다면, 새 키를 다시 만드세요.'],
  },
  {
    id: 'openai',
    title: 'GPT',
    blurb: '오픈AI입니다. 챗지피티 계정과는 별개이고, 크레딧을 사야 합니다.',
    note: '챗지피티 무료·Plus 계정으로는 키가 만들어지지 않습니다. 플랫폼에서 따로 결제해야 합니다.',
    keyHint: 'sk-',
    url: 'https://platform.openai.com/api-keys',
    rows: [
      { text: '브라우저에 **OpenAI 플랫폼**이 열립니다.', link: true },
      '로그인합니다. 챗지피티 앱에 로그인했어도 여기서 한 번 더 해야 할 수 있습니다.',
      '**Billing** 에서 크레딧을 삽니다. 최소 5달러입니다.',
      '**Create new secret key** 를 누르고 이름을 아무거나 적습니다.',
      '**sk-** 로 시작하는 키는 **한 번만** 보입니다. 바로 **Copy** 를 누릅니다.',
      { keys: [MOD, 'V'], text: '아래 칸에 붙이고 **확인**을 누릅니다.' },
    ],
    stuck: ['크레딧이 반영되기까지 몇 분 걸릴 수 있습니다. 확인이 실패하면 조금 있다가 다시 누르세요.'],
  },
  {
    id: 'genspark',
    title: 'Genspark',
    blurb: 'Genspark 의 LLM 프록시입니다. 여러 회사 모델(Claude·GPT 등)을 키 하나로 씁니다. 유료 플랜이 있어야 대답합니다.',
    note: '무료 플랜으로는 대답하지 않습니다. 키는 맞아도 크레딧이 필요하다고 나옵니다.',
    keyHint: 'gsk-',
    url: 'https://www.genspark.ai',
    pricing: 'https://www.genspark.ai/pricing',
    cli: 'npm install -g @genspark/cli\ngsk login',
    rows: [
      { text: '브라우저에 **Genspark** 가 열립니다. 계정이 없으면 가입합니다.', link: true },
      '아래 **요금제 열기**에서 유료 플랜을 고릅니다. 무료 플랜은 API 를 쓸 수 없습니다.',
      '터미널에서 아래 명령으로 공식 CLI 를 깔고 로그인합니다. 키가 이 맥에 저장됩니다.',
      '아래 **gsk login 한 키 쓰기**를 누르면 그 키를 씁니다. 키는 설정 파일에 따로 저장하지 않습니다.',
      { keys: [MOD, 'V'], text: '키를 직접 붙여 넣어도 됩니다. **gsk-** 로 시작합니다. 붙인 뒤 **확인**을 누릅니다.' },
    ],
    stuck: [
      '「크레딧이 필요해요」가 나오면 키는 맞은 것입니다. 유료 플랜을 고른 뒤 다시 **확인**을 누르세요.',
      '「키가 맞지 않아요」가 나오면 터미널에서 **gsk login** 을 다시 하세요.',
    ],
  },
];

// 설치 마법사 「뇌 고르기」: 이 맥에서 찾은 Claude Code·Codex·Antigravity 는 "찾았어요 ✓" 로 바로, 키는 붙여 넣고 바로 확인.
// AI 는 선택이다: 「AI 없이 쓰기」(none)를 고르면 로컬 뇌로 정하고 다음 단계로 간다
export const BRAIN_CHOICES = [
  { id: 'claudecode', agent: 'claude', title: 'Claude Code', blurb: '이 맥에 로그인된 Claude Code 로 이야기해요. 키가 필요 없고, 코드 고치기·작업 세션도 돼요.' },
  { id: 'codexcli', agent: 'codex', title: 'Codex', blurb: '이 맥에 로그인된 Codex 로 이야기해요. 키가 필요 없고, 할 일 정리·지식그래프·코드 고치기도 Codex 로 돌아요. Claude Code 안에서 로그인한 연결(Slack 공식·Jira 등)은 Claude Code 뇌일 때만 읽혀요.' },
  { id: 'agycli', agent: 'agy', title: 'Antigravity (agy)', blurb: '이 맥에 로그인된 Antigravity CLI(agy)로 이야기해요. 키가 필요 없고, 할 일 정리·지식그래프도 agy 로 돌아요. 모델은 패널의 [모델] 탭에서 고를 수 있어요. 코드 고치기도 agy 로 해요. Claude Code 안에서 로그인한 연결(Slack 공식·Jira 등)은 Claude Code 뇌일 때만 읽혀요.' },
  { id: 'gemini', title: 'Gemini 키', blurb: '구글 AI 키를 붙여 넣어요. 카드 없이 무료로 만들 수 있어요.' },
  { id: 'openai', title: 'OpenAI(GPT) 키', blurb: 'OpenAI 플랫폼 키를 붙여 넣어요. 크레딧이 있어야 대답해요.' },
  { id: 'claude', title: 'Claude API 키', blurb: 'Anthropic 콘솔 키를 붙여 넣어요. 크레딧이 있어야 대답해요.' },
  { id: 'genspark', title: 'Genspark', blurb: 'gsk login 한 키를 쓰거나 키를 붙여 넣어요. Claude·GPT 등 여러 모델을 고를 수 있어요. 유료 플랜이 있어야 대답해요.' },
  { id: 'none', local: true, title: 'AI 없이 쓰기', blurb: '준비물도 결제도 필요 없어요. 할 일, 할 일의 「오늘」, 캘린더 회의 알림, 인사와 응원은 그대로 돼요. AI는 나중에 설정에서 언제든 연결할 수 있어요.' },
];
// 「더 연결하기」(선택): 캘린더 주소(구글·Outlook) · Slack · 레포 폴더. 이 Mac 캘린더·미리알림과 작업 기록 읽기는 같은 화면의 따로 칸
export const EXTRAS = ['gcal', 'outlook', 'slack', 'repos'];

// 「더 연결하기」의 작업 기록 읽기(선택, 처음엔 꺼짐). 켜야만 데몬이 이 맥(과 sessionHosts 서버)의 세션 기록을 읽는다
export const SESSIONS_CONSENT = {
  title: '내 Claude Code·Codex 작업 기록 읽기',
  blurb: '이 맥에 남은 Claude Code·Codex 대화 기록(~/.claude/projects, ~/.codex/sessions)을 읽어서 최근 작업 폴더와 할 일 진행을 정리해요. config.json 의 sessionHosts 에 ssh 서버를 적어 두면 그 서버의 기록도 받아 와요.',
  warn: '기록에는 다른 작업 폴더 내용이나 대화 중에 붙여 넣은 메시지도 들어 있을 수 있어요. 켜지 않으면 읽지 않고, 설정에서 언제든 끌 수 있어요.',
};

export function providerById(id) {
  return AI_PROVIDERS.find((p) => p.id === id) ?? null;
}

// AI가 없을 때 시사가 하는 정해진 말(돌려 쓴다)은 canned.js 에 있다.
export { CANNED, cannedReply, resetCanned } from './canned.js';

export const HUB = [
  { id: 'gcal', title: '구글 캘린더', blurb: '내 일정을 읽습니다. 캘린더마다 비밀 주소를 붙여 넣으면 되고, 여러 개 붙일 수 있습니다.', kind: 'done' },
  { id: 'outlook', title: 'Outlook 캘린더', blurb: '내 일정을 읽습니다. 여러 개 붙일 수 있고 구글 캘린더와 같이 써도 됩니다. 회사가 일정 게시를 막았으면 쓸 수 없습니다.', kind: 'done' },
  { id: 'slack', title: 'Slack', blurb: '내 DM과 나를 멘션한 글을 읽습니다. 읽기 전용 Slack 앱을 하나 만들어 토큰을 붙입니다. 어떤 뇌든 되고, 팀 워크스페이스는 관리자 승인이 필요할 수 있습니다.', kind: 'done' },
  { id: 'repos', title: '레포 폴더', blurb: '코드를 고치게 할 레포가 모인 폴더(예: 홈의 code 폴더)를 알려 주세요. 적은 폴더만 읽고, 그 안 레포의 내 커밋을 개요에 보여 줘요. 코드 고치기는 Claude Code·Codex·Antigravity 중 하나가 있을 때 돼요.', kind: 'folder' },
];

// 시사가 말풍선으로 하는 말
export const SISA_SAY = {
  name: '안녕하세요, 저는 **시사**예요.\n뭐라고 불러 드릴까요?',
  brain: '**AI**를 연결하면 저랑 자유롭게 이야기할 수 있어요.\nAI 없이도 할 일, 할 일의 「오늘」, 회의 알림은 **그대로** 돼요.\n이 맥에서 찾은 게 있으면 바로 고르면 돼요.',
  extras: '더 연결하고 싶은 게 있으면 **골라** 주세요.\n전부 **선택**이에요. 건너뛰어도 돼요.\n고른 것 말고는 **아무것도 읽지 않아요**.',
  done: '준비 끝! 🎉\n어떻게 쓰는지 **짧게** 보여 드릴까요?',
};

// 고른 캐릭터의 설치 화면 말(character-say.js). 없는 키는 시사 말
export function sayFor(character) {
  const own = Object.hasOwn(SETUP_SAY, character ?? '') ? SETUP_SAY[character] : null;
  return own ? { ...SISA_SAY, ...own } : SISA_SAY;
}

export function hubItem(id) {
  return HUB.find((h) => h.id === id) ?? null;
}

// 칸에 붙인 값이 맞는 모양인지. 규칙이 없는 칸은 그냥 통과.
const SLOT_RULES = {
  gcal: {
    ok: /^https:\/\/calendar\.google\.com\/calendar\/ical\/\S+\.ics(\?\S*)?$/,
    bad: '주소가 **https://calendar.google.com/calendar/ical/** 로 시작하고 **.ics** 로 끝나야 합니다. **iCal 형식의 비공개 주소**를 복사했는지 보세요.',
  },
  slack: {
    ok: /^xoxp-[0-9A-Za-z-]{20,300}$/,
    bad: '토큰이 **xoxp-** 로 시작해야 합니다. **User OAuth Token** 을 복사했는지 보세요(xoxb-·xapp- 는 아닙니다).',
  },
  outlook: {
    ok: /^https:\/\/\S+\.ics(\?\S*)?$/,
    bad: '주소가 **https://** 로 시작하고 **.ics** 로 끝나야 합니다. **HTML** 이 아니라 **ICS** 주소를 복사하세요.',
  },
};

export function slotCheck(id, value) {
  const rule = SLOT_RULES[id];
  const v = String(value ?? '').trim();
  if (!rule) return { ok: true, bad: '' };
  return { ok: rule.ok.test(v), bad: rule.bad };
}

export function slotOk(id, value) {
  return slotCheck(id, value).ok;
}

export function connectSteps(id) {
  if (id === 'gcal') return GCAL;
  if (id === 'outlook') return OUTLOOK;
  if (id === 'slack') return SLACK_STEPS;
  return [];
}

const GCAL = [
  {
    id: 'gcal-open',
    title: '구글 캘린더 설정을 여세요',
    identity: '일정 주소 하나만 복사합니다. 구글 비밀번호는 필요 없습니다.',
    rows: [
      { text: '브라우저에 **구글 캘린더 설정**이 열립니다.', link: true },
      '구글 계정으로 로그인합니다. 이미 되어 있으면 바로 설정이 열립니다.',
    ],
    url: 'https://calendar.google.com/calendar/u/0/r/settings',
  },
  {
    id: 'gcal-copy',
    title: '비공개 주소를 복사하세요',
    identity: '이 주소는 **비밀번호와 같습니다.** 채팅이나 메신저에 붙이지 마세요.',
    rows: [
      '왼쪽 위 **일반** 섹션 아래 **내 캘린더의 설정** 이라는 탭을 찾습니다.',
      '그 아래 **내 이름**(쓰는 캘린더)을 누릅니다.',
      '방금 누른 이름 아래 **캘린더 통합** 을 누릅니다.',
      '안 보이면 오른쪽을 **맨 아래**까지 내립니다. 제일 마지막에 있습니다.',
      '공개 URL은 건너뛰고, **iCal 형식의 비공개 주소** 옆 **복사**를 누릅니다.',
    ],
    details: [
      '왼쪽 목록이 접혀 있으면 **내 캘린더의 설정** 옆 화살표를 눌러 펼칩니다.',
      '캘린더 통합이나 비공개 주소가 안 보이면 회사 관리자가 막은 것입니다. 목록으로 돌아가 이 기능은 건너뛰세요.',
      '주소가 남에게 알려졌다면 같은 칸의 **재설정** 을 눌러 새 주소를 받으세요.',
    ],
  },
  {
    id: 'gcal-save',
    title: '복사한 주소를 붙이세요',
    identity: '맞는 주소가 들어오면 **다음**이 켜집니다.',
    slots: [{ id: 'gcal', placeholder: 'https://calendar.google.com/calendar/ical/...', label: '비공개 주소', hint: '복사한 주소를 여기에 붙이기' }],
    slotNote: '이 맥의 설정 파일(~/.cy-agent/config.json)에만 저장합니다. 서버로 보내지 않습니다.',
  },
];

const OUTLOOK = [
  {
    id: 'outlook-open',
    title: 'Outlook 캘린더를 여세요',
    identity: '회사 계정으로 로그인합니다. 일정 주소 하나만 복사합니다.',
    rows: [
      { text: '브라우저에 **Outlook 캘린더**가 열립니다.', link: true },
      '회사 계정으로 로그인합니다.',
    ],
    url: 'https://outlook.office.com/calendar/',
  },
  {
    id: 'outlook-copy',
    title: '일정을 게시하고 ICS 주소를 복사하세요',
    identity: '이 주소는 **비밀번호와 같습니다.** 채팅에 붙이지 마세요.',
    rows: [
      '오른쪽 위 **톱니바퀴** 를 누르고 **모든 Outlook 설정 보기** 를 누릅니다.',
      '**캘린더** → **공유 캘린더** 로 갑니다.',
      '**캘린더 게시** 에서 내 캘린더를 고르고, 권한을 **모든 세부 정보 보기** 로 바꾼 뒤 **게시** 를 누릅니다.',
      '나온 주소 두 개 중 **ICS**를 복사합니다.',
    ],
    details: [
      '캘린더 게시가 안 보이면 회사 관리자가 막은 것입니다. 목록으로 돌아가 이 기능은 건너뛰세요.',
      '게시를 취소하면 그 주소는 바로 못 쓰게 됩니다.',
    ],
  },
  {
    id: 'outlook-save',
    title: '복사한 주소를 붙이세요',
    identity: '맞는 주소가 들어오면 **다음**이 켜집니다.',
    slots: [{ id: 'outlook', placeholder: 'https://outlook.office365.com/owa/calendar/...ics', label: 'ICS 주소', hint: '복사한 주소를 여기에 붙이기' }],
    slotNote: '이 맥의 설정 파일(~/.cy-agent/config.json)에만 저장합니다. 서버로 보내지 않습니다.',
  },
];

// Slack: 읽기 전용 앱(봇 없음, ops/slack-readonly-manifest.yaml)의 사용자 토큰(xoxp-)을 붙인다 → connectors.slack { mode: "api", userToken }.
// 어떤 뇌든 되고, 데몬이 5분마다 내 DM·멘션만 모아 두어 지시사항 카드·할 일로 쓴다(agent/src/ingest/slack-api.ts — 쓰기 메서드는 막힘).
// Claude Code 의 Slack 공식 MCP 로그인(mode: mcp)은 docs/connect/slack.md 의 (b)로 따로 안내한다
export const SLACK_MANIFEST = `display_information:
  name: usagi-reader
  description: 내 DM과 나를 멘션한 글을 내 컴퓨터에서 읽기만 합니다
  background_color: "#3b2a5c"
oauth_config:
  scopes:
    user:
      - channels:history  # 공개 채널 메시지(나를 멘션한 글)
      - groups:history    # 내가 들어간 비공개 채널 메시지
      - im:history        # DM 메시지
      - mpim:history      # 그룹 DM 메시지
      - channels:read     # 채널 목록·이름
      - groups:read
      - im:read
      - mpim:read
      - users:read        # 사람 이름
      - search:read       # 멘션·참여 스레드 검색
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
// Slack 이 지원하는 매니페스트 미리 채우기 링크(https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests). 주석은 빼서 짧게
export const SLACK_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(SLACK_MANIFEST.replace(/\s+#.*$/gm, ''))}`;
const SLACK_STEPS = [
  {
    id: 'slack-app',
    title: '읽기 전용 Slack 앱을 만드세요',
    identity: '봇 없이 **읽기 권한만** 있는 내 앱입니다. 내 DM과 나를 멘션한 글만 읽고, 쓰기는 못 합니다.',
    rows: [
      { text: '브라우저에 아래 매니페스트가 **미리 채워진** Slack 앱 만들기 화면이 열립니다.', link: true },
      '워크스페이스를 고르고 **Next** → 내용 확인 → **Create** 를 누릅니다.',
      '왼쪽 **Install App** → **Install to Workspace** → **허용**을 누릅니다.',
    ],
    details: [
      '워크스페이스 앱 목록에는 앱 이름이 보입니다. 다른 이름을 쓰려면 Create 전 화면에서 `name` 을 바꾸면 됩니다.',
      '화면에 매니페스트가 비어 있으면 **From a manifest** → **YAML** 탭에 아래 내용을 통째로 붙여 넣습니다.',
      '「관리자에게 요청」이 나오면 요청을 보내고, 승인되면 같은 화면에서 이어 갑니다. 요청 메모에는 「제 DM과 멘션을 제 컴퓨터에서만 읽는 개인 비서, 쓰기 권한 없음」이라고 적으면 됩니다.',
      '앱을 만들 수 없는 워크스페이스라면 Claude Code 의 Slack 공식 MCP 로그인으로도 읽을 수 있습니다(뇌가 Claude Code 일 때만, 지시사항 카드는 비어 있음). docs/connect/slack.md 의 (b)를 보세요.',
    ],
    url: SLACK_APP_URL,
    codeLabel: '매니페스트 · 링크로 채워지지 않았을 때 붙여 넣기',
    code: SLACK_MANIFEST,
  },
  {
    id: 'slack-token',
    title: 'User OAuth Token 을 붙이세요',
    identity: '설치가 끝나면 **OAuth & Permissions** 화면에 **User OAuth Token**(xoxp-…)이 생깁니다. **Copy** 를 눌러 붙입니다.',
    slots: [{ id: 'slack', placeholder: 'xoxp-...', label: 'User OAuth Token', hint: '복사한 토큰을 여기에 붙이기' }],
    slotNote: '이 맥의 설정 파일(~/.cy-agent/config.json)에만 저장합니다. 읽기 권한만 있는 토큰이고 서버로 보내지 않습니다.',
  },
];
