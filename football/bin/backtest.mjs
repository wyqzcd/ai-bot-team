#!/usr/bin/env node
/**
 * 生成回测台账 football/ledger/backtest.jsonl（确定性：同一数据集 + 同一模型版本 → 字节级相同）。
 *
 * 用法：node football/bin/backtest.mjs [--from 2019-07-01] [--to YYYY-MM-DD] [--out <path>] [--data <csv>]
 *
 * 预测时点 = 比赛日 00:00 UTC，只用此前已完赛比赛拟合；赛果条目时间 = 开球 + 2 小时。
 */
import path from 'node:path';
import { DEFAULT_DATASET, loadDataset } from '../src/dataset.mjs';
import { BACKTEST_FROM, PATHS } from '../src/config.mjs';
import { predictionEntry, resultEntry, seal, writeLedger } from '../src/ledger.mjs';
import { MODEL_NAME, MODEL_VERSION, walkForward } from '../src/walkforward.mjs';
import { parseArgs, run } from '../src/cli.mjs';

run(async () => {
  const args = parseArgs(process.argv.slice(2), { options: ['from', 'to', 'out', 'data'] });
  const matches = loadDataset(args.data ?? DEFAULT_DATASET);
  const { predictions, skipped } = walkForward(matches, { from: args.from ?? BACKTEST_FROM, to: args.to });
  const model = `${MODEL_NAME}@${MODEL_VERSION}`;
  const events = [];
  for (const { match, asOf, pred } of predictions) {
    events.push({ at: asOf, order: 0, entry: predictionEntry({ match, createdAt: asOf, mode: 'backtest', model, pred, market: match.odds }) });
    const recordedAt = new Date(Date.parse(match.kickoff) + 2 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    events.push({ at: recordedAt, order: 1, entry: resultEntry({ id: match.id, ft: [match.ft.h, match.ft.a], ht: match.ht ? [match.ht.h, match.ht.a] : null, recordedAt, source: 'dataset' }) });
  }
  events.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.order - y.order || (x.entry.id < y.entry.id ? -1 : 1)));
  const sealed = [];
  for (const { entry } of events) sealed.push(seal(entry, sealed.at(-1) ?? null));
  const out = args.out ?? PATHS.backtestLedger;
  writeLedger(out, sealed);
  console.log(JSON.stringify({ out: path.relative(process.cwd(), out) || out, entries: sealed.length, predictions: predictions.length, skippedDays: skipped.length, model }));
});
