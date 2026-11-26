/**
 * 欧战候选流程（欧冠 / 欧联）的共用口径：UEFA 场次 → 台账 id。
 * ucl.mjs（出预测）与 ucl-results.mjs（录赛果）必须用同一套。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.mjs';
import { FOOTBALL_ROOT } from './dataset.mjs';

/**
 * 赛事口径。uefaId 为 match.uefa.com 的 competitionId；prefix 同时是台账 id 前缀与 league 字段。
 * ledger：新预测写入的台账；ledgers：录赛果时查找预测的全部版本台账。
 */
export const COMPETITIONS = {
  ucl: { key: 'ucl', uefaId: 1, prefix: 'UCL', name: '欧冠', snapshotDir: path.join(FOOTBALL_ROOT, 'fixtures', 'ucl'), ledger: PATHS.uclLedger, ledgers: PATHS.uclLedgers },
  uel: { key: 'uel', uefaId: 14, prefix: 'UEL', name: '欧联', snapshotDir: path.join(FOOTBALL_ROOT, 'fixtures', 'uel'), ledger: PATHS.uelLedger, ledgers: [PATHS.uelLedger] },
};

export function competitionOf(key = 'ucl') {
  const c = COMPETITIONS[key];
  if (!c) throw new RangeError(`未知赛事：${key}（可选 ${Object.keys(COMPETITIONS).join('/')}）`);
  return c;
}

export const UEFA_MATCHES_URL = (date, competitionId = 1) => `https://match.uefa.com/v5/matches?competitionId=${competitionId}&fromDate=${date}&toDate=${date}&order=ASC&offset=0&limit=60`;
export const UCL_SNAPSHOT_DIR = COMPETITIONS.ucl.snapshotDir;
/** UEFA 球队编号在各赛事间通用，欧冠、欧联共用一张对照表。 */
export const UEFA_TEAM_MAP = path.join(FOOTBALL_ROOT, 'data', 'uefa-teams.json');

export const loadUefaTeamMap = (file = UEFA_TEAM_MAP) => JSON.parse(readFileSync(file, 'utf8')).teams;

/** 返回 [Elo 主队名, Elo 客队名]，查不到的一方为 null。 */
export const eloNames = (match, teamMap) => [match.home, match.away].map((t) => teamMap[t.id]?.elo ?? null);

export const uclMatchId = (match, names, prefix = 'UCL') => `${prefix}|${match.kickoff.slice(0, 10)}|${names[0]}|${names[1]}`;
