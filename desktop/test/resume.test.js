// 작업 세션 "Claude Code에서 열기": 세션 id·경로 거르기 · 프로젝트 폴더 이름 · 셸/AppleScript 이스케이프 · 계획 · IPC 배선
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ipcHandlers, buildHandler, decl } from './helpers/main-calls.js';
import { denied } from '../src/denied.js';
import {
  okSessionId, okCwd, projectDirName, sessionFile, shQuote, resumeCommand, appleString, terminalArgs, planResume, canResume, resumeTip,
  parseSessionId, importNote, sessionCwd, winResumeLaunches,
} from '../src/resume.js';

const HOME = '/Users/a.b';
const SID = '0b5f3c2e-1a2b-4c3d-9e8f-001122334455';

test('okSessionId: UUID 만', () => {
  assert.equal(okSessionId(SID), true);
  assert.equal(okSessionId(SID.toUpperCase()), true);
  for (const bad of [null, '', 'abc', `${SID}x`, `${SID}; rm -rf ~`, SID.replace(/-/g, ''), 42]) assert.equal(okSessionId(bad), false, String(bad));
});

test('okCwd: 홈 아래 절대 경로, 따옴표·줄바꿈·.. 없이', () => {
  assert.equal(okCwd(`${HOME}/.cy-agent/brain`, HOME), true);
  assert.equal(okCwd(`${HOME}/code/my repo`, `${HOME}/`), true); // 빈칸은 따옴표로 감싸니 괜찮다
  for (const bad of [HOME, `${HOME}x/y`, '/tmp/x', 'rel/x', `${HOME}/a/../../etc`, `${HOME}/./a`, `${HOME}//a`, `${HOME}/a'b`, `${HOME}/a"b`, `${HOME}/a\nb`, `${HOME}/a\\b`, `${HOME}/a\`b`, null]) {
    assert.equal(okCwd(bad, HOME), false, JSON.stringify(bad));
  }
  assert.equal(okCwd(`${HOME}/a`, 'relative'), false);
});

test('projectDirName·sessionFile: 영숫자 밖은 "-"', () => {
  assert.equal(projectDirName('/Users/me.name/.cy-agent/brain'), '-Users-me-name--cy-agent-brain');
  assert.equal(projectDirName('/Users/a/.cy-agent/worktrees/cy_fix-1'), '-Users-a--cy-agent-worktrees-cy-fix-1');
  assert.equal(sessionFile(`${HOME}/.claude/`, `${HOME}/x`, SID), `${HOME}/.claude/projects/-Users-a-b-x/${SID}.jsonl`);
});

test('shQuote·resumeCommand·appleString·terminalArgs: 셸 작은따옴표 → AppleScript 문자열', () => {
  assert.equal(shQuote("a'b"), `'a'\\''b'`);
  assert.equal(resumeCommand('/x/my dir', SID), `cd '/x/my dir' && claude --resume '${SID}'`);
  assert.equal(appleString('a"b\\c'), '"a\\"b\\\\c"');
  const args = terminalArgs(resumeCommand('/x', SID));
  assert.deepEqual(args, ['-e', `tell application "Terminal" to do script "cd '/x' && claude --resume '${SID}'"`, '-e', 'tell application "Terminal" to activate']);
});

test('planResume: 기록 파일 있어야, 폴더가 없으면 워크트리 아래만 다시 만든다', () => {
  const claudeDir = `${HOME}/.claude`, worktreesDir = `${HOME}/.cy-agent/worktrees`;
  const brain = `${HOME}/.cy-agent/brain`, wt = `${worktreesDir}/cy-fix-1`;
  const have = (...paths) => (p) => paths.includes(p);
  const opts = (exists) => ({ home: HOME, claudeDir, worktreesDir, exists });
  const chat = { id: 'r1', kind: 'chat', sdkSessionId: SID, cwd: brain };
  const ok = planResume(chat, opts(have(brain, sessionFile(claudeDir, brain, SID))));
  assert.deepEqual([ok.ok, ok.cwd, ok.sid, ok.mkdir], [true, brain, SID, false]);
  assert.deepEqual(ok.args, terminalArgs(resumeCommand(brain, SID)));
  assert.equal(planResume(chat, opts(have(brain))).error, '이 세션 기록을 찾을 수 없어요.');
  assert.equal(planResume({ ...chat, sdkSessionId: undefined }, opts(() => true)).ok, false);
  assert.equal(planResume({ ...chat, cwd: '/etc' }, opts(() => true)).ok, false);
  // 지워진 워크트리: 기록만 있으면 빈 폴더를 다시
  const fix = { id: 'r2', kind: 'fix', sdkSessionId: SID, cwd: wt };
  const re = planResume(fix, opts(have(sessionFile(claudeDir, wt, SID))));
  assert.deepEqual([re.ok, re.mkdir], [true, true]);
  // 워크트리 밖 폴더가 없어졌으면 못 연다
  const gone = `${HOME}/code/gone`;
  assert.match(planResume({ ...fix, cwd: gone }, opts(have(sessionFile(claudeDir, gone, SID)))).error, /작업 폴더가 없어져서/);
  assert.equal(planResume({ ...fix, cwd: `${HOME}/.cy-agent/worktreesX/a` }, opts(have(sessionFile(claudeDir, `${HOME}/.cy-agent/worktreesX/a`, SID)))).ok, false);
});

