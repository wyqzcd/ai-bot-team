#!/usr/bin/env node
/**
 * 欧冠候选：赛后从 UEFA 官方接口录比分，并复算命中。
 * - 只录 status=FINISHED 且有常规时间比分（score.regular）的场次；联赛阶段没有加时，常规时间比分即胜平负口径。
 * - 只给候选台账里已有预测的场次录赛果；录入走与实盘相同的预检（开赛 105 分钟后、不得重复）。
 * - 抓到的赛果另存精简快照 football/fixtures/ucl/<date>.results.json，便于离线复核。
 *
 * 用法：NODE_USE_ENV_PROXY=1 node football/bin/ucl-results.mjs --date 2026-11-24 [--dry-run]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { appendEntries, foldLedger, readLedger } from '../src/ledger.mjs';
import { LiveError, planResult } from '../src/live.mjs';
import { computeStats, review } from '../src/metrics.mjs';
import { UCL_SNAPSHOT_DIR, UEFA_MATCHES_URL, eloNames, loadUefaTeamMap, uclMatchId } from '../src/ucl.mjs';
import { CliError, now, parseArgs, run } from '../src/cli.mjs';

const PICK = { h: '主胜', d: '平', a: '客胜' };
export const UCL_TIER_MIN_CONF = 0.54; // 与 R-013 相同的高置信档阈值

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['dry-run'], options: ['date'] });
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new CliError('需要 --date YYYY-MM-DD');
  let response;
  try {
    response = await fetch(UEFA_MATCHES_URL(args.date), { signal: AbortSignal.timeout(20000) });
  } catch (error) {
    throw new CliError(`UEFA 抓取失败：${error.message}`, 6);
  }
  if (!response.ok) throw new CliError(`UEFA 抓取失败：HTTP ${response.status}`, 6);
  const at = now();
  const raw = await response.json();
  const matches = raw.filter((m) => m.kickOffTime?.date === args.date).map((m) => ({
    uefaMatchId: m.id,
    kickoff: m.kickOffTime.dateTime,
    status: m.status,
    fullTimeAt: m.fullTimeAt ?? null,
    score: m.score?.regular ?? null,
    home: { id: m.homeTeam.id, name: m.homeTeam.internationalName },
    away: { id: m.awayTeam.id, name: m.awayTeam.internationalName },
  }));
  if (!matches.length) {
    console.log(`${args.date} 没有欧冠比赛。`);
    return;
  }

  const teamMap = loadUefaTeamMap();
  let entries = readLedger(PATHS.uclLedger);
  const added = [];
  for (const m of matches) {
    const names = eloNames(m, teamMap);
    if (names.includes(null)) continue;
    const id = uclMatchId(m, names);
    const item = foldLedger(entries).find((x) => x.id === id);
    if (!item?.prediction) continue;
    if (item.result) continue;
    if (m.status !== 'FINISHED' || !m.score) {
      console.log(`  [未完场] ${m.home.name} vs ${m.away.name}（${m.status}）`);
      continue;
    }
    try {
      const sealed = planResult({ liveEntries: entries, id, ft: [m.score.home, m.score.away], now: at, source: `UEFA match.uefa.com #${m.uefaMatchId}` });
      entries = [...entries, ...sealed];
      added.push(...sealed);
    } catch (error) {
      if (error instanceof LiveError) throw new CliError(error.message, 5);
      throw error;
    }
  }
  if (added.length && !args['dry-run']) {
    appendEntries(PATHS.uclLedger, added.map(({ seq, prev, hash, ...rest }) => rest));
    // 赛果快照只在确实录入了赛果时写，作为录入依据；重跑不会产生无意义的改动。
    mkdirSync(UCL_SNAPSHOT_DIR, { recursive: true });
    writeFileSync(path.join(UCL_SNAPSHOT_DIR, `${args.date}.results.json`), `${JSON.stringify({ source: UEFA_MATCHES_URL(args.date), fetchedAt: at, matches }, null, 2)}\n`);
  }

  console.log(`本次录入 ${added.length} 场${args['dry-run'] ? '（dry-run，未写入）' : ''}`);
  for (const item of foldLedger(entries).filter((x) => x.prediction).sort((a, b) => (a.prediction.kickoff < b.prediction.kickoff ? -1 : 1))) {
    const p = item.prediction;
    const r = item.result;
    const actual = r ? (r.ft[0] > r.ft[1] ? 'h' : r.ft[0] === r.ft[1] ? 'd' : 'a') : null;
    const mark = !r ? '未赛' : actual === p.pick ? '✔ 命中' : '✘ 未中';
    console.log(`  ${p.home} vs ${p.away}  预测 ${PICK[p.pick]}（${(p.conf * 100).toFixed(1)}%${p.conf >= UCL_TIER_MIN_CONF ? '，高置信档' : ''}）  赛果 ${r ? `${r.ft[0]}-${r.ft[1]}（${PICK[actual]}）` : '—'}  ${mark}`);
  }
  const all = computeStats(entries, { mode: 'live' });
  const tier = computeStats(entries, { mode: 'live', minConf: UCL_TIER_MIN_CONF });
  const rev = review(entries, { mode: 'live' });
  console.log(`方向命中：${all.direction_hit.hits}/${all.n}；高置信档（conf ≥ ${UCL_TIER_MIN_CONF}）${tier.direction_hit.hits}/${tier.n}；比分 TOP3 ${all.score_top3_hit.hits}/${all.n}`);
  console.log(`未中归因：${JSON.stringify(rev.buckets)}（无赔率，无法区分爆冷与模型逆市场）`);
  console.log('样本极小，只作记录，不作结论（R-014 仍为候选）。');
});
