// 렌더러 스크립트는 시험이 통째로 불러오지 않아 문법 오류가 있어도 다른 시험은 다 지난다. 파일마다 node --check 로 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('렌더러 스크립트는 모두 문법이 맞다', () => {
  const dir = new URL('../renderer/', import.meta.url).pathname;
  const tmp = mkdtempSync(join(tmpdir(), 'cy-syntax-'));
  try {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const copy = join(tmp, f.replace(/\.js$/, '.mjs')); // 렌더러는 ES 모듈
      copyFileSync(join(dir, f), copy);
      const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
