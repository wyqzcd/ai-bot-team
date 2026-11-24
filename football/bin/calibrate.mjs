#!/usr/bin/env node
/**
 * 选高置信档阈值：只在训练段（kickoff < --split）上选，留出段只用来报告，绝不回头调参。
 * 规则：在 0.40~0.80（步长 0.01）里取"训练段方向命中 ≥ --target"的最小阈值（覆盖率最大）。
 *
 * 用法：node football/bin/calibrate.mjs [--target 0.66] [--split 2024-07-01] [--ledger <path>]
 */
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { readLedger } from '../src/ledger.mjs';
import { computeStats } from '../src/metrics.mjs';
import { parseArgs, run } from '../src/cli.mjs';

run(async () => {
  const args = parseArgs(process.argv.slice(2), { options: ['target', 'split', 'ledger'] });
  const target = Number(args.target ?? 0.66);
  const split = args.split ?? '2024-07-01';
  const entries = readLedger(args.ledger ? path.resolve(args.ledger) : PATHS.backtestLedger);
  const dayBefore = new Date(Date.parse(`${split}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  let chosen = null;
  const grid = [];
  for (let step = 40; step <= 80; step += 1) {
    const minConf = step / 100;
    const train = computeStats(entries, { mode: 'backtest', to: dayBefore, minConf });
    grid.push({ minConf, n: train.n, coverage: train.coverage, direction: train.direction_hit.rate });
    if (chosen === null && train.direction_hit.rate !== null && train.direction_hit.rate >= target) chosen = minConf;
  }
  if (chosen === null) {
    console.log(JSON.stringify({ target, split, chosen: null, note: '训练段任何阈值都达不到目标', grid }, null, 2));
    process.exit(1);
  }
  const train = computeStats(entries, { mode: 'backtest', to: dayBefore, minConf: chosen });
  const holdout = computeStats(entries, { mode: 'backtest', from: split, minConf: chosen });
  console.log(JSON.stringify({
    target, split, chosen,
    train: { n: train.n, coverage: train.coverage, direction: train.direction_hit.rate, market_fav_same_sample: train.baselines.market_fav.rate },
    holdout: { n: holdout.n, coverage: holdout.coverage, direction: holdout.direction_hit.rate, market_fav_same_sample: holdout.baselines.market_fav.rate, from: split },
  }, null, 2));
});
