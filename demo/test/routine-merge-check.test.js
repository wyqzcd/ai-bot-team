import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'routine-merge-check.mjs');
const PATHS = ['football/ledger/', 'football/fixtures/', 'football/reports/', 'football/data/big5.csv'];

/** 建一个临时仓库：main 上有放权配置、两条台账、发布锚点；返回在 feature 分支上的工作目录。 */
function repo({ enabled = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'routine-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  const write = (f, c) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  write('config/trust.json', JSON.stringify({ routineData: { enabled, paths: PATHS } }));
  write('football/ledger/live.jsonl', '{"seq":1}\n{"seq":2}\n');
  write('football/ledger/published.json', JSON.stringify({ live: { entries: 2, lastHash: 'b' }, registry: { 'R-001': { status: 'active', fingerprint: 'x' } } }));
  write('football/src/model.mjs', 'export const v = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  return { dir, git, write, commit: (m) => { git('add', '-A'); git('commit', '-qm', m); } };
}
const check = (dir) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--base', 'main', '--json'], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, ...JSON.parse(r.stdout) };
};

test('只追加台账并推进锚点：有资格自动合并', () => {
  const r = repo();
  appendFileSync(path.join(r.dir, 'football/ledger/live.jsonl'), '{"seq":3}\n');
  r.write('football/ledger/published.json', JSON.stringify({ live: { entries: 3, lastHash: 'c' }, registry: { 'R-001': { status: 'active', fingerprint: 'x' } } }));
  r.write('football/reports/2026-11-25.html', '<p>ok</p>');
  r.commit('append');
  const out = check(r.dir);
  assert.equal(out.code, 0, out.reasons.join('; '));
  assert.equal(out.eligible, true);
});

test('改写已有台账内容：无资格', () => {
  const r = repo();
  r.write('football/ledger/live.jsonl', '{"seq":1,"tampered":true}\n{"seq":2}\n{"seq":3}\n');
  r.commit('rewrite');
  const out = check(r.dir);
  assert.equal(out.code, 3);
  assert.match(out.reasons.join(), /已有内容被改写/);
});

test('夹带代码改动：无资格', () => {
  const r = repo();
  appendFileSync(path.join(r.dir, 'football/ledger/live.jsonl'), '{"seq":3}\n');
  r.write('football/src/model.mjs', 'export const v = 2;\n');
  r.commit('sneak');
  const out = check(r.dir);
  assert.equal(out.code, 3);
  assert.match(out.reasons.join(), /football\/src\/model\.mjs/);
});

test('锚点条数回退或登记表锚点被改：无资格', () => {
  const r = repo();
  r.write('football/ledger/published.json', JSON.stringify({ live: { entries: 1, lastHash: 'a' }, registry: { 'R-001': { status: 'retracted', fingerprint: 'y' } } }));
  r.commit('anchor');
  const reasons = check(r.dir).reasons.join();
  assert.match(reasons, /条数减少/);
  assert.match(reasons, /登记表锚点被改动/);
});

test('删除台账：无资格', () => {
  const r = repo();
  r.git('rm', '-q', 'football/ledger/live.jsonl');
  r.commit('delete');
  assert.match(check(r.dir).reasons.join(), /台账被删除/);
});

test('base 上未开启例行数据通道：无资格（PR 自己改配置也没用）', () => {
  const r = repo({ enabled: false });
  r.write('config/trust.json', JSON.stringify({ routineData: { enabled: true, paths: [...PATHS, 'config/'] } }));
  appendFileSync(path.join(r.dir, 'football/ledger/live.jsonl'), '{"seq":3}\n');
  r.commit('self-grant');
  const reasons = check(r.dir).reasons.join();
  assert.match(reasons, /未开启 routineData\.enabled/);
  assert.match(reasons, /config\/trust\.json/);
});
