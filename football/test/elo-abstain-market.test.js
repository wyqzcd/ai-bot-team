import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eloStep, marginMultiplier, propagateElo, snapshotAt } from '../src/elo-update.mjs';
import { bucket, rowOf, selectAbstain } from '../src/abstain.mjs';
import { computeStats, marginOf, matchesFilter } from '../src/metrics.mjs';
import { abstainOf, currentAbstain } from '../src/tiers.mjs';
import { addSnapshot, compare, compileUclTeamMap, devig, marketScoreboard, preKickoffMarket, resolveUclMarket } from '../src/ucl-market.mjs';

const m = (date, home, away, h, a, elo = null) => ({ id: `E0|${date}|${home}|${away}`, league: 'E0', date, kickoff: `${date}T15:00:00Z`, home, away, ft: { h, a }, elo });

// ---------- Elo 推算 ----------

test('Elo 单场更新零和，赢球加分、净胜球放大', () => {
  const p = { k: 20, hfa: 0, margin: true };
  const [h1, a1] = eloStep(1500, 1500, 1, 0, p);
  assert.equal(h1 + a1, 3000);
  assert.ok(h1 > 1500);
  assert.equal(h1 - 1500, 10); // K·(1 − 0.5)
  const [h3] = eloStep(1500, 1500, 3, 0, p);
  assert.equal(h3 - 1500, 10 * (14 / 8));
  assert.deepEqual([marginMultiplier(0), marginMultiplier(-1), marginMultiplier(2), marginMultiplier(4)], [1, 1, 1.5, 15 / 8]);
  const [hd] = eloStep(1600, 1500, 1, 1, { k: 20, hfa: 0, margin: false });
  assert.ok(hd < 1600, '强队主场打平要掉分');
  const [hk0] = eloStep(1600, 1500, 0, 5, { k: 0, hfa: 0, margin: true });
  assert.equal(hk0, 1600, 'K=0 即冻结快照');
});

test('推算只用两队快照日（含当天）之后的比赛，快照里没有的球队不动', () => {
  const snapshot = new Map([
    ['A', { elo: 1500, date: '2026-09-01', division: 'E0' }],
    ['B', { elo: 1500, date: '2026-09-01', division: 'E0' }],
    ['X', { elo: 1700, date: '2025-01-01', division: 'P1' }],
  ]);
  const matches = [
    m('2026-08-20', 'A', 'B', 5, 0), // 快照之前：已体现在快照里，不能再算一次
    m('2026-09-01', 'A', 'B', 1, 0), // 快照当天：快照是赛前值，要算
    m('2026-09-10', 'B', 'A', 2, 2),
    m('2026-09-20', 'A', 'C', 3, 0), // C 不在快照里：跳过
  ];
  const seen = [];
  const state = propagateElo(snapshot, matches, { k: 20, hfa: 0, margin: true }, (match) => seen.push(match.date));
  assert.deepEqual(seen, ['2026-09-01', '2026-09-10']);
  assert.equal(state.get('A').games, 2);
  assert.equal(state.get('A').basis, 'propagated');
  assert.equal(state.get('A').date, '2026-09-10');
  assert.equal(state.get('X').basis, 'clubelo');
  assert.equal(state.get('X').elo, 1700);
  assert.equal(state.get('A').elo + state.get('B').elo, 3000);
});

test('截断日快照 = 每队截断日之前最后一场的赛前 ClubElo', () => {
  const matches = [
    m('2026-08-01', 'A', 'B', 1, 0, { h: 1500, a: 1490 }),
    m('2026-08-08', 'B', 'A', 1, 0, { h: 1480, a: 1510 }),
    m('2026-09-02', 'A', 'B', 1, 0, { h: 1999, a: 1999 }),
  ];
  const snap = snapshotAt(matches, '2026-09-01');
  assert.deepEqual(snap.get('A'), { elo: 1510, date: '2026-08-08', division: 'E0' });
  assert.deepEqual(snap.get('B'), { elo: 1480, date: '2026-08-08', division: 'E0' });
});

// ---------- 不下判断 ----------