test('canResume·resumeTip: 세션 id 있을 때만, 도는 중이면 경고', () => {
  assert.equal(canResume({ sdkSessionId: SID, cwd: '/x' }), true);
  assert.equal(canResume({ sdkSessionId: SID }), false);
  assert.equal(canResume({ cwd: '/x' }), false);
  assert.equal(canResume(null), false);
  assert.doesNotMatch(resumeTip({ status: 'done' }), /갈라질/);
  assert.match(resumeTip({ status: 'running' }), /두 곳에서 동시에 이어가면 기록이 갈라질 수 있어요/);
});

test('parseSessionId·importNote: 붙여 넣은 글에서 UUID 하나 · 결과 한 줄', () => {
  assert.equal(parseSessionId(SID), SID);
  assert.equal(parseSessionId(`  claude --resume ${SID.toUpperCase()}\n`), SID);
  assert.equal(parseSessionId(`~/.claude/projects/-Users-x/${SID}.jsonl`), SID);
  for (const bad of [null, '', 'abc', SID.replace(/-/g, ''), `${SID.slice(0, 20)}`]) assert.equal(parseSessionId(bad), null, String(bad));
  assert.equal(importNote({ imported: 5 }), 'Claude Code 세션 기록 5줄을 불러왔어요.');
  assert.equal(importNote({ imported: 0 }), '세션을 만들었지만 불러올 터미널 기록이 없었어요.');
  assert.equal(importNote({ imported: 2, existing: true }), '이미 있던 세션이에요 — 새 기록 2줄을 더 불러왔어요.');
  assert.equal(importNote({ imported: 0, existing: true }), '이미 있던 세션이에요.');
});

const WHOME = 'C:\\Users\\a.b';

test('윈도우 okCwd·canResume·sessionCwd: 드라이브 경로도 홈 아래만, 대소문자 무시, cmd 특수문자·.. 금지', () => {
  assert.equal(okCwd(`${WHOME}\\.cy-agent\\brain`, WHOME), true);
  assert.equal(okCwd('c:\\users\\A.B\\code\\my repo', `${WHOME}\\`), true);
  assert.equal(okCwd('C:/Users/a.b/code/x', WHOME), true);
  assert.equal(okCwd(`${WHOME}\\code\\a&b (old)`, WHOME), true); // cmd 줄에선 따옴표 안이라 괜찮다
  for (const bad of [WHOME, `${WHOME}x\\y`, 'D:\\Users\\a.b\\x', 'C:\\Windows\\x', 'rel\\x', '\\\\srv\\share\\x', `${WHOME}\\a\\..\\..\\x`, `${WHOME}\\.\\a`, `${WHOME}\\\\a`,
    `${WHOME}\\a"b`, `${WHOME}\\a'b`, `${WHOME}\\a\nb`, `${WHOME}\\%PATH%`, `${WHOME}\\a!b`, `${WHOME}\\a^b`, `${WHOME}\\a;b`, `${WHOME}\\a:b`, `${WHOME}\\a.`, `${WHOME}\\a `, null]) {
    assert.equal(okCwd(bad, WHOME), false, JSON.stringify(bad));
  }
  assert.equal(okCwd('/Users/a.b/x', WHOME), false);
  assert.equal(okCwd(`${WHOME}\\x`, HOME), false); // 맥 홈엔 윈도우 경로 안 받음(그대로)
  assert.equal(projectDirName('C:\\Users\\a'), 'C--Users-a');
  assert.equal(sessionFile(`${WHOME}\\.claude\\`, `${WHOME}\\x`, SID), `${WHOME}\\.claude\\projects\\C--Users-a-b-x\\${SID}.jsonl`);
  assert.equal(canResume({ sdkSessionId: SID, cwd: 'C:\\x' }), true);
  assert.equal(canResume({ sdkSessionId: SID, cwd: 'x\\y' }), false);
  const text = [JSON.stringify({ cwd: 'rel' }), JSON.stringify({ cwd: 'C:\\Users\\a\\b' })].join('\n');
  assert.equal(sessionCwd(text, null), 'C:\\Users\\a\\b');
  assert.equal(sessionCwd(`${JSON.stringify({ cwd: '/x' })}\n${JSON.stringify({ cwd: 'C:\\y' })}`, 'C--y'), 'C:\\y');
});

