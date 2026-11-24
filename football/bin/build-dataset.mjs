#!/usr/bin/env node
/**
 * 从原始全量 CSV（xgabora/Club-Football-Match-Data-2000-2025 的 data/Matches.csv）
 * 裁出五大联赛样本库 football/data/big5.csv。只保留建模与复算需要的列。
 *
 * 用法：node football/bin/build-dataset.mjs --raw <Matches.csv> [--from 2017-07-01] [--out football/data/big5.csv]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv, toCsv } from '../src/csv.mjs';
import { DATASET_COLUMNS, DEFAULT_DATASET, LEAGUES } from '../src/dataset.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const raw = arg('--raw');
if (!raw) {
  console.error('缺少 --raw <Matches.csv>');
  process.exit(2);
}
const from = arg('--from', '2017-07-01');
const out = arg('--out', DEFAULT_DATASET);

const intText = (value) => (value === '' ? '' : String(Math.round(Number(value))));
const rows = parseCsv(readFileSync(raw, 'utf8'))
  .filter((row) => row.Division in LEAGUES && row.MatchDate >= from && row.FTHome !== '' && row.FTAway !== '')
  .map((row) => ({
    league: row.Division,
    date: row.MatchDate,
    time: row.MatchTime ? row.MatchTime.slice(0, 5) : '',
    home: row.HomeTeam,
    away: row.AwayTeam,
    fthg: intText(row.FTHome),
    ftag: intText(row.FTAway),
    hthg: intText(row.HTHome),
    htag: intText(row.HTAway),
    odd_h: row.OddHome,
    odd_d: row.OddDraw,
    odd_a: row.OddAway,
    odd_over25: row.Over25,
    odd_under25: row.Under25,
  }))
  .sort((a, b) => (a.date + a.time + a.league + a.home < b.date + b.time + b.league + b.home ? -1 : 1));

writeFileSync(out, toCsv(DATASET_COLUMNS, rows));
console.log(JSON.stringify({ out, rows: rows.length, from, to: rows.at(-1)?.date }));
