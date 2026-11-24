import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDataQuality, checkRows, findSplitNames } from '../../football/src/quality.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(REPO, 'football/data');

/** 复制真实样本库到临时目录，便于篡改测试。 */
function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quality-'));
  for (const f of ['big5.csv', 'elo-latest.csv', 'manifest.json']) copyFileSync(path.join(DATA, f), path.join(dir, f));
  return { dir, manifestFile: path.join(dir, 'manifest.json') };
}

// ---------- G8 数据质量 ----------
test('G8：仓库样本库通过数据质量检查，且与指纹清单一致', () => {
  const r = checkDataQuality({ now: '2026-11-24T00:00:00Z' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.lastDate, '2026-09-03');
});

test('G8：能机械发现当初靠运气才发现的队名分裂', () => {
  const splits = findSplitNames([['E0', 'Nottm Forest'], ['E0', "Nott'm Forest"], ['D1', 'MGladbach'], ['D1', "M'gladbach"], ['E0', 'Arsenal'], ['SP1', 'Nottm Forest']]);
  assert.deepEqual(splits.map((s) => s.names), [['Nott\'m Forest', 'Nottm Forest'], ["M'gladbach", 'MGladbach']]);
  const { dir, manifestFile } = sandbox();
  const csv = readFileSync(path.join(dir, 'big5.csv'), 'utf8').replace(",Nott'm Forest,Leeds,", ',Nottm Forest,Leeds,');
  assert.ok(csv.includes(',Nottm Forest,Leeds,'), '构造的篡改确实生效');
  writeFileSync(path.join(dir, 'big5.csv'), csv);
  const r = checkDataQuality({ dataDir: dir, manifestFile, now: '2026-11-24T00:00:00Z' });
  assert.ok(r.errors.some((e) => e.includes('队名分裂') && e.includes('Nottm Forest')), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => e.includes('指纹不符')), '手改样本库同时会被指纹发现');
});

test('G8：行级校验抓出重复、非法比分、半场多于全场、非法赔率与 Elo', () => {
  const ok = { league: 'E0', date: '2026-01-01', home: 'A', away: 'B', fthg: '1', ftag: '0', hthg: '0', htag: '0', odd_h: '1.5', odd_d: '4', odd_a: '6', odd_over25: '', odd_under25: '', hst: '4', ast: '2', home_elo: '1800', away_elo: '1700' };
  assert.deepEqual(checkRows([ok]), []);
  const errors = checkRows([ok, ok, { ...ok, home: 'C', fthg: '-1' }, { ...ok, home: 'D', hthg: '2' }, { ...ok, home: 'E', odd_h: '0.9' }, { ...ok, home: 'F', home_elo: '3200' }, { ...ok, home: 'G', league: 'XX' }]).join('\n');
  for (const word of ['重复场次', '全场比分非法', '半场进球多于全场', 'odd_h 非法', 'home_elo 超出', '不在样本库范围']) assert.match(errors, new RegExp(word));
});

test('G8：样本库超过 30 天提示，超过 120 天阻断', () => {
  assert.equal(checkDataQuality({ now: '2026-09-20T00:00:00Z' }).warnings.length, 0);
  const stale = checkDataQuality({ now: '2026-11-24T00:00:00Z' });
  assert.equal(stale.errors.length, 0);
  assert.match(stale.warnings.join(), /距今 82 天/);
  assert.match(checkDataQuality({ now: '2027-01-15T00:00:00Z' }).errors.join(), /超过 120 天上限/);
});
