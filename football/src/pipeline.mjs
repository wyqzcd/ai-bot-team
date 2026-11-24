/** 组装门禁输入：回测台账 + 实盘台账 + 登记表 + 发布锚点。 */
import { existsSync } from 'node:fs';
import { BACKTEST_FROM, PATHS } from './config.mjs';
import { LEAGUES, loadDataset } from './dataset.mjs';
import { readAnchor, runGates } from './gates.mjs';
import { readLedger } from './ledger.mjs';
import { loadRegistry } from './rules.mjs';

export function backtestExpectedIds(matches, from = BACKTEST_FROM) {
  return new Set(matches.filter((m) => m.ft && m.date >= from && m.league in LEAGUES).map((m) => m.id));
}

export function gateInputs({ paths = PATHS, now, dataset } = {}) {
  const ledgers = [];
  if (existsSync(paths.backtestLedger)) {
    ledgers.push({ label: 'backtest', file: paths.backtestLedger, entries: readLedger(paths.backtestLedger), expectedIds: backtestExpectedIds(dataset ?? loadDataset()) });
  }
  ledgers.push({ label: 'live', file: paths.liveLedger, entries: readLedger(paths.liveLedger) });
  return { ledgers, registry: loadRegistry(paths.registry), anchors: readAnchor(paths.anchors), now };
}

export function runAllGates(options = {}) {
  return runGates(gateInputs(options));
}