test('winResumeLaunches: Windows Terminal 이 있으면 먼저, 다음은 cmd start — 셸 없이 execFile 그대로', () => {
  const cwd = `${WHOME}\\code\\my repo`;
  const wt = 'C:\\Users\\a.b\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';
  const [a, b] = winResumeLaunches(cwd, SID, { wt });
  assert.deepEqual(a, { file: wt, args: ['-d', cwd, 'cmd.exe', '/k', 'claude', '--resume', SID] });
  assert.deepEqual(b, { file: 'cmd.exe', args: ['/d', '/c', `start "" /D "${cwd}" cmd.exe /k claude --resume ${SID}`], verbatim: true });
  assert.equal(winResumeLaunches(cwd, SID).length, 1);
  assert.deepEqual(winResumeLaunches(cwd, `${SID} & calc`), []);
  for (const bad of [`${WHOME}\\a"b`, `${WHOME}\\%x%`, '/x', `${WHOME}\\a;b`]) assert.deepEqual(winResumeLaunches(bad, SID, { wt }), [], bad);
});

test('planResume win32: launches 로, 워크트리 밖 사라진 폴더는 못 연다', () => {
  const claudeDir = `${WHOME}\\.claude`, worktreesDir = `${WHOME}\\.cy-agent\\worktrees`;
  const wt = `${worktreesDir}\\cy-fix-1`;
  const have = (...paths) => (p) => paths.includes(p);
  const opts = (exists) => ({ home: WHOME, claudeDir, worktreesDir, exists, platform: 'win32', wt: null });
  const run = { sdkSessionId: SID, cwd: wt };
  const re = planResume(run, opts(have(sessionFile(claudeDir, wt, SID))));
  assert.deepEqual([re.ok, re.mkdir, re.args], [true, true, undefined]);
  assert.deepEqual(re.launches, winResumeLaunches(wt, SID));
  const gone = `${WHOME}\\code\\gone`;
  assert.match(planResume({ ...run, cwd: gone }, opts(have(sessionFile(claudeDir, gone, SID)))).error, /작업 폴더가 없어져서/);
  // 홈 밖 기록은 못 연다
  assert.equal(planResume({ ...run, cwd: 'C:\\Windows\\x' }, opts(() => true)).ok, false);
});

// session-claude 핸들러를 가짜 데몬·execFile 로. plan = planResume 이 돌려줄 값
function claudeRun({ platform, plan, execResults = [], run = { id: 'r1' }, env = {}, existing = [] }) {
  const log = { exec: [], posts: [], plans: [] };
  const deps = {
    denied, fromOurs: (e) => e.ours, okRunId: (id) => /^r\d+$/.test(id), okSessionId, who: () => '시사',
    request: async () => ({ ok: true, data: { run } }),
    post: async (...a) => { log.posts.push(a); return { ok: true }; },
    os: { homedir: () => '/home/me' }, path: { join: (...a) => a.join('/') }, fs: { existsSync: () => false, mkdirSync() {}, lstatSync: (p) => { if (!existing.includes(p)) throw new Error('ENOENT'); } },
    process: { platform, env }, findSessionCwd: () => null, consoleEnv: () => ({ PATH: 'x' }),
    planResume: (r, o) => { log.plans.push([r, o]); return plan; },
    execFile: (file, args, opts, cb) => { log.exec.push([file, args, opts]); cb(execResults.shift() ?? null); },
    windowsTerminal: () => null,
  };
  const h = buildHandler(ipcHandlers().get('session-claude'), deps);
  return { log, deps, run: (e = { ours: true }, id = 'r1') => h(e, id) };
}

