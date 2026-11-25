import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDataQuality, checkRows, findSplitNames } from '../src/quality.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(REPO, 'football/data');

/** 复制真实样本库到临时目录，便于篡改测试。 */
function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quality-'));
  for (const f of ['big5.csv', 'elo-latest.csv', 'manifest.json']) copyFileSync(path.join(DATA, f), path.join(dir, f));
  return { dir, manifestFile: path.join(dir, 'manifest.json') };
}

// ---------- G8 数据质量 ----------
const LAST = JSON.parse(readFileSync(path.join(DATA, 'manifest.json'), 'utf8')).dataset?.to;
const daysAfterLast = (n) => new Date(Date.parse(`${LAST}T00:00:00Z`) + n * 86400000).toISOString();

test('G8：仓库样本库通过数据质量检查，且与指纹清单一致', () => {
  const r = checkDataQuality({ now: daysAfterLast(1) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.lastDate, LAST);
});

test('G8：能机械发现当初靠运气才发现的队名分裂', () => {
  const splits = findSplitNames([['E0', 'Nottm Forest'], ['E0', "Nott'm Forest"], ['D1', 'MGladbach'], ['D1', "M'gladbach"], ['E0', 'Arsenal'], ['SP1', 'Nottm Forest']]);
  assert.deepEqual(splits.map((s) => s.names), [['Nott\'m Forest', 'Nottm Forest'], ["M'gladbach", 'MGladbach']]);
  const { dir, manifestFile } = sandbox();
  const csv = readFileSync(path.join(dir, 'big5.csv'), 'utf8').replace(",Nott'm Forest,Leeds,", ',Nottm Forest,Leeds,');
  assert.ok(csv.includes(',Nottm Forest,Leeds,'), '构造的篡改确实生效');
  writeFileSync(path.join(dir, 'big5.csv'), csv);
  const r = checkDataQuality({ dataDir: dir, manifestFile, now: daysAfterLast(1) });
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
  assert.equal(checkDataQuality({ now: daysAfterLast(10) }).warnings.length, 0);
  const stale = checkDataQuality({ now: daysAfterLast(82) });
  assert.equal(stale.errors.length, 0);
  assert.match(stale.warnings.join(), /距今 82 天/);
  assert.match(checkDataQuality({ now: daysAfterLast(130) }).errors.join(), /超过 120 天上限/);
});

// ---------- G6 候选到期裁决 ----------
import { checkRegistry } from '../src/rules.mjs';
import { seal } from '../src/ledger.mjs';

function candidateLedger(n) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const file = path.join(dir, 'l.jsonl');
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const id = `E0|2026-01-${String(10 + i).padStart(2, '0')}|A${i}|B${i}`;
    const kickoff = `2026-01-${String(10 + i).padStart(2, '0')}T15:00:00Z`;
    out.push(seal({ type: 'prediction', id, league: 'E0', kickoff, home: `A${i}`, away: `B${i}`, createdAt: `2026-01-${String(10 + i).padStart(2, '0')}T00:00:00Z`, mode: 'live', model: 't', lam: [1.5, 1], probs: [0.6, 0.25, 0.15], pick: 'h', conf: 0.6, over25: 0.5, totals: [0.2, 0.5, 0.3], top3: [['1-0', 0.1], ['1-1', 0.09], ['2-0', 0.08]], known: true, market: null }, out.at(-1) ?? null));
    out.push(seal({ type: 'result', id, ft: [1, 0], ht: null, recordedAt: `2026-01-${String(10 + i).padStart(2, '0')}T17:00:00Z`, source: 't' }, out.at(-1)));
  }
  writeFileSync(file, `${out.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}
const candidate = (file, extra = {}) => ({ id: 'R-950', title: 't', status: 'candidate', definition: 'd', sample: { ledger: file, filter: { mode: 'live' } }, recompute: 'x', claim: null, ...extra });

test('G6：候选规则必须登记裁决阈值；样本攒够必须裁决', () => {
  const file = candidateLedger(3);
  assert.match(checkRegistry({ rules: [candidate(file)] }, { recompute: false }).errors.join(), /必须登记裁决阈值/);
  assert.deepEqual(checkRegistry({ rules: [candidate(file, { reviewAt: { n: 4 } })] }, { recompute: false }).errors, []);
  assert.match(checkRegistry({ rules: [candidate(file, { reviewAt: { n: 3 } })] }, { recompute: false }).errors.join(), /样本已达 n=3 ≥ 3，必须裁决/);
});

// ---------- G6 登记表发布锚点 ----------
import { checkRegistryAnchor, registryAnchor } from '../src/rules.mjs';

test('G6 锚点：已发布规则口径不可改，只能撤回后新登记', () => {
  const active = { id: 'R-901', status: 'active', title: 't', definition: 'd', sample: { ledger: 'l', filter: { from: '2024-07-01' } }, recompute: 'x', claim: { metric: 'direction_hit', rate: 0.6, n: 100 }, baseline: 'b' };
  const cand = { id: 'R-902', status: 'candidate', title: 'c', definition: 'd', claim: null };
  const retracted = { ...active, id: 'R-903', status: 'retracted', retraction: { date: '2026-11-24', reason: '口径有误' } };
  const anchor = registryAnchor({ rules: [active, cand, retracted] });
  const check = (rules) => checkRegistryAnchor({ rules }, anchor).join('\n');

  assert.equal(check([active, cand, retracted]), '', '原样不变');
  assert.equal(check([{ ...active, note: '补充说明' }, { ...cand, definition: '候选可以改' }, retracted]), '', 'note 与候选的修改允许');
  assert.equal(check([active, cand, retracted, { id: 'R-904', status: 'candidate' }]), '', '新增规则允许');
  assert.equal(check([{ ...active, status: 'retracted', retraction: { date: '2026-11-25', reason: '撤回' } }, cand, retracted]), '', 'active → retracted 允许');

  assert.match(check([{ ...active, claim: { ...active.claim, rate: 0.66 } }, cand, retracted]), /R-901: 已发布规则的口径.*被改动/);
  assert.match(check([{ ...active, sample: { ...active.sample, filter: { from: '2025-01-01' } } }, cand, retracted]), /R-901: 已发布规则的口径/);
  assert.match(check([{ ...active, status: 'candidate' }, cand, retracted]), /不能降回候选/);
  assert.match(check([cand, retracted]), /R-901: 已发布规则被删除/);
  assert.match(check([active, cand, { ...retracted, status: 'active' }]), /已撤回规则不能恢复/);
  assert.match(check([active, cand, { ...retracted, retraction: { ...retracted.retraction, reason: '改写撤回原因' } }]), /撤回记录被改动/);
});

test('G6 锚点：仓库当前登记表与已发布锚点一致', () => {
  const anchors = JSON.parse(readFileSync(path.join(REPO, 'football/ledger/published.json'), 'utf8'));
  const registry = JSON.parse(readFileSync(path.join(REPO, 'football/rules/registry.json'), 'utf8'));
  assert.ok(anchors.registry, 'published.json 必须包含登记表锚点');
  assert.deepEqual(checkRegistryAnchor(registry, anchors.registry), []);
});
