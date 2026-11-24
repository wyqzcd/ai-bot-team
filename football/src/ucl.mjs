/** 欧冠候选流程的共用口径：UEFA 场次 → 台账 id。ucl.mjs（出预测）与 ucl-results.mjs（录赛果）必须用同一套。 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FOOTBALL_ROOT } from './dataset.mjs';

export const UEFA_MATCHES_URL = (date) => `https://match.uefa.com/v5/matches?competitionId=1&fromDate=${date}&toDate=${date}&order=ASC&offset=0&limit=50`;
export const UCL_SNAPSHOT_DIR = path.join(FOOTBALL_ROOT, 'fixtures', 'ucl');
export const UEFA_TEAM_MAP = path.join(FOOTBALL_ROOT, 'data', 'uefa-teams.json');

export const loadUefaTeamMap = (file = UEFA_TEAM_MAP) => JSON.parse(readFileSync(file, 'utf8')).teams;

/** 返回 [Elo 主队名, Elo 客队名]，查不到的一方为 null。 */
export const eloNames = (match, teamMap) => [match.home, match.away].map((t) => teamMap[t.id]?.elo ?? null);

export const uclMatchId = (match, names) => `UCL|${match.kickoff.slice(0, 10)}|${names[0]}|${names[1]}`;
