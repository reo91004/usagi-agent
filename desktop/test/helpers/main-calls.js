// main.js 는 import 하면 앱이 떠서, 소스에서 `head(` / `head{` 뒤 괄호 안의 소스만 균형 잡힌 괄호로 뽑아 쓴다.
// 문자열·템플릿·주석 안의 괄호는 건너뛴다. 정규식 리터럴 안의 따옴표/괄호는 지원하지 않는다.
import { readFileSync } from 'node:fs';

export const mainSource = readFileSync(new URL('../../main.js', import.meta.url), 'utf8');

const CLOSE = { '(': ')', '{': '}' };

function skipString(s, i) {
  const q = s[i];
  for (i++; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === q) return i;
    else if (q === '`' && s[i] === '$' && s[i + 1] === '{') i = closeAt(s, i + 1, '{', '}');
  }
  throw new Error('문자열이 닫히지 않음');
}

function closeAt(s, open, o, c) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === '`') i = skipString(s, i);
    else if (ch === '/' && s[i + 1] === '/') i = s.indexOf('\n', i);
    else if (ch === '/' && s[i + 1] === '*') i = s.indexOf('*/', i) + 1;
    else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  throw new Error(`${o} 가 닫히지 않음`);
}

// `head` (마지막 글자가 여는 괄호 `(` 또는 `{`) 로 시작하는 모든 곳의 괄호 안 소스
export function blocks(head, src = mainSource) {
  const o = head.at(-1), out = [];
  for (let at = src.indexOf(head); at >= 0; at = src.indexOf(head, at + 1)) {
    const open = at + head.length - 1;
    out.push(src.slice(open + 1, closeAt(src, open, o, CLOSE[o])));
  }
  return out;
}

// ipcMain.handle|on 로 등록된 채널 → 핸들러 소스(두 번째 인자 전체)
export function ipcHandlers(src = mainSource) {
  const map = new Map();
  for (const head of ['ipcMain.handle(', 'ipcMain.on(']) {
    for (const args of blocks(head, src)) {
      const m = /^\s*'([^']+)',\s*/.exec(args);
      map.set(m[1], args.slice(m[0].length).trim());
    }
  }
  return map;
}

// 최상위 선언 하나의 소스: `[async ]function name(...) {...}` 또는 한 줄짜리 `const name = ...;` (값만 돌려준다).
// 한 줄 const 는 줄 끝(;)까지 보니 여러 줄에 걸친 값은 못 뽑는다.
export function decl(name, src = mainSource) {
  const f = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (f) {
    const params = closeAt(src, f.index + f[0].length - 1, '(', ')');
    return src.slice(f.index, closeAt(src, src.indexOf('{', params), '{', '}') + 1);
  }
  const c = new RegExp(`^const ${name} = (.*);$`, 'm').exec(src);
  if (!c) throw new Error(`${name} 선언을 못 찾음`);
  return c[1];
}

// 핸들러 소스를 가짜 의존물로 실제로 실행할 수 있는 함수로 만든다.
export function buildHandler(source, deps) {
  return new Function(...Object.keys(deps), `return (${source});`)(...Object.values(deps));
}

// main.js 의 request() 를 가짜 fetch 로 돌려, 데몬에 실제로 나가는 [url, init(method·headers·body)] 를 돌려준다.
export async function requestSent(method, pathname, body) {
  const out = [];
  const fetch = async (url, init) => { out.push([url, init]); return { ok: true, status: 200, text: async () => '{}' }; };
  await buildHandler(decl('request'), { BASE: 'http://d', fetch })(method, pathname, body);
  return out[0];
}