test('概率差与过滤器：maxMargin / minMargin 不影响覆盖率分母', () => {
  assert.equal(marginOf([0.4, 0.35, 0.25]), 0.05);
  assert.equal(marginOf([0.2, 0.3, 0.5]), 0.2);
  const p = { kickoff: '2025-01-01T15:00:00Z', mode: 'backtest', probs: [0.4, 0.35, 0.25], conf: 0.4, pick: 'h' };
  assert.equal(matchesFilter(p, { maxMargin: 0.06 }), true);
  assert.equal(matchesFilter(p, { maxMargin: 0.05 }), false, '边界：< 阈值才算');
  assert.equal(matchesFilter(p, { minMargin: 0.05 }), true);
  const entry = (id, probs, ft, seq) => [
    { type: 'prediction', id, seq: seq * 2 - 1, kickoff: '2025-01-01T15:00:00Z', createdAt: '2025-01-01T00:00:00Z', mode: 'backtest', league: 'E0', home: 'A', away: 'B', model: 't', lam: [1, 1], probs, pick: 'h', conf: Math.max(...probs), over25: 0.5, totals: [], top3: [['1-1', 0.1]], known: true, market: null },
    { type: 'result', id, seq: seq * 2, ft, ht: null, recordedAt: '2025-01-01T18:00:00Z', source: 't' },
  ];
  const entries = [...entry('a', [0.4, 0.37, 0.23], [1, 0], 1), ...entry('b', [0.6, 0.25, 0.15], [0, 1], 2)];
  const s = computeStats(entries, { mode: 'backtest', maxMargin: 0.06 });
  assert.equal(s.n, 1);
  assert.equal(s.coverage, 0.5);
});

test('选阈值：第一次显著之前的最后一个值；0.01 就显著则没有弃权区间', () => {
  // margin 0.005 的 200 场：第一选择、第二选择各中 70；margin 0.015 的 200 场：第一选择中 120、第二选择中 40
  const rows = [
    ...Array.from({ length: 200 }, (_, i) => ({ margin: 0.005, h1: i < 70, h2: i >= 70 && i < 140 })),
    ...Array.from({ length: 200 }, (_, i) => ({ margin: 0.015, h1: i < 120, h2: i >= 120 && i < 160 })),
  ];
  const { threshold, steps } = selectAbstain(rows);
  assert.equal(threshold, 0.01);
  assert.equal(steps.at(-1).m, 0.02);
  assert.ok(steps.at(-1).z >= 1.645);
  assert.equal(bucket(rows, 0.01).z, 0);
  assert.equal(selectAbstain(rows.slice(200)).threshold, null);
  assert.deepEqual(rowOf([0.3, 0.45, 0.25], 0), { margin: 0.15, h1: false, h2: true });
});

test('不下判断档只从 active 且指向对应台账的规则读阈值', () => {
  const rule = { id: 'R-900', title: 't', status: 'active', tier: 'abstain', definition: 'd', sample: { ledger: 'ledger/bt.jsonl', filter: { mode: 'backtest', maxMargin: 0.06 } }, recompute: 'x', claim: { metric: 'direction_hit', rate: 0.36, n: 10 } };
  const registry = { rules: [rule, { ...rule, id: 'R-901', status: 'candidate', claim: null, sample: { ...rule.sample, ledger: 'ledger/other.jsonl' } }] };
  assert.equal(currentAbstain(registry, 'bt').id, 'R-900');
  assert.equal(currentAbstain(registry, 'other'), null, '候选规则不生效');
  assert.equal(abstainOf([0.38, 0.33, 0.29], rule).key, 'abstain');
  assert.equal(abstainOf([0.42, 0.33, 0.25], rule), null);
  assert.equal(abstainOf([0.38, 0.33, 0.29], null), null);
});

// ---------- 欧冠赔率对照 ----------

const big5Doc = { teams: { E0: { 'Man United': ['曼联'] }, F1: { 'Paris SG': ['巴黎圣曼'] } } };
const uclDoc = { leagues: ['欧冠'], teams: { 'Sp Lisbon': ['葡萄牙体育'] } };
const pred = (id, kickoff, probs, pick) => ({ id, kickoff, probs, pick, conf: Math.max(...probs) });

