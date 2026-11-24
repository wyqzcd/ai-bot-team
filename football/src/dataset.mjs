/**
 * 样本库：五大联赛逐场赛果 + 射正 + 赛前赔率（赔率只用于对照基线，不进模型）。
 * 口径：一行一场；kickoff 用比赛日 + 开球时间（数据源为当地时间，缺省 12:00），
 * 只用于"预测必须早于开赛"的锁定判断，不参与建模。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.mjs';

export const FOOTBALL_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DATASET = path.join(FOOTBALL_ROOT, 'data', 'big5.csv');

export const LEAGUES = {
  E0: '英超',
  SP1: '西甲',
  I1: '意甲',
  D1: '德甲',
  F1: '法甲',
};

/**
 * 数据源同一球队前后用过两种写法（2024-12 起切换），不合并会被当成两支球队、各只有一半样本。
 * 统一到最新写法。新增别名必须同时补单测（样本库里不得再出现左侧写法）。
 */
export const TEAM_ALIASES = Object.freeze({
  'Nottm Forest': "Nott'm Forest",
  MGladbach: "M'gladbach",
});

export const canonicalTeam = (name) => TEAM_ALIASES[name] ?? name;

export const DATASET_COLUMNS = [
  'league', 'date', 'time', 'home', 'away',
  'fthg', 'ftag', 'hthg', 'htag',
  'odd_h', 'odd_d', 'odd_a', 'odd_over25', 'odd_under25',
  'hst', 'ast',
  'home_elo', 'away_elo',
];

function num(value) {
  if (value === '' || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function matchId(row) {
  return `${row.league}|${row.date}|${row.home}|${row.away}`;
}

export function kickoffOf(date, time) {
  const hhmm = /^\d{2}:\d{2}/.test(time ?? '') ? time.slice(0, 5) : '12:00';
  return `${date}T${hhmm}:00Z`;
}

/** 把数据集一行转成内部比赛对象；赛果/赔率缺失置 null，由调用方决定是否可用。 */
export function toMatch(row) {
  const fthg = num(row.fthg);
  const ftag = num(row.ftag);
  const odds = [num(row.odd_h), num(row.odd_d), num(row.odd_a)];
  return {
    id: matchId(row),
    league: row.league,
    date: row.date,
    kickoff: kickoffOf(row.date, row.time),
    home: row.home,
    away: row.away,
    ft: fthg === null || ftag === null ? null : { h: fthg, a: ftag },
    ht: num(row.hthg) === null || num(row.htag) === null ? null : { h: num(row.hthg), a: num(row.htag) },
    odds: odds.every((value) => value !== null && value > 1) ? odds : null,
    oddsOU: num(row.odd_over25) && num(row.odd_under25) ? [num(row.odd_over25), num(row.odd_under25)] : null,
    // 射正（shots on target）：只作为球队强弱的第二信号进模型，缺失则该场不参与射正评分。
    sot: num(row.hst) === null || num(row.ast) === null ? null : { h: num(row.hst), a: num(row.ast) },
    // 赛前 ClubElo 评分（跨联赛可比）：只给 Elo 候选模型用，泊松模型不用。
    elo: num(row.home_elo) === null || num(row.away_elo) === null ? null : { h: num(row.home_elo), a: num(row.away_elo) },
  };
}

export function loadDataset(file = DEFAULT_DATASET) {
  const rows = parseCsv(readFileSync(file, 'utf8'));
  const matches = rows.map(toMatch);
  matches.sort((a, b) => (a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : a.id < b.id ? -1 : 1));
  return matches;
}
