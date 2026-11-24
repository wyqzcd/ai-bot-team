import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapLiveResponse } from '../../scripts/jczq-board.mjs';
import { TEAM_ALIASES, loadDataset } from '../../football/src/dataset.mjs';
import { compileTeamMap, datasetTeamSets, loadTeamMap, normalizeName, resolveJczq, resolveJczqNo } from '../../football/src/jczq.mjs';
import { readLedger, seal } from '../../football/src/ledger.mjs';
import { renderReport } from '../../football/src/report.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = JSON.parse(readFileSync(path.join(REPO, 'fixtures/2026-11-15.live-raw.json'), 'utf8'));
const dataset = loadDataset();
const teamSets = datasetTeamSets(dataset);
const teamMap = loadTeamMap(undefined, teamSets);

/** 以真实官方响应里的一场为模板克隆出五大联赛场次，保证字段结构与官方一致。 */
function officialResponse(games) {
  const tpl = RAW.value.matchInfoList[0].subMatchList[0];
  const subs = games.map(([no, league, home, away, date, time, odds]) => ({
    ...structuredClone(tpl),
    matchNumStr: no, leagueAbbName: league, homeTeamAbbName: home, awayTeamAbbName: away, matchDate: date, matchTime: time,
    had: { h: String(odds[0]), d: String(odds[1]), a: String(odds[2]) }, hhad: { h: '2.50', d: '3.40', a: '2.40', goalLine: '-1' },
  }));
  return { ...RAW, value: { ...RAW.value, matchInfoList: [{ businessDate: '2026-11-28', subMatchList: subs }], totalCount: subs.length, lastUpdateTime: '2026-11-28 10:00:00' } };
}
const GAMES = [
  ['周六001', '英超', '阿森纳', '切尔西', '2026-11-28', '23:00:00', [1.85, 3.6, 4.1]],
  ['周六002', '西甲', '皇马', '赫塔费', '2026-11-29', '04:00:00', [1.25, 6.0, 10.0]],
  ['周六003', '荷甲', '阿贾克斯', '费耶诺德', '2026-11-28', '21:30:00', [2.2, 3.5, 2.9]],
  ['周六004', '英超', '曼城', '不存在队', '2026-11-28', '20:30:00', [1.4, 4.8, 6.5]],
  ['周六005', '德甲', '拜仁', '门兴', '2026-11-28', '09:30:00', [1.3, 5.5, 8.0]],
];
const board = () => mapLiveResponse(officialResponse(GAMES), { capturedAt: '2026-11-28T10:00:00+08:00', source: 'test' });

test('对照表：样本库队名真实存在、同联赛别名唯一', () => {
  const doc = JSON.parse(readFileSync(path.join(REPO, 'football/data/jczq-teams.json'), 'utf8'));
  assert.deepEqual(compileTeamMap(doc, teamSets).errors, []);
});

