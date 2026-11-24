#!/usr/bin/env node
/**
 * 欧冠首发标注（只标注、不改预测）：
 * - 常规主力 = 本赛季此前欧冠比赛里首发 ≥ REGULAR_MIN_STARTS 场的球员（UEFA 官方首发数据）。
 * - 当天首发公布后，列出"常规主力未进首发"的球员；未公布则记为未公布。
 * 结果写入 ledger/ucl-notes.json（按场次、带抓取时间）。没有历史数据能回测"缺阵扣多少"，所以不进模型、不改台账里的概率。
 *
 * 伤停：UEFA 接口不提供伤停名单，原伤停数据源（TheStatsAPI）密钥已失效，本脚本不处理伤停。
 *
 * 用法：node football/bin/ucl-lineups.mjs --date 2026-11-24 [--season-from 2026-09-01]
 * 需要网络（match.uefa.com）；Node 内置 fetch 走代理需设 NODE_USE_ENV_PROXY=1。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FOOTBALL_ROOT } from '../src/dataset.mjs';
import { CliError, now, parseArgs, run } from '../src/cli.mjs';

export const REGULAR_MIN_STARTS = 3;
const NOTES = path.join(FOOTBALL_ROOT, 'ledger', 'ucl-notes.json');
const BASE = 'https://match.uefa.com/v5/matches';

async function getJson(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch (error) {
    throw new CliError(`抓取失败 ${url}：${error.message}`, 6);
  }
  if (!response.ok) throw new CliError(`抓取失败 ${url}：HTTP ${response.status}`, 6);
  return response.json();
}

const starters = (side) => (side?.field ?? []).map((p) => ({ id: p.player.id, name: p.player.internationalName, pos: p.player.fieldPosition }));

run(async () => {
  const args = parseArgs(process.argv.slice(2), { options: ['date', 'season-from'] });
  if (!args.date) throw new CliError('需要 --date YYYY-MM-DD');
  const snapshotFile = path.join(FOOTBALL_ROOT, 'fixtures', 'ucl', `${args.date}.json`);
  if (!existsSync(snapshotFile)) throw new CliError(`没有快照 ${snapshotFile}`, 3);
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  const dayBefore = new Date(Date.parse(`${args.date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const history = await getJson(`${BASE}?competitionId=1&fromDate=${args['season-from'] ?? '2026-09-01'}&toDate=${dayBefore}&order=ASC&offset=0&limit=300`);
  const finished = history.filter((m) => m.status === 'FINISHED');

  const teamIds = new Set(snapshot.matches.flatMap((m) => [m.home.id, m.away.id]));
  const starts = new Map(); // teamId → Map(playerId → {name, pos, n})
  const played = new Map(); // teamId → 场数
  for (const m of finished) {
    const sides = [['homeTeam', m.homeTeam.id], ['awayTeam', m.awayTeam.id]].filter(([, id]) => teamIds.has(id));
    if (!sides.length) continue;
    const lineups = await getJson(`${BASE}/${m.id}/lineups`);
    for (const [key, id] of sides) {
      const xi = starters(lineups[key]);
      if (!xi.length) continue;
      played.set(id, (played.get(id) ?? 0) + 1);
      if (!starts.has(id)) starts.set(id, new Map());
      for (const p of xi) {
        const cur = starts.get(id).get(p.id) ?? { name: p.name, pos: p.pos, n: 0 };
        cur.n += 1;
        starts.get(id).set(p.id, cur);
      }
    }
  }

  const notes = existsSync(NOTES) ? JSON.parse(readFileSync(NOTES, 'utf8')) : {};
  const at = now();
  for (const m of snapshot.matches) {
    const today = await getJson(`${BASE}/${m.uefaMatchId}/lineups`);
    const published = today.lineupStatus && today.lineupStatus !== 'NOT_AVAILABLE' && starters(today.homeTeam).length > 0;
    const sides = [['homeTeam', m.home], ['awayTeam', m.away]].map(([key, team]) => {
      const regulars = [...(starts.get(team.id) ?? new Map()).values()].filter((p) => p.n >= REGULAR_MIN_STARTS);
      const xi = published ? new Set(starters(today[key]).map((p) => p.name)) : null;
      return {
        team: team.name,
        priorMatches: played.get(team.id) ?? 0,
        regulars: regulars.length,
        missingRegulars: xi ? regulars.filter((p) => !xi.has(p.name)).map((p) => `${p.name}（${p.pos}，此前首发 ${p.n} 场）`) : null,
      };
    });
    notes[m.uefaMatchId] = { kickoff: m.kickoff, match: `${m.home.name} vs ${m.away.name}`, checkedAt: at, lineupStatus: today.lineupStatus ?? null, published, sides };
    const line = sides.map((s) => `${s.team}：${s.missingRegulars === null ? `首发未公布（常规主力 ${s.regulars} 人）` : s.missingRegulars.length ? `缺 ${s.missingRegulars.join('、')}` : '常规主力全部首发'}`).join('；');
    console.log(`${m.kickoff} ${m.home.name} vs ${m.away.name}  ${line}`);
  }
  writeFileSync(NOTES, `${JSON.stringify(notes, null, 2)}\n`);
});