test('欧冠对照表：沿用五大联赛中文名，别名冲突报错', () => {
  const map = compileUclTeamMap(big5Doc, uclDoc);
  assert.deepEqual(map.errors, []);
  assert.equal(map.teams.get('曼联'), 'Man United');
  assert.equal(map.teams.get('葡萄牙体育'), 'Sp Lisbon');
  assert.match(compileUclTeamMap(big5Doc, { leagues: ['欧冠'], teams: { X: ['曼联'] } }).errors[0], /同时指向/);
  assert.match(compileUclTeamMap(big5Doc, { teams: {} }).errors[0], /leagues/);
});

test('逐场解析：非欧冠 / 未映射 / 无预测 / 开赛后抓取被拒 / 可记录', () => {
  const map = compileUclTeamMap(big5Doc, uclDoc);
  const predictions = [pred('UCL|2026-11-25|Sp Lisbon|Man United', '2026-11-25T20:00:00Z', [0.33, 0.27, 0.4], 'a')];
  const board = {
    matches: [
      { no: '周三001', league: '欧冠', kickoff: '2026-11-26T04:00:00+08:00', home: '葡萄牙体育', away: '曼联', spf: [2.55, 3.4, 2.45] },
      { no: '周三002', league: '欧冠', kickoff: '2026-11-26T04:00:00+08:00', home: '巴黎圣曼', away: '曼联', spf: [1.5, 4, 6] },
      { no: '周三003', league: '欧冠', kickoff: '2026-11-26T04:00:00+08:00', home: '某队', away: '曼联', spf: [1.5, 4, 6] },
      { no: '周三004', league: '英超', kickoff: '2026-11-26T04:00:00+08:00', home: '曼联', away: '曼联', spf: [1.5, 4, 6] },
    ],
  };
  const rows = resolveUclMarket(board, map, { predictions, capturedAt: '2026-11-25T22:00:00+08:00' });
  assert.deepEqual(rows.map((r) => r.status), ['ready', 'no_prediction', 'unmapped', 'not_ucl']);
  assert.equal(rows[0].id, 'UCL|2026-11-25|Sp Lisbon|Man United', '北京时间 04:00 = UTC 前一天 20:00');
  assert.deepEqual(rows[0].market, devig([2.55, 3.4, 2.45]));
  const late = resolveUclMarket(board, map, { predictions, capturedAt: '2026-11-26T04:00:00+08:00' });
  assert.equal(late[0].status, 'locked', '开赛时刻抓的赔率也拒绝');
});

test('快照：同赔率不重复记；只认开赛前的快照；对照与计分', () => {
  const row = { id: 'U1', ref: { no: '周三001', home: '葡萄牙体育', away: '曼联' }, prediction: pred('U1', '2026-11-25T20:00:00Z', [0.33, 0.27, 0.4], 'a'), odds: [2.55, 3.4, 2.45], market: devig([2.55, 3.4, 2.45]) };
  let { doc, added } = addSnapshot({}, row, { capturedAt: '2026-11-25T10:00:00Z', source: 's' });
  assert.equal(added, true);
  ({ doc, added } = addSnapshot(doc, row, { capturedAt: '2026-11-25T11:00:00Z', source: 's' }));
  assert.equal(added, false);
  const late = { ...doc.U1, snapshots: [...doc.U1.snapshots, { capturedAt: '2026-11-25T21:00:00Z', odds: [9, 9, 1.01], market: [0.05, 0.05, 0.9] }] };
  assert.equal(preKickoffMarket(late).capturedAt, '2026-11-25T10:00:00Z', '开赛后的快照被忽略');
  const c = compare(row.prediction, preKickoffMarket(late));
  assert.equal(c.marketPick, 'a');
  assert.equal(c.agrees, true);
  assert.equal(c.flagged, false);
  assert.equal(compare(row.prediction, { market: [0.6, 0.25, 0.15] }).flagged, true);
  const sb = marketScoreboard([{ id: 'U1', prediction: row.prediction, result: { ft: [1, 1] } }, { id: 'U2', prediction: row.prediction, result: { ft: [0, 1] } }], { U1: late });
  assert.deepEqual(sb, { n: 1, model: 0, market: 0 }, '没有赔率的场次不计分');
});
