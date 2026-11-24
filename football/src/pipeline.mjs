/** 组装门禁输入：回测台账 + 实盘台账 + 登记表 + 发布锚点。 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BACKTEST_FROM, BACKTEST_TO, ELO_HOLDOUT_FROM, FROZEN_LEDGERS, PATHS } from './config.mjs';
import { LEAGUES, loadDataset } from './dataset.mjs';
import { readAnchor, runGates } from './gates.mjs';
import { readLedger } from './ledger.mjs';
import { loadRegistry } from './rules.mjs';

export function backtestExpectedIds(matches, from = BACKTEST_FROM, to = BACKTEST_TO) {
  return new Set(matches.filter((m) => m.ft && m.date >= from && m.date <= to && m.league in LEAGUES).map((m) => m.id));
}

/** 台账标签 = 文件名去掉 .jsonl；发布锚点与报告都按标签索引。 */
export const ledgerLabel = (file) => path.basename(file, '.jsonl');

export function gateInputs({ paths = PATHS, frozen = FROZEN_LEDGERS, now, dataset } = {}) {
  const ledgers = [];
  if (existsSync(paths.backtestLedger)) {
    ledgers.push({ label: ledgerLabel(paths.backtestLedger), role: 'backtest', file: paths.backtestLedger, entries: readLedger(paths.backtestLedger), expectedIds: backtestExpectedIds(dataset ?? loadDataset()) });
  }
  if (paths.eloBacktestLedger && existsSync(paths.eloBacktestLedger)) {
    const matches = dataset ?? loadDataset();
    const expectedIds = new Set(matches.filter((m) => m.ft && m.elo && m.date >= ELO_HOLDOUT_FROM && m.date <= BACKTEST_TO && m.league in LEAGUES).map((m) => m.id));
    ledgers.push({ label: ledgerLabel(paths.eloBacktestLedger), role: 'aux', file: paths.eloBacktestLedger, entries: readLedger(paths.eloBacktestLedger), expectedIds });
  }
  for (const file of frozen) {
    if (existsSync(file)) ledgers.push({ label: ledgerLabel(file), role: 'frozen', file, entries: readLedger(file) });
  }
  ledgers.push({ label: ledgerLabel(paths.liveLedger), role: 'live', file: paths.liveLedger, entries: readLedger(paths.liveLedger) });
  if (paths.uclLedger && existsSync(paths.uclLedger)) {
    ledgers.push({ label: ledgerLabel(paths.uclLedger), role: 'candidate', file: paths.uclLedger, entries: readLedger(paths.uclLedger) });
  }
  return { ledgers, registry: loadRegistry(paths.registry), anchors: readAnchor(paths.anchors), now, dataQuality: paths.dataQuality ?? {} };
}

export function runAllGates(options = {}) {
  return runGates(gateInputs(options));
}