test('对照表覆盖样本库最近一个赛季（2025-07 起）出现过的全部球队', () => {
  const missing = [];
  for (const m of dataset.filter((x) => x.date >= '2025-07-01')) {
    for (const team of [m.home, m.away]) {
      if (![...teamMap.teams.get(m.league).values()].includes(team)) missing.push(`${m.league}:${team}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('样本库已合并分裂队名，不再出现旧写法', () => {
  const names = new Set(dataset.flatMap((m) => [m.home, m.away]));
  for (const old of Object.keys(TEAM_ALIASES)) assert.equal(names.has(old), false, old);
});

test('对照表校验能抓出别名冲突与不存在的队名', () => {
  const doc = { leagues: { 英超: 'E0' }, teams: { E0: { Arsenal: ['枪手'], Chelsea: ['枪手'], 'Fake FC': ['假队'] } } };
  const { errors } = compileTeamMap(doc, teamSets);
  assert.ok(errors.some((e) => e.includes('同时指向')));
  assert.ok(errors.some((e) => e.includes('Fake FC')));
  assert.equal(normalizeName(' ＡＣ米兰 '), 'AC米兰');
});

test('解析竞彩场次：待预测 / 未建模 / 未映射 / 已锁定，且 id 用 UTC 日期', () => {
  const rows = resolveJczq(board(), teamMap, { now: '2026-11-28T10:00:00+08:00' });
  const byNo = Object.fromEntries(rows.map((r) => [r.ref.no, r]));
  assert.equal(byNo['周六001'].status, 'ready');
  assert.equal(byNo['周六001'].id, 'E0|2026-11-28|Arsenal|Chelsea');
  assert.deepEqual(byNo['周六001'].fixture.odds, [1.85, 3.6, 4.1]);
  assert.equal(byNo['周六002'].id, 'SP1|2026-11-28|Real Madrid|Getafe', '北京时间 11-29 04:00 = UTC 11-28');
  assert.equal(byNo['周六003'].status, 'not_covered');
  assert.equal(byNo['周六004'].status, 'unmapped');
  assert.deepEqual(byNo['周六004'].missing, ['不存在队']);
  assert.equal(byNo['周六005'].status, 'locked', '北京时间 09:30 已开赛');
});

test('已有预测/已有赛果的场次不会重复出预测', () => {
  const pred = (id) => ({
    type: 'prediction', id, league: 'E0', kickoff: '2026-11-28T15:00:00Z', home: 'Arsenal', away: 'Chelsea', createdAt: '2026-11-27T00:00:00Z',
    mode: 'live', model: 't', lam: [1.5, 1], probs: [0.5, 0.3, 0.2], pick: 'h', conf: 0.5, over25: 0.5, totals: [0.2, 0.5, 0.3],
    top3: [['1-0', 0.1], ['1-1', 0.09], ['2-0', 0.08]], known: true, market: null,
  });
  const entries = [seal(pred('E0|2026-11-28|Arsenal|Chelsea'), null)];
  const rows = resolveJczq(board(), teamMap, { liveEntries: entries, now: '2026-11-28T10:00:00+08:00' });
  assert.equal(rows.find((r) => r.ref.no === '周六001').status, 'already');
  const refs = { 'E0|2026-11-28|Arsenal|Chelsea': { no: '周六001' }, 'E0|2026-11-21|X|Y': { no: '周六001' } };
  assert.equal(resolveJczqNo('周六001', refs, entries), 'E0|2026-11-28|Arsenal|Chelsea', '只在未结算预测里找，往周同编号不干扰');
  assert.throws(() => resolveJczqNo('周六009', refs, entries), /没有待录赛果/);
});

test('jczq.mjs 端到端：有未映射整批拒绝；--skip-unmapped 只写已映射；按竞彩编号录赛果', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jczq-'));
  const rawFile = path.join(dir, 'raw.json');
  const ledger = path.join(dir, 'live.jsonl');
  writeFileSync(rawFile, JSON.stringify(officialResponse(GAMES)));
  const run = (script, args, now) => spawnSync(process.execPath, [path.join(REPO, 'football/bin', script), ...args], { encoding: 'utf8', env: { ...process.env, FOOTBALL_NOW: now } });

  const refused = run('jczq.mjs', ['--raw', rawFile, '--ledger', ledger], '2026-11-28T10:00:00+08:00');
  assert.equal(refused.status, 5, refused.stderr);
  assert.match(refused.stdout, /不存在队/);
  assert.equal(existsSync(ledger), false, '拒绝时不写台账');

  const ok = run('jczq.mjs', ['--raw', rawFile, '--ledger', ledger, '--skip-unmapped'], '2026-11-28T10:00:00+08:00');
  assert.equal(ok.status, 0, ok.stderr);
  const entries = readLedger(ledger);
  assert.deepEqual(entries.map((e) => e.id), ['E0|2026-11-28|Arsenal|Chelsea', 'SP1|2026-11-28|Real Madrid|Getafe']);
  assert.ok(entries.every((e) => e.mode === 'live' && e.createdAt === '2026-11-28T02:00:00Z'));
  const refs = JSON.parse(readFileSync(path.join(dir, 'jczq-refs.json'), 'utf8'));
  assert.equal(refs['E0|2026-11-28|Arsenal|Chelsea'].no, '周六001');

  const again = run('jczq.mjs', ['--raw', rawFile, '--ledger', ledger, '--skip-unmapped'], '2026-11-28T11:00:00+08:00');
  assert.equal(again.status, 0);
  assert.equal(readLedger(ledger).length, 2, '重跑不重复出预测');

  const early = run('result.mjs', ['--ledger', ledger, '--no', '周六001', '--ft', '2-1', '--source', '官方'], '2026-11-28T23:30:00+08:00');
  assert.equal(early.status, 5, '未完场不能录赛果');
  const result = run('result.mjs', ['--ledger', ledger, '--no', '周六001', '--ft', '2-1', '--source', '官方'], '2026-11-29T02:00:00+08:00');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readLedger(ledger).at(-1).ft, [2, 1]);
});

test('发布页展示竞彩编号与中文队名', () => {
  const entries = [seal({
    type: 'prediction', id: 'E0|2026-11-28|Arsenal|Chelsea', league: 'E0', kickoff: '2026-11-28T15:00:00Z', home: 'Arsenal', away: 'Chelsea',
    createdAt: '2026-11-27T00:00:00Z', mode: 'live', model: 't', lam: [1.5, 1], probs: [0.6, 0.25, 0.15], pick: 'h', conf: 0.6, over25: 0.5,
    totals: [0.2, 0.5, 0.3], top3: [['1-0', 0.1], ['1-1', 0.09], ['2-0', 0.08]], known: true, market: null,
  }, null)];
  const rule = (id, tier, minConf) => ({ id, title: 't', status: 'active', tier, definition: 'd', sample: { ledger: 'ledger/bt.jsonl', filter: { mode: 'backtest', minConf } }, recompute: 'x', claim: { metric: 'direction_hit', rate: 0, n: 0 } });
  const registry = { rules: [rule('R-001', 'high-confidence', 0.53), rule('R-002', 'elite', 0.72)] };
  const gates = { ok: true, gates: [{ id: 'G7', name: '复算一致', ok: true, warnings: [], rules: [] }] };
  const html = renderReport({ generatedAt: '2026-11-27T00:00:00Z', gates, registry, ledgers: [{ label: 'bt', role: 'backtest', entries: [] }, { label: 'live', role: 'live', entries }], model: 't', jczqRefs: { 'E0|2026-11-28|Arsenal|Chelsea': { no: '周六001', home: '阿森纳', away: '切尔西' } } });
  assert.match(html, /周六001/);
  assert.match(html, /阿森纳 vs 切尔西/);
  assert.match(html, /2026-11-28 23:00/, '开赛时间按北京时间展示');
  assert.match(html, /<b>高置信<\/b>（≥ 0.53，R-001）/, 'conf 0.6：高置信档，未到精选档');
});
