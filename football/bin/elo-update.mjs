#!/usr/bin/env node
/**
 * Elo 推算（见 src/elo-update.mjs）。
 *
 * 用法：
 *   node football/bin/elo-update.mjs --select   在训练窗口上选 K/H/margin，写 data/elo-update.json（含训练段、留出段对照）
 *   node football/bin/elo-update.mjs            用已选参数把 data/elo-latest.csv 推到样本库最后一天，写 data/elo-current.csv
 * 两步都是确定性的：同一样本库 → 字节级相同的输出（CI 复现验证会重跑比对）。
 * 选参只看训练窗口（全部早于 2024-07-01）；留出段数字只报告，不参与选择。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { toCsv } from '../src/csv.mjs';
import { loadDataset } from '../src/dataset.mjs';
import { loadEloLatest, loadEloModel } from '../src/elo.mjs';
import {
  ELO_CURRENT_COLUMNS, ELO_CURRENT_FILE, ELO_UPDATE_FILE, ELO_UPDATE_NAME, ELO_UPDATE_VERSION, GRID, HOLDOUT_CUTOFFS, TRAIN_CUTOFFS, WINDOW_DAYS,
  evaluateCutoffs, evaluateWindow, loadEloUpdate, propagateElo, selectParams, summarizeRows,
} from '../src/elo-update.mjs';
import { parseArgs, run } from '../src/cli.mjs';

const rel = (file) => path.relative(process.cwd(), file);

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['select'], options: [] });
  const matches = loadDataset();
  const model = loadEloModel();
  if (args.select) {
    const { params } = selectParams(matches, model);
    const doc = {
      method: `${ELO_UPDATE_NAME}@${ELO_UPDATE_VERSION}`,
      eloModel: model.model,
      grid: GRID,
      windowDays: WINDOW_DAYS,
      trainCutoffs: TRAIN_CUTOFFS,
      holdoutCutoffs: HOLDOUT_CUTOFFS,
      selected: params,
      train: summarizeRows(evaluateCutoffs(matches, TRAIN_CUTOFFS, model, params)),
      holdout: summarizeRows(evaluateCutoffs(matches, HOLDOUT_CUTOFFS, model, params)),
    };
    writeFileSync(ELO_UPDATE_FILE, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(JSON.stringify({ out: rel(ELO_UPDATE_FILE), selected: params, train: doc.train, holdout: doc.holdout }, null, 2));
    return;
  }
  const { selected, method } = loadEloUpdate();
  const snapshot = loadEloLatest();
  const state = propagateElo(snapshot, matches, selected);
  const rows = [...state.entries()]
    .map(([team, s]) => ({ team, division: s.division, date: s.date, elo: s.elo.toFixed(2), basis: s.basis, snapshot: s.snapshot, snapshotElo: s.snapshotElo.toFixed(2), games: String(s.games) }))
    .sort((a, b) => (a.team < b.team ? -1 : 1));
  writeFileSync(ELO_CURRENT_FILE, toCsv(ELO_CURRENT_COLUMNS, rows));
  const moved = rows.filter((r) => r.basis === 'propagated').map((r) => ({ ...r, delta: Number(r.elo) - Number(r.snapshotElo) })).sort((a, b) => b.delta - a.delta);
  // 快照之后的比赛（没有真实 ClubElo 可比）：只报告推算与冻结的对照，供参考，不写文件。
  const lastSnapshot = rows.reduce((max, r) => (r.basis === 'propagated' && r.snapshot > max ? r.snapshot : max), '');
  const after = lastSnapshot ? summarizeRows(evaluateWindow(matches, lastSnapshot, model, selected, { requireOracle: false })) : null;
  console.log(JSON.stringify({
    out: rel(ELO_CURRENT_FILE),
    method,
    params: selected,
    teams: rows.length,
    propagated: moved.length,
    through: moved.reduce((max, r) => (r.date > max ? r.date : max), ''),
    up: moved.slice(0, 5).map((r) => `${r.team} ${r.snapshotElo}→${r.elo}`),
    down: moved.slice(-5).reverse().map((r) => `${r.team} ${r.snapshotElo}→${r.elo}`),
    sinceSnapshot: after,
  }, null, 2));
});
