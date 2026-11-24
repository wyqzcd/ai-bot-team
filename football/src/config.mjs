/** 路径与口径常量：脚本之间只从这里取，避免各写各的。 */
import path from 'node:path';
import { FOOTBALL_ROOT } from './dataset.mjs';

export const BACKTEST_FROM = '2019-07-01';
export const PATHS = {
  backtestLedger: path.join(FOOTBALL_ROOT, 'ledger', 'backtest.jsonl'),
  liveLedger: path.join(FOOTBALL_ROOT, 'ledger', 'live.jsonl'),
  anchors: path.join(FOOTBALL_ROOT, 'ledger', 'published.json'),
  registry: path.join(FOOTBALL_ROOT, 'rules', 'registry.json'),
  reports: path.join(FOOTBALL_ROOT, 'reports'),
};
