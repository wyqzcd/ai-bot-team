#!/usr/bin/env node
/**
 * "不下判断"阈值选择：第一选择与第二选择的概率差（margin）太小，模型其实分不出两者，就不给方向。
 *
 * 固定流程（只看训练段）：margin 阈值 m 从 0.01 起每次放宽 0.01（上限 0.30），
 * 每一步看训练段里 margin < m 的场次：第一选择命中数 h1、第二选择命中数 h2，
 * 单侧检验 z = (h1 − h2) / √(h1 + h2)。第一次 z ≥ 1.645（第一选择显著更好）之前的最后一个 m 就是阈值。
 * 留出段只报告一次，不回头调。
 *
 * 用法：
 *   node football/bin/abstain.mjs --ledger football/ledger/backtest-v3.jsonl --split 2024-07-01
 *       训练段 = 台账里开赛 < split 的场次，留出段 = ≥ split
 *   node football/bin/abstain.mjs --elo
 *       Elo 模型：训练段用样本库 2017-07 ~ 2024-06 现算（与模型参数同一段，台账只有留出段），留出段 = ledger/backtest-elo.jsonl
 */
import path from 'node:path';
import { ELO_HOLDOUT_FROM, PATHS } from '../src/config.mjs';
import { loadDataset } from '../src/dataset.mjs';
import { ELO_TRAIN_FROM, ELO_TRAIN_TO, loadEloModel, predictElo } from '../src/elo.mjs';
import { readLedger } from '../src/ledger.mjs';
import { settled } from '../src/metrics.mjs';
import { Z_CRITICAL, bucket, outcomeIndex, rowOf, selectAbstain } from '../src/abstain.mjs';
import { CliError, parseArgs, run } from '../src/cli.mjs';

const r4 = (x) => Math.round(x * 1e4) / 1e4;

function report(trainRows, holdRows, total) {
  const { threshold, steps } = selectAbstain(trainRows);
  const summary = (rows) => {
    if (threshold === null) return null;
    const abstain = bucket(rows, threshold);
    const called = rows.filter((r) => r.margin >= threshold);
    const calledHits = called.filter((r) => r.h1).length;
    const allHits = rows.filter((r) => r.h1).length;
    return { n: rows.length, abstain, coverageAbstain: r4(abstain.n / rows.length), called: { n: called.length, rate: r4(calledHits / called.length) }, all: { rate: r4(allHits / rows.length) } };
  };
  return { threshold, train: summary(trainRows), holdout: summary(holdRows), steps, total };
}

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['elo'], options: ['ledger', 'split'] });
  let trainRows;
  let holdRows;
  let label;
  if (args.elo) {
    const params = loadEloModel();
    trainRows = loadDataset()
      .filter((m) => m.ft && m.elo && m.date >= ELO_TRAIN_FROM && m.date <= ELO_TRAIN_TO)
      .map((m) => {
        const p = predictElo(params, m.elo.h, m.elo.a).probs;
        return rowOf(['h', 'd', 'a'].map((k) => Math.round(p[k] * 1e4) / 1e4), outcomeIndex([m.ft.h, m.ft.a]));
      });
    holdRows = settled(readLedger(PATHS.eloBacktestLedger)).filter((x) => x.prediction.kickoff.slice(0, 10) >= ELO_HOLDOUT_FROM).map((x) => rowOf(x.prediction.probs, outcomeIndex(x.result.ft)));
    label = `${params.model}（训练段 ${ELO_TRAIN_FROM} ~ ${ELO_TRAIN_TO} 现算；留出段 ${path.basename(PATHS.eloBacktestLedger)}）`;
  } else {
    if (!args.ledger || !args.split) throw new CliError('需要 --ledger 与 --split（或 --elo）');
    const items = settled(readLedger(path.resolve(args.ledger))).filter((x) => x.prediction.mode === 'backtest');
    const rows = items.map((x) => ({ date: x.prediction.kickoff.slice(0, 10), ...rowOf(x.prediction.probs, outcomeIndex(x.result.ft)) }));
    trainRows = rows.filter((r) => r.date < args.split);
    holdRows = rows.filter((r) => r.date >= args.split);
    label = `${path.basename(args.ledger)}（训练段 < ${args.split}）`;
  }
  console.log(JSON.stringify({ source: label, zCritical: Z_CRITICAL, ...report(trainRows, holdRows) }, null, 2));
});
