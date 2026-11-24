#!/usr/bin/env node
/**
 * 欧冠（候选）：UEFA 官方赛程 → Elo 泊松模型 → 候选台账 ledger/ucl-candidate.jsonl（开赛即锁定）。
 *
 * 该模型只在五大联赛联赛内比赛上校准过，没有欧冠样本可回测，所以这里的预测只是候选（R-013），
 * 不进入结论、不计入实盘规则 R-004。
 *
 * 用法：
 *   node football/bin/ucl.mjs --fetch --date 2026-11-24   抓 UEFA 官方当天赛程，存 football/fixtures/ucl/<date>.json（精简快照）
 *   node football/bin/ucl.mjs --date 2026-11-24 [--dry-run]   读快照，出预测并写候选台账
 *
 * 口径（出预测前固定）：
 * - 球队按 UEFA 球队编号查 data/uefa-teams.json，再查 data/elo-latest.csv；任一方查不到 → 不出预测。
 * - 任一方 Elo 快照日期早于开赛 MAX_ELO_AGE_DAYS 天 → 评分过旧，不出预测。
 * - 只预测未开赛（now < kickoff）且台账里还没有预测的场次。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { FOOTBALL_ROOT } from '../src/dataset.mjs';
import { loadEloLatest, loadEloModel, predictElo } from '../src/elo.mjs';
import { appendEntries, foldLedger, predictionEntry, readLedger } from '../src/ledger.mjs';
import { LiveError, precheckAppend } from '../src/live.mjs';
import { CliError, now, parseArgs, run } from '../src/cli.mjs';

export const MAX_ELO_AGE_DAYS = 120;
const UCL_LEDGER = PATHS.uclLedger;
const SNAPSHOT_DIR = path.join(FOOTBALL_ROOT, 'fixtures', 'ucl');
const TEAM_MAP = path.join(FOOTBALL_ROOT, 'data', 'uefa-teams.json');
const UEFA_URL = (date) => `https://match.uefa.com/v5/matches?competitionId=1&fromDate=${date}&toDate=${date}&order=ASC&offset=0&limit=50`;
const PICK = { h: '主胜', d: '平', a: '客胜' };

async function fetchSnapshot(date) {
  let response;
  try {
    response = await fetch(UEFA_URL(date), { signal: AbortSignal.timeout(20000) });
  } catch (error) {
    throw new CliError(`UEFA 抓取失败：${error.message}`, 6);
  }
  if (!response.ok) throw new CliError(`UEFA 抓取失败：HTTP ${response.status}`, 6);
  const matches = await response.json();
  if (!Array.isArray(matches)) throw new CliError('UEFA 响应不是数组', 6);
  const slim = matches
    .filter((m) => m.kickOffTime?.date === date)
    .map((m) => ({
      uefaMatchId: m.id,
      kickoff: m.kickOffTime.dateTime,
      status: m.status,
      phase: m.round?.metaData?.name ?? null,
      home: { id: m.homeTeam.id, name: m.homeTeam.internationalName },
      away: { id: m.awayTeam.id, name: m.awayTeam.internationalName },
    }));
  return { source: UEFA_URL(date), fetchedAt: now(), date, matches: slim };
}

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['fetch', 'dry-run'], options: ['date', 'ledger'] });
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new CliError('需要 --date YYYY-MM-DD');
  const snapshotFile = path.join(SNAPSHOT_DIR, `${args.date}.json`);
  if (args.fetch) {
    const snapshot = await fetchSnapshot(args.date);
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`已保存 ${snapshot.matches.length} 场到 ${path.relative(process.cwd(), snapshotFile)}`);
    return;
  }
  if (!existsSync(snapshotFile)) throw new CliError(`没有快照 ${snapshotFile}，先加 --fetch`, 3);
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  const teamMap = JSON.parse(readFileSync(TEAM_MAP, 'utf8')).teams;
  const elo = loadEloLatest();
  const params = loadEloModel();
  const ledger = args.ledger ? path.resolve(args.ledger) : UCL_LEDGER;
  const entries = readLedger(ledger);
  const existing = new Map(foldLedger(entries).map((x) => [x.id, x]));
  const at = now();
  const additions = [];
  for (const m of snapshot.matches) {
    const label = `${m.kickoff} ${m.home.name} vs ${m.away.name}`;
    const names = [m.home, m.away].map((t) => teamMap[t.id]?.elo ?? null);
    if (names.includes(null)) {
      console.log(`  [不出预测] ${label}：Elo 快照里没有 ${[m.home, m.away].filter((_, i) => !names[i]).map((t) => t.name).join('、')}`);
      continue;
    }
    const ratings = names.map((n) => elo.get(n));
    const stale = ratings.map((r, i) => ({ r, n: names[i] })).filter(({ r }) => (Date.parse(m.kickoff) - Date.parse(`${r.date}T00:00:00Z`)) / 86400000 > MAX_ELO_AGE_DAYS);
    if (stale.length) {
      console.log(`  [不出预测] ${label}：Elo 过旧（${stale.map(({ n, r }) => `${n} ${r.date}`).join('、')}，上限 ${MAX_ELO_AGE_DAYS} 天）`);
      continue;
    }
    const id = `UCL|${m.kickoff.slice(0, 10)}|${names[0]}|${names[1]}`;
    if (existing.get(id)?.prediction) {
      console.log(`  [已预测] ${label} #${existing.get(id).prediction.seq}`);
      continue;
    }
    if (!(Date.parse(at) < Date.parse(m.kickoff))) {
      console.log(`  [已锁定] ${label}：已开赛`);
      continue;
    }
    const match = { id, league: 'UCL', kickoff: m.kickoff, home: names[0], away: names[1] };
    const pred = predictElo(params, ratings[0].elo, ratings[1].elo);
    additions.push(predictionEntry({ match, createdAt: at, mode: 'live', model: params.model, pred, market: null }));
    const p = pred.probs;
    const pick = ['h', 'd', 'a'].reduce((x, y) => (p[y] > p[x] ? y : x), 'h');
    console.log(`  [候选] ${label}  Elo ${ratings[0].elo.toFixed(0)} vs ${ratings[1].elo.toFixed(0)}  → ${PICK[pick]}  胜/平/负 ${(p.h * 100).toFixed(1)}/${(p.d * 100).toFixed(1)}/${(p.a * 100).toFixed(1)}%  λ ${pred.lam.home.toFixed(2)}/${pred.lam.away.toFixed(2)}`);
  }
  if (!additions.length) {
    console.log('没有新的候选预测。');
    return;
  }
  let sealed;
  try {
    sealed = precheckAppend(entries, additions);
  } catch (error) {
    if (error instanceof LiveError) throw new CliError(error.message, 5);
    throw error;
  }
  if (args['dry-run']) {
    console.log(`（dry-run：${sealed.length} 条未写入）`);
    return;
  }
  appendEntries(ledger, sealed.map(({ seq, prev, hash, ...rest }) => rest));
  console.log(`已追加 ${sealed.length} 条候选预测到 ${path.relative(process.cwd(), ledger)}`);
});
