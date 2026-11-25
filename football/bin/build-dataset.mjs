#!/usr/bin/env node
/**
 * 从原始全量 CSV（xgabora/Club-Football-Match-Data-2000-2025 的 data/Matches.csv）
 * 裁出五大联赛样本库 football/data/big5.csv。只保留建模与复算需要的列。
 *
 * 用法：node football/bin/build-dataset.mjs --raw <Matches.csv> [--from 2017-07-01] [--source-url <原始文件地址>]
 *        [--fd-a <镜像A目录> --fd-b <镜像B目录> [--fd-seasons 2526,2627]]
 *        追加 football-data.co.uk 新比赛（双源核验，见 src/sources.mjs）。两个目录分别来自两个互相独立的镜像，
 *        布局为 <目录>/<赛季>/<联赛>.csv；不给 --fd-seasons 时布局为 <目录>/<联赛>.csv。
 * 同时写 data/manifest.json：原始文件 sha256 + 产出文件 sha256，供 G8 校验（原始文件不入库，凭指纹确认版本）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MANIFEST_FILE, sha256File } from '../src/quality.mjs';
import path from 'node:path';
import { parseCsv, toCsv } from '../src/csv.mjs';
import { DATASET_COLUMNS, DEFAULT_DATASET, LEAGUES, canonicalTeam } from '../src/dataset.mjs';
import { FD_MIRRORS, mergeFootballData } from '../src/sources.mjs';

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
const sourceUrl = arg('--source-url', 'https://raw.githubusercontent.com/xgabora/Club-Football-Match-Data-2000-2025/main/data/Matches.csv');

const intText = (value) => (value === '' ? '' : String(Math.round(Number(value))));
const baseRows = parseCsv(readFileSync(raw, 'utf8'))
  .filter((row) => row.Division in LEAGUES && row.MatchDate >= from && row.FTHome !== '' && row.FTAway !== '')
  .map((row) => ({
    league: row.Division,
    date: row.MatchDate,
    time: row.MatchTime ? row.MatchTime.slice(0, 5) : '',
    home: canonicalTeam(row.HomeTeam),
    away: canonicalTeam(row.AwayTeam),
    fthg: intText(row.FTHome),
    ftag: intText(row.FTAway),
    hthg: intText(row.HTHome),
    htag: intText(row.HTAway),
    odd_h: row.OddHome,
    odd_d: row.OddDraw,
    odd_a: row.OddAway,
    odd_over25: row.Over25,
    odd_under25: row.Under25,
    hst: intText(row.HomeTarget),
    ast: intText(row.AwayTarget),
    home_elo: row.HomeElo,
    away_elo: row.AwayElo,
  }))
  .sort((a, b) => (a.date + a.time + a.league + a.home < b.date + b.time + b.league + b.home ? -1 : 1));

let rows = baseRows;
let secondary = null;
const fdA = arg('--fd-a');
const fdB = arg('--fd-b');
if (Boolean(fdA) !== Boolean(fdB)) {
  console.error('--fd-a 与 --fd-b 必须同时提供（双源核验）');
  process.exit(2);
}
if (fdA) {
  const seasons = arg('--fd-seasons') ? arg('--fd-seasons').split(',').filter(Boolean) : [null];
  const files = {};
  for (const season of seasons) {
    for (const lg of Object.keys(LEAGUES)) {
      const rel = season ? path.join(season, `${lg}.csv`) : `${lg}.csv`;
      files[season ? `${lg}@${season}` : lg] = [readFileSync(path.join(fdA, rel), 'utf8'), readFileSync(path.join(fdB, rel), 'utf8')];
    }
  }
  try {
    const merged = mergeFootballData(baseRows, files);
    rows = merged.rows;
    secondary = { name: 'football-data.co.uk（GitHub 镜像，双源核验）', mirrors: FD_MIRRORS, files: merged.sources, overlapVerified: merged.overlap, appended: merged.appended, appendedAfter: merged.baseMax };
  } catch (error) {
    console.error(error.message);
    process.exit(5);
  }
}

writeFileSync(out, toCsv(DATASET_COLUMNS, rows));

// 各队最新 ClubElo 快照（全部联赛，不止五大联赛）：给欧冠等跨联赛比赛用。
const latest = new Map();
for (const row of parseCsv(readFileSync(raw, 'utf8'))) {
  for (const [team, elo] of [[row.HomeTeam, row.HomeElo], [row.AwayTeam, row.AwayElo]]) {
    if (!elo || !team) continue;
    const name = canonicalTeam(team);
    const prev = latest.get(name);
    if (!prev || row.MatchDate >= prev.date) latest.set(name, { team: name, division: row.Division, date: row.MatchDate, elo: Number(elo).toFixed(2) });
  }
}
const eloOut = path.join(path.dirname(out), 'elo-latest.csv');
writeFileSync(eloOut, toCsv(['team', 'division', 'date', 'elo'], [...latest.values()].sort((a, b) => (a.team < b.team ? -1 : 1))));
console.log(JSON.stringify({ out, rows: rows.length, from, to: rows.at(-1)?.date, appended: secondary?.appended ?? 0, overlapVerified: secondary?.overlapVerified ?? 0 }));

if (out === DEFAULT_DATASET) {
  const manifest = {
    source: { url: sourceUrl, sha256: sha256File(raw), rows: baseRows.length, from, to: baseRows.at(-1)?.date ?? null },
    ...(secondary ? { secondary } : {}),
    dataset: { rows: rows.length, to: rows.at(-1)?.date ?? null },
    outputs: { 'big5.csv': sha256File(out), 'elo-latest.csv': sha256File(eloOut) },
  };
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
}
