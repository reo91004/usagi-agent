// 설치 마법사 connect 단계에서 claude·codex·agy 를 설치하고 로그인하는 안내.
import { WIN, modKey, terminalRow, claudeInstall } from './os-hint.js';

// win: 윈도우 문구(PowerShell·Ctrl). 기본은 렌더러 userAgent
export function agentSteps(agent, win = WIN) {
  // Antigravity(agy)는 뇌(AI)로만 연결한다(MCP 등록 대상 아님). 설치 명령은 공식 안내를 따른다
  if (agent === 'agy') {
    return [
      {
        id: 'agy-install',
        feature: 'agent',
        title: 'Antigravity CLI(agy)를 설치하세요',
        identity: 'Google Antigravity 공식 안내대로 CLI 를 설치합니다. 설치가 끝나면 터미널에서 **agy** 명령이 열려야 합니다.',
        rows: ['설치가 끝나면 **다음**을 누릅니다.'],
        details: ['agy 는 보통 ~/.local/bin 에 깔립니다.'],
      },
      {
        id: 'agy-login',
        feature: 'agent',
        gate: 'login',
        title: '터미널에서 agy 에 로그인하세요',
        identity: '**Google 계정**으로 로그인합니다. 로그인이 끝나면 이 화면에 저절로 **완료**가 뜹니다.',
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: '아래 **agy** 를 붙이고 **↩** 를 누릅니다.' },
          '안내에 따라 로그인한 뒤 agy 를 끝냅니다(Ctrl+C).',
          '이 화면에 **완료**가 뜨면 **다음**을 누릅니다.',
        ],
        details: ['`agy models` 가 모델 목록을 보여 주면 로그인된 것입니다.'],
        codeLabel: '터미널에 붙여 넣기',
        code: 'agy',
      },
    ];
  }
  if (agent === 'codex') {
    return [
      {
        id: 'codex-install',
        feature: 'agent',
        title: 'Codex를 설치하세요',
        identity: '터미널에 명령 한 줄을 붙입니다. 몇 분 걸릴 수 있습니다.',
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: '아래 명령을 붙이고 **↩** 를 누릅니다.' },
          '글이 멈추고 입력 줄이 다시 나오면 끝난 것입니다.',
        ],
        details: ['npm 이 없다고 나오면 Node.js 를 먼저 설치해야 합니다. nodejs.org 에서 받을 수 있습니다.'],
        codeLabel: '터미널에 붙여 넣기',
        code: 'npm install -g @openai/codex',
      },
      {
        id: 'codex-login',
        feature: 'agent',
        gate: 'login',
        title: '터미널에서 Codex에 로그인하세요',
        identity: '**ChatGPT 유료 계정**이 필요합니다. 로그인이 끝나면 이 화면에 저절로 **완료**가 뜹니다.',
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: '아래 **codex login** 을 붙이고 **↩** 를 누릅니다.' },
          '브라우저가 열리면 **ChatGPT 계정**으로 로그인합니다.',
          '이 화면에 **완료**가 뜨면 **다음**을 누릅니다.',
        ],
        details: ['브라우저가 안 열리면 터미널에 나온 주소를 복사해 크롬에 붙이세요.', '터미널에 codex 만 치면 그 안에 남아서 끝나지 않습니다. 꼭 codex login 을 치세요.'],
        codeLabel: '터미널에 붙여 넣기',
        code: 'codex login',
      },
    ];
  }
  if (agent === 'claude') {
    return [
      {
        id: 'claude-install',
        feature: 'agent',
        title: 'Claude Code를 설치하세요',
        identity: '터미널에 명령 한 줄을 붙입니다. 몇 분 걸릴 수 있습니다.',
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: '아래 명령을 붙이고 **↩** 를 누릅니다.' },
          '글이 멈추고 입력 줄이 다시 나오면 끝난 것입니다.',
        ],
        codeLabel: '터미널에 붙여 넣기',
        code: claudeInstall(win),
      },
      {
        id: 'claude-login',
        feature: 'agent',
        gate: 'login',
        title: '터미널에서 Claude Code에 로그인하세요',
        identity: '**유료 Claude 계정**이 필요합니다. 로그인이 끝나면 이 화면에 저절로 **완료**가 뜹니다.',
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: '아래 **claude auth login** 을 붙이고 **↩** 를 누릅니다.' },
          '브라우저가 열리면 **Claude 계정**으로 로그인합니다.',
          '이 화면에 **완료**가 뜨면 **다음**을 누릅니다.',
        ],
        details: ['브라우저가 안 열리면 터미널에 나온 주소를 복사해 크롬에 붙이세요.', '터미널에 claude 만 치면 그 안에 남아서 끝나지 않습니다. 꼭 claude auth login 을 치세요.'],
        codeLabel: '터미널에 붙여 넣기',
        code: 'claude auth login',
      },
    ];
  }
  return [];
}
