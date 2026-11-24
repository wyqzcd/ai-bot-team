#!/usr/bin/env node
/**
 * Elo 泊松模型：在训练段拟合参数并写入 data/elo-model.json，再在留出段（2024-07-01 ~ BACKTEST_TO）
 * 生成回测台账 ledger/backtest-elo.jsonl。参数只用训练段，留出段预测不存在未来信息。
 * 确定性：同一样本库 → 字节级相同的参数文件与台账。
 *
 * 用法：node football/bin/elo-backtest.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKTEST_TO, ELO_HOLDOUT_FROM, PATHS } from '../src/config.mjs';
import { loadDataset } from '../src/dataset.mjs';
import { ELO_MODEL_FILE, fitEloPoisson, predictElo } from '../src/elo.mjs';
import { predictionEntry, resultEntry, seal, writeLedger } from '../src/ledger.mjs';
import { run } from '../src/cli.mjs';

const ELO_BACKTEST_LEDGER = PATHS.eloBacktestLedger;

run(async () => {
  const matches = loadDataset();
  const params = fitEloPoisson(matches);
  writeFileSync(ELO_MODEL_FILE, `${JSON.stringify(params, null, 2)}\n`);
  const events = [];
  for (const match of matches) {
    if (!match.ft || !match.elo || match.date < ELO_HOLDOUT_FROM || match.date > BACKTEST_TO) continue;
    const createdAt = `${match.date}T00:00:00Z`;
    const pred = predictElo(params, match.elo.h, match.elo.a);
    events.push({ at: createdAt, order: 0, entry: predictionEntry({ match, createdAt, mode: 'backtest', model: params.model, pred, market: match.odds }) });
    const recordedAt = new Date(Date.parse(match.kickoff) + 2 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    events.push({ at: recordedAt, order: 1, entry: resultEntry({ id: match.id, ft: [match.ft.h, match.ft.a], ht: match.ht ? [match.ht.h, match.ht.a] : null, recordedAt, source: 'dataset' }) });
  }
  events.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.order - y.order || (x.entry.id < y.entry.id ? -1 : 1)));
  const sealed = [];
  for (const { entry } of events) sealed.push(seal(entry, sealed.at(-1) ?? null));
  writeLedger(ELO_BACKTEST_LEDGER, sealed);
  console.log(JSON.stringify({ params, ledger: path.relative(process.cwd(), ELO_BACKTEST_LEDGER), predictions: sealed.length / 2 }));
});
