import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fitPoisson, scoreMatrix, summarizeMatrix } from '../../football/src/poisson.mjs';
import { GENESIS, foldLedger, hashEntry, readLedger, seal } from '../../football/src/ledger.mjs';
import { computeStats, attributeMiss, outcomeOf } from '../../football/src/metrics.mjs';
import { checkRegistry, effectiveStatus } from '../../football/src/rules.mjs';
import { g1Structure, g2HashChain, g3Probability, g4Lock, g5Coverage } from '../../football/src/gates.mjs';
import { LiveError, normalizeFixture, planPredictions, planResult, planRetraction } from '../../football/src/live.mjs';
import { runAllGates } from '../../football/src/pipeline.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'football-test-'));

// ---------- 合成数据 ----------
const TEAMS = ['Strong', 'Mid1', 'Mid2', 'Mid3', 'Weak'];
/** 确定性合成赛季：Strong 场场多进球，Weak 场场少进球。 */
function syntheticHistory({ rounds = 12, start = '2025-01-04' } = {}) {
  const out = [];
  const t0 = Date.parse(`${start}T15:00:00Z`);
  let day = 0;
  for (let r = 0; r < rounds; r += 1) {
    for (const home of TEAMS) {
      for (const away of TEAMS) {
        if (home === away) continue;
        const strength = (team) => ({ Strong: 3, Mid1: 1, Mid2: 1, Mid3: 1, Weak: 0 })[team];
        const hg = Math.max(0, strength(home) - (away === 'Strong' ? 1 : 0) + ((r + day) % 2));
        const ag = Math.max(0, strength(away) - 1 - (home === 'Strong' ? 1 : 0) + (r % 2));
        const kickoff = new Date(t0 + day * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        out.push({ id: `E0|${kickoff.slice(0, 10)}|${home}|${away}`, league: 'E0', date: kickoff.slice(0, 10), kickoff, home, away, ft: { h: hg, a: ag }, ht: null, odds: null });
        day += 1;
      }
    }
  }
  return out;
}

function pred({ id = 'E0|2026-01-10|A|B', kickoff = '2026-01-10T15:00:00Z', createdAt = '2026-01-09T10:00:00Z', probs = [0.6, 0.25, 0.15], market = [1.7, 3.8, 5.0], mode = 'live' } = {}) {
  const pick = ['h', 'd', 'a'][probs.indexOf(Math.max(...probs))];
  const [, , home, away] = id.split('|');
  return {
    type: 'prediction', id, league: 'E0', kickoff, home, away, createdAt, mode, model: 'dc-poisson@test',
    lam: [1.8, 0.9], probs, pick, conf: Math.max(...probs), over25: 0.55, totals: [0.2, 0.5, 0.3],
    top3: [['1-0', 0.12], ['2-0', 0.11], ['2-1', 0.1]], known: true, market,
  };
}
const res = (id, ft, recordedAt = '2026-01-10T17:00:00Z') => ({ type: 'result', id, ft, ht: null, recordedAt, source: 'test' });
const retr = (target, id, createdAt, reason = '测试撤回原因') => ({ type: 'retraction', target, id, reason, createdAt });
function chain(entries) {
  const out = [];
  for (const e of entries) out.push(seal(e, out.at(-1) ?? null));
  return out;
}

// ---------- 泊松模型 ----------
test('比分矩阵归一化：方向三项和 = 1，档位和 = 1', () => {
  const s = summarizeMatrix(scoreMatrix(1.7, 1.1, -0.1));
  assert.ok(Math.abs(s.probs.h + s.probs.d + s.probs.a - 1) < 1e-12);
  assert.ok(Math.abs(Object.values(s.totals).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(s.top3.length, 3);
  assert.ok(s.probs.h > s.probs.a, 'λ主 > λ客 时主胜概率更高');
});

test('拟合能区分强弱队，且主场系数 > 1', () => {
  const history = syntheticHistory();
  const model = fitPoisson(history, '2026-06-01T00:00:00Z', { halfLifeDays: 180, windowDays: 730, shrink: 1, iterations: 50, maxGoals: 10, rhoGrid: [0], minMatches: 50 });
  assert.equal(model.ok, true);
  assert.ok(model.attack.get('Strong') > model.attack.get('Mid1'));
  assert.ok(model.attack.get('Weak') < model.attack.get('Mid1'));
  assert.ok(model.gamma > 1);
});

test('拟合严格不用 asOf 及之后的比赛（无未来数据泄漏）', () => {
  const history = syntheticHistory();
  const cut = history[150].kickoff;
  const params = { halfLifeDays: 180, windowDays: 730, shrink: 4, iterations: 30, maxGoals: 10, rhoGrid: [0], minMatches: 50 };
  const before = fitPoisson(history, cut, params);
  const poisoned = history.map((m, i) => (i >= 150 ? { ...m, ft: { h: 9, a: 9 } } : m));
  const after = fitPoisson(poisoned, cut, params);
  assert.equal(before.n, 150);
  assert.equal(after.mu, before.mu);
  assert.equal(after.attack.get('Strong'), before.attack.get('Strong'));
});

test('样本不足时拒绝拟合而不是硬出预测', () => {
  const model = fitPoisson(syntheticHistory().slice(0, 10), '2027-01-01T00:00:00Z');
  assert.equal(model.ok, false);
  assert.match(model.reason, /样本不足/);
});

// ---------- 台账与哈希链 ----------
test('G2：任何静默改写都会让哈希链断裂', () => {
  const entries = chain([pred(), res('E0|2026-01-10|A|B', [1, 0])]);
  assert.equal(g2HashChain(entries, 't').ok, true);
  assert.equal(entries[0].prev, GENESIS);
  const tampered = entries.map((e) => ({ ...e }));
  tampered[1].ft = [0, 1];
  const report = g2HashChain(tampered, 't');
  assert.equal(report.ok, false);
  assert.match(report.errors[0], /hash 不符/);
});

test('G2：即使整条链重新算 hash，也改不动已发布锚点', () => {
  const original = chain([pred(), res('E0|2026-01-10|A|B', [1, 0])]);
  const anchor = { entries: 2, lastHash: original[1].hash };
  const rewritten = chain([pred(), res('E0|2026-01-10|A|B', [0, 1])]);
  assert.equal(g2HashChain(rewritten, 't').ok, true, '自洽的伪造链本身能过链校验');
  const report = g2HashChain(rewritten, 't', anchor);
  assert.equal(report.ok, false);
  assert.match(report.errors[0], /发布锚点/);
  assert.equal(g2HashChain(original.slice(0, 1), 't', anchor).ok, false, '截断也会被拦下');
});

test('G1：字段序、多余字段、跳号都会被拦下', () => {
  const entries = chain([pred(), res('E0|2026-01-10|A|B', [1, 0])]);
  assert.equal(g1Structure(entries, 't').ok, true);
  const reordered = [{ hash: entries[0].hash, ...entries[0] }, entries[1]];
  assert.equal(g1Structure(reordered, 't').ok, false);
  assert.equal(g1Structure([entries[1]], 't').ok, false, 'seq 不从 1 开始');
});

test('G3：概率和不为 1 或 pick 不是最大项会被拦下', () => {
  assert.equal(g3Probability(chain([pred()]), 't').ok, true);
  const bad = chain([{ ...pred(), probs: [0.5, 0.3, 0.3] }]);
  assert.equal(g3Probability(bad, 't').ok, false);
  const wrongPick = chain([{ ...pred(), pick: 'a' }]);
  assert.equal(g3Probability(wrongPick, 't').ok, false);
});

// ---------- 开赛锁定 ----------
test('G4：开赛后出的预测、倒签补录、赛后改判、过早赛果全部拦下', () => {
  assert.equal(g4Lock(chain([pred()]), 't').ok, true);
  assert.equal(g4Lock(chain([pred({ createdAt: '2026-01-10T15:00:00Z' })]), 't').ok, false, '开赛时刻出预测');
  const backdated = chain([pred({ id: 'E0|2026-01-10|C|D', createdAt: '2026-01-09T12:00:00Z' }), pred({ createdAt: '2026-01-09T10:00:00Z' })]);
  assert.match(g4Lock(backdated, 't').errors.join(), /倒签/);
  const afterResult = chain([pred(), res('E0|2026-01-10|A|B', [1, 0]), pred({ createdAt: '2026-01-10T18:00:00Z', kickoff: '2026-01-11T15:00:00Z' })]);
  assert.equal(g4Lock(afterResult, 't').ok, false);
  const doublePick = chain([pred(), pred({ createdAt: '2026-01-09T11:00:00Z' })]);
  assert.match(g4Lock(doublePick, 't').errors.join(), /改判须先赛前撤回/);
  const early = chain([pred(), res('E0|2026-01-10|A|B', [1, 0], '2026-01-10T15:30:00Z')]);
  assert.match(g4Lock(early, 't').errors.join(), /105 分钟/);
});

test('G4：赛前先撤回再改判是允许的', () => {
  const entries = chain([pred(), retr(1, 'E0|2026-01-10|A|B', '2026-01-09T11:00:00Z'), pred({ createdAt: '2026-01-09T11:00:00Z', probs: [0.5, 0.3, 0.2] })]);
  assert.equal(g4Lock(entries, 't').ok, true);
});

// ---------- 统计口径 ----------
test('赛前撤回的预测作废；赛后撤回只留痕、仍计入命中率（防止挑掉错的）', () => {
  const id = 'E0|2026-01-10|A|B';
  const preVoid = chain([pred(), retr(1, id, '2026-01-09T11:00:00Z'), pred({ createdAt: '2026-01-09T11:00:00Z', probs: [0.2, 0.3, 0.5] }), res(id, [2, 0])]);
  const s1 = computeStats(preVoid, { mode: 'live' });
  assert.equal(s1.n, 1);
  assert.equal(s1.direction_hit.hits, 0, '只算改判后的那条（选客胜，错）');
  const lateRetract = chain([pred({ probs: [0.2, 0.3, 0.5] }), res(id, [2, 0]), retr(1, id, '2026-01-10T18:00:00Z')]);
  const s2 = computeStats(lateRetract, { mode: 'live' });
  assert.equal(s2.n, 1);
  assert.equal(s2.direction_hit.hits, 0);
  assert.equal(s2.lateRetractedCounted, 1);
});

test('每次复算都带同样本市场热门基线与覆盖率', () => {
  const entries = chain([
    pred({ id: 'E0|2026-01-10|A|B', probs: [0.6, 0.25, 0.15], market: [3.0, 3.2, 2.2] }),
    pred({ id: 'E0|2026-01-10|C|D', probs: [0.4, 0.3, 0.3], market: [1.5, 4, 6] }),
    res('E0|2026-01-10|A|B', [1, 0]),
    res('E0|2026-01-10|C|D', [0, 0]),
  ]);
  const all = computeStats(entries, { mode: 'live' });
  assert.equal(all.direction_hit.rate, 0.5);
  assert.equal(all.baselines.market_fav.rate, 0);
  const high = computeStats(entries, { mode: 'live', minConf: 0.5 });
  assert.equal(high.n, 1);
  assert.equal(high.coverage, 0.5);
  assert.equal(outcomeOf([0, 0]), 'd');
});

test('赛后归因按机械规则分类', () => {
  const id = 'E0|2026-01-10|A|B';
  const fold = (entries) => foldLedger(chain(entries)).find((x) => x.id === id);
  assert.equal(attributeMiss(fold([pred(), res(id, [1, 1])])), 'draw_blind');
  assert.equal(attributeMiss(fold([pred({ market: [1.5, 4, 6] }), res(id, [0, 1])])), 'market_upset');
  assert.equal(attributeMiss(fold([pred({ market: [4, 3.5, 1.8] }), res(id, [0, 1])])), 'model_contrary');
  assert.equal(attributeMiss(fold([pred(), res(id, [2, 0])])), null);
});

// ---------- 规则登记 ----------
function ruleFixture(ledgerFile, overrides = {}) {
  return {
    id: 'R-900', title: 't', status: 'active', definition: '方向命中',
    sample: { ledger: ledgerFile, filter: { mode: 'live' } }, recompute: 'node football/bin/stats.mjs --rule R-900',
    claim: { metric: 'direction_hit', rate: 1, n: 1 }, baseline: 'x', ...overrides,
  };
}

test('规则三要素缺一只能是候选；声明 active 会被 G6 拦下', () => {
  const dir = tmp();
  const file = path.join(dir, 'l.jsonl');
  writeFileSync(file, `${chain([pred(), res('E0|2026-01-10|A|B', [1, 0])]).map((e) => JSON.stringify(e)).join('\n')}\n`);
  assert.equal(effectiveStatus(ruleFixture(file)), 'active');
  for (const missing of ['definition', 'sample', 'recompute']) {
    const rule = ruleFixture(file, { [missing]: undefined });
    assert.equal(effectiveStatus(rule), 'candidate', `缺 ${missing}`);
    assert.match(checkRegistry({ rules: [rule] }).errors.join(), /只能算候选/);
  }
});

test('G7：登记的命中率复算不出来就拦下', () => {
  const dir = tmp();
  const file = path.join(dir, 'l.jsonl');
  writeFileSync(file, `${chain([pred(), res('E0|2026-01-10|A|B', [0, 1])]).map((e) => JSON.stringify(e)).join('\n')}\n`);
  const report = checkRegistry({ rules: [ruleFixture(file)] });
  assert.equal(report.errors.length, 0);
  assert.match(report.recomputeErrors.join(), /复算 direction_hit=0 ≠ 登记 1/);
});

test('撤回规则必须留痕（日期 + 原因）', () => {
  const report = checkRegistry({ rules: [{ id: 'R-901', title: 't', status: 'retracted' }] });
  assert.match(report.errors.join(), /留痕/);
});

test('撤回规则留痕里的数字同样要能复算', () => {
  const dir = tmp();
  const file = path.join(dir, 'l.jsonl');
  writeFileSync(file, `${chain([pred(), res('E0|2026-01-10|A|B', [0, 1])]).map((e) => JSON.stringify(e)).join('\n')}\n`);
  const rule = ruleFixture(file, { status: 'retracted', retraction: { date: '2026-11-24', reason: '口径有误' } });
  assert.match(checkRegistry({ rules: [rule] }).recomputeErrors.join(), /≠ 登记 1/);
});

// ---------- 覆盖率 ----------
test('G5：回测挑场、实盘赛果逾期都会被拦下', () => {
  const entries = chain([pred(), res('E0|2026-01-10|A|B', [1, 0])]);
  assert.equal(g5Coverage(entries, 't', { expectedIds: new Set(['E0|2026-01-10|A|B']) }).ok, true);
  assert.equal(g5Coverage(entries, 't', { expectedIds: new Set(['E0|2026-01-10|A|B', 'E0|2026-01-11|X|Y']) }).ok, false);
  const open = chain([pred()]);
  assert.equal(g5Coverage(open, 't', { now: '2026-01-11T15:00:00Z' }).ok, true, '24h 内未录赛果允许');
  assert.equal(g5Coverage(open, 't', { now: '2026-01-14T15:00:00Z' }).ok, false, '超 72h 必须录');
});

// ---------- 实盘流程 ----------
const FIX = { league: 'E0', kickoff: '2026-02-01T23:00:00+08:00', home: 'Strong', away: 'Weak', odds: [1.4, 4.5, 8] };
const liveParams = { halfLifeDays: 180, windowDays: 730, shrink: 4, iterations: 30, maxGoals: 10, rhoGrid: [0], minMatches: 50 };

test('实盘：开赛前可预测，开赛后锁定；改判必须 --replace + 理由', () => {
  const dataset = syntheticHistory();
  const now = '2026-01-30T10:00:00Z';
  const first = planPredictions({ fixtures: [FIX], dataset, liveEntries: [], now, params: liveParams });
  assert.equal(first.length, 1);
  assert.equal(first[0].pick, 'h');
  assert.equal(first[0].kickoff, '2026-02-01T15:00:00Z');
  assert.throws(() => planPredictions({ fixtures: [FIX], dataset, liveEntries: first, now, params: liveParams }), /已有有效预测/);
  assert.throws(() => planPredictions({ fixtures: [FIX], dataset, liveEntries: first, now, replace: true, params: liveParams }), /必须写明理由/);
  const replaced = planPredictions({ fixtures: [FIX], dataset, liveEntries: first, now, replace: true, reason: '主力伤停确认', params: liveParams });
  assert.deepEqual(replaced.map((e) => e.type), ['retraction', 'prediction']);
  assert.throws(() => planPredictions({ fixtures: [FIX], dataset, liveEntries: first, now: '2026-02-01T15:00:00Z', replace: true, reason: '赛后想改', params: liveParams }), /锁定/);
});

test('实盘：队名拼错默认拒绝，避免被当成联赛平均队', () => {
  assert.throws(
    () => planPredictions({ fixtures: [{ ...FIX, home: 'Stronk' }], dataset: syntheticHistory(), liveEntries: [], now: '2026-01-30T10:00:00Z', params: liveParams }),
    /没见过球队「Stronk」/,
  );
  assert.throws(() => normalizeFixture({ ...FIX, kickoff: '2026-02-01 23:00' }), LiveError);
});

test('实盘：赛果要等完场、不可重复；撤回必须写原因', () => {
  const entries = planPredictions({ fixtures: [FIX], dataset: syntheticHistory(), liveEntries: [], now: '2026-01-30T10:00:00Z', params: liveParams });
  const id = entries[0].id;
  assert.throws(() => planResult({ liveEntries: entries, id, ft: [1, 0], now: '2026-02-01T16:00:00Z', source: 'x' }), /105 分钟/);
  const withResult = [...entries, ...planResult({ liveEntries: entries, id, ft: [1, 0], now: '2026-02-01T17:00:00Z', source: '官方' })];
  assert.throws(() => planResult({ liveEntries: withResult, id, ft: [2, 0], now: '2026-02-01T18:00:00Z', source: 'x' }), /禁止覆盖/);
  assert.throws(() => planRetraction({ liveEntries: withResult, seq: 1, reason: '', now: '2026-02-02T00:00:00Z' }), /原因/);
  const retracted = planRetraction({ liveEntries: withResult, seq: 1, reason: '赛后复盘发现参数错误', now: '2026-02-02T00:00:00Z' });
  assert.equal(computeStats([...withResult, ...retracted], { mode: 'live' }).n, 1, '赛后撤回照样计入');
});

// ---------- 仓库真实台账：可复算 ----------
test('仓库提交的回测台账 + 登记表通过全部 7 道门禁', () => {
  const report = runAllGates({ now: '2026-11-24T13:00:00Z' });
  for (const g of report.gates) assert.equal(g.ok, true, `${g.id} ${g.name}: ${g.errors.join('; ')}`);
  assert.equal(report.gates.length, 7);
});

test('stats.mjs --rule R-002 一键复算并与登记值一致', () => {
  const out = spawnSync(process.execPath, [path.join(REPO, 'football/bin/stats.mjs'), '--rule', 'R-002'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const row = JSON.parse(out.stdout.trim());
  assert.equal(row.reproduced, true);
  assert.equal(row.recomputed.n, row.claimed.n);
  assert.ok(row.baselines.market_fav.rate !== null, '必须同时给出同样本市场基线');
});

test('回测台账每条 hash 可独立重算', () => {
  const entries = readLedger(path.join(REPO, 'football/ledger/backtest.jsonl'));
  for (const i of [0, 1, Math.floor(entries.length / 2), entries.length - 1]) assert.equal(hashEntry(entries[i]), entries[i].hash);
  const registry = JSON.parse(readFileSync(path.join(REPO, 'football/rules/registry.json'), 'utf8'));
  assert.ok(registry.rules.some((r) => r.status === 'retracted' && r.retraction?.reason), '登记表保留撤回留痕示例');
});
