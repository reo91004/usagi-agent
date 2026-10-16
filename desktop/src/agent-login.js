// Claude Code / Codex / Antigravity(agy) 가 이 맥에 로그인돼 있는지. 토큰 값은 밖으로 내지 않는다.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execBin } from './win-exec.js';

export function parseClaudeAuth(stdout) {
  const text = String(stdout ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  try {
    return JSON.parse(text.slice(start, end + 1))?.loggedIn === true;
  } catch {
    return false;
  }
}

export function codexAuthLoggedIn(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const token = j?.tokens?.access_token;
    return typeof token === 'string' && token.length > 20;
  } catch {
    return false;
  }
}

export function findBin(name, { home = os.homedir(), pathEnv = process.env.PATH || '', exists = fs.existsSync, readdir = fs.readdirSync, platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return findWinBin(name, { home, pathEnv, exists, env });
  const p = path.posix;
  // 공식 설치(~/.local/bin) → homebrew → PATH 순. nvm 은 맨 마지막: 옛 node 버전에 남은 npm 전역 복사본(#!/usr/bin/env node)이
  // 앱(PATH 에 node 없음)에서는 뜨지도 않아, 먼저 고르면 멀쩡히 로그인된 claude 를 두고 「로그인 전」으로 본다
  const dirs = [p.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...String(pathEnv).split(':').filter(Boolean)];
  try {
    const root = p.join(home, '.nvm', 'versions', 'node');
    const ver = (n) => String(n).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
    const newest = [...readdir(root)].sort((a, b) => { const [x, y] = [ver(a), ver(b)]; return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]); });
    for (const n of newest) dirs.push(p.join(root, n, 'bin'));
  } catch { /* nvm 없음 */ }
  for (const d of dirs) {
    const f = p.join(d, name);
    if (exists(f)) return f;
  }
  return null;
}

// 윈도우: ~/.local/bin(Claude Code 설치 스크립트) · %APPDATA%\npm(npm 전역) · PATH(;) 순서로, PATHEXT 의 .exe/.cmd/.bat/.com 을 붙여 본다.
// 확장자 없는 같은 이름(npm 이 같이 까는 sh 스크립트)은 못 띄우니 안 고른다
const RUNNABLE = ['.com', '.exe', '.bat', '.cmd'];
export function winExts(pathext) {
  const list = String(pathext || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => RUNNABLE.includes(e));
  return list.length ? [...new Set(list)] : ['.exe', '.cmd'];
}
function findWinBin(name, { home, pathEnv, exists, env }) {
  const w = path.win32;
  const envOf = (k) => env?.[Object.keys(env ?? {}).find((x) => x.toUpperCase() === k)];
  const dirs = [w.join(home, '.local', 'bin')];
  if (envOf('APPDATA')) dirs.push(w.join(envOf('APPDATA'), 'npm'));
  dirs.push(...String(pathEnv).split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean));
  const has = RUNNABLE.includes(w.extname(name).toLowerCase());
  const names = has ? [name] : winExts(envOf('PATHEXT')).map((e) => name + e);
  for (const d of dirs) {
    for (const n of names) {
      const f = w.join(d, n);
      if (exists(f)) return f;
    }
  }
  return null;
}

export function readCodexLoggedIn(home = os.homedir(), readFile = fs.readFileSync) {
  try {
    return codexAuthLoggedIn(readFile(path.join(home, '.codex', 'auth.json'), 'utf8'));
  } catch {
    return false;
  }
}

// `agy models` 출력: "Fetching available models..." 다음에 줄마다 `<id>\t<label>`. 탭 없는 줄은 모델이 아니다
export function parseAgyModels(stdout) {
  return String(stdout ?? '').split('\n').map((l) => l.replace(/\r$/, '').split('\t'))
    .filter((c) => c.length >= 2 && /^[A-Za-z0-9._:/-]{1,100}$/.test(c[0].trim()))
    .map((c) => ({ id: c[0].trim(), label: c[1].trim() }));
}

function runStatus(bin, args, read, timeout = 8000) {
  return new Promise((resolve) => {
    execBin(execFile, bin, args, { timeout, maxBuffer: 64 * 1024 }, (err, stdout) => {
      resolve(read(err, stdout));
    });
  });
}

// agy 는 로그인 확인 명령이 따로 없다: `agy models` 가 종료 코드 0 이고 모델이 한 줄이라도 나오면 로그인됨(로그아웃 때 동작은 미확인 → 아니면 로그인 전으로 본다)
export function agyModelsOf(err, stdout) {
  return err ? [] : parseAgyModels(stdout);
}

export async function agentLogin(agent, deps = {}) {
  const locate = deps.findBin ?? findBin;
  if (agent === 'claude') {
    const bin = locate('claude');
    if (!bin) return { installed: false, loggedIn: false };
    const loggedIn = await runStatus(bin, ['auth', 'status'], (_err, stdout) => parseClaudeAuth(stdout));
    return { installed: true, loggedIn };
  }
  if (agent === 'codex') {
    if ((deps.readCodexLoggedIn ?? readCodexLoggedIn)()) return { installed: !!locate('codex'), loggedIn: true };
    const bin = locate('codex');
    if (!bin) return { installed: false, loggedIn: false };
    const loggedIn = await runStatus(bin, ['login', 'status'], (_err, stdout) => {
      const text = String(stdout ?? '');
      return /logged in/i.test(text) && !/not logged in/i.test(text);
    });
    return { installed: true, loggedIn };
  }
  if (agent === 'agy') {
    const bin = locate('agy');
    if (!bin) return { installed: false, loggedIn: false };
    const loggedIn = await runStatus(bin, ['models'], (err, stdout) => agyModelsOf(err, stdout).length > 0, 20000);
    return { installed: true, loggedIn };
  }
  return { installed: false, loggedIn: false };
}