test('session-claude: 우리 창·run id 만, 윈도우는 plan.launches 를 execFile 로 차례로(셸 없이)', async () => {
  const launches = [{ file: 'wt.exe', args: ['a'] }, { file: 'cmd.exe', args: ['/k', 'x'], verbatim: true }];
  const w = claudeRun({ platform: 'win32', plan: { ok: true, launches, cwd: 'C:\\x' }, execResults: [new Error('no wt')] });
  assert.deepEqual(await w.run({ ours: false }), denied());
  assert.deepEqual(await w.run({ ours: true }, '../x'), denied());
  assert.deepEqual(w.log.exec, []);
  assert.deepEqual(await w.run(), { ok: true });
  assert.deepEqual(w.log.exec, [
    ['wt.exe', ['a'], { timeout: 15000, env: { PATH: 'x' } }],
    ['cmd.exe', ['/k', 'x'], { timeout: 15000, env: { PATH: 'x' }, windowsVerbatimArguments: true }],
  ]);
  assert.deepEqual(w.log.posts, [['/runs/r1/sync', { watch: true }]]);
  assert.equal(w.log.plans[0][1].platform, 'win32');
  // 모두 실패하면 오류, 지켜보기도 시작하지 않는다
  const f = claudeRun({ platform: 'win32', plan: { ok: true, launches }, execResults: [new Error('a'), new Error('b')] });
  assert.deepEqual(await f.run(), { ok: false, error: '터미널을 열지 못했어요.' });
  assert.deepEqual(f.log.posts, []);
});

test('windowsTerminal: LOCALAPPDATA 아래 WindowsApps/wt.exe 가 lstat 로 있을 때만', () => {
  const wt = 'L/Microsoft/WindowsApps/wt.exe';
  const mk = (env, existing) => claudeRun({ platform: 'win32', plan: null, env, existing }).deps;
  const call = (d) => buildHandler(decl('windowsTerminal'), d)();
  assert.equal(call(mk({ LOCALAPPDATA: 'L' }, [wt])), wt);
  assert.equal(call(mk({ LOCALAPPDATA: 'L' }, [])), null);
  assert.equal(call(mk({}, [wt])), null);
});

test('IPC 배선: 세션 창 importSession → 메인 session-import(UUID 만) → POST /runs/import', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const ps = read('preload-session.cjs'), sess = read('renderer/session.js'), html = read('renderer/session.html');
  assert.match(ps, /importSession: \(sid\) => ipcRenderer\.invoke\('session-import', String\(sid\)\)/);
  const posts = [];
  const h = buildHandler(ipcHandlers().get('session-import'), { denied, fromOurs: (e) => e.ours, okSessionId, post: (...a) => { posts.push(a); return 'posted'; } });
  assert.deepEqual(h({ ours: false }, SID), denied());
  assert.deepEqual(h({ ours: true }, `${SID}; rm -rf ~`), denied());
  assert.deepEqual(posts, []);
  assert.equal(h({ ours: true }, SID), 'posted');
  assert.deepEqual(posts, [['/runs/import', { sessionId: SID }]]);
  assert.match(html, /id="im-sid"/);
  assert.match(sess, /cy\.importSession\(sid\)/);
  assert.match(sess, /await select\(r\.data\.runId\)/);
});

test('IPC 배선: 세션 창 openInClaude → 메인 session-claude(run 을 데몬에서 다시 받아 planResume → osascript, 셸 없이)', async () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const main = read('main.js'), ps = read('preload-session.cjs'), sess = read('renderer/session.js'), html = read('renderer/session.html');
  assert.match(ps, /openInClaude: \(id\) => ipcRenderer\.invoke\('session-claude', String\(id\)\)/);
  const run = { id: 'r1', cwd: '/home/me/x' };
  const m = claudeRun({ platform: 'darwin', plan: { ok: true, args: ['-e', 'tell'] }, run });
  assert.deepEqual(await m.run(), { ok: true });
  assert.equal(m.log.plans[0][0], run, '렌더러가 준 값이 아니라 데몬에서 받은 run 으로 계획');
  assert.deepEqual(m.log.exec, [['osascript', ['-e', 'tell'], { timeout: 15000 }]]);
  assert.deepEqual(m.log.posts, [['/runs/r1/sync', { watch: true }]]);
  const bad = claudeRun({ platform: 'darwin', plan: { ok: false, error: '못 열어요' } });
  assert.deepEqual(await bad.run(), { ok: false, error: '못 열어요' });
  assert.deepEqual(bad.log.exec, []);
  assert.doesNotMatch(main, /\bexec\(|execSync|shell: true/);
  assert.match(html, /id="btn-claude"[^>]*>Claude Code에서 열기</);
  assert.match(sess, /cy\.openInClaude\(r\.id\)/);
  assert.match(sess, /item\('Claude Code에서 열기', \(\) => openInClaude\(r\)\)/);
});
