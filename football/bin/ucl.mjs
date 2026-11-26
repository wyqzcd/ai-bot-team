#!/usr/bin/env node
/**
 * 欧战（候选）：UEFA 官方赛程 → Elo 泊松模型 → 候选台账（开赛即锁定）。
 *   --competition ucl（默认）欧冠 → ledger/ucl-candidate-v2.jsonl（R-017）
 *   --competition uel        欧联 → ledger/uel-candidate.jsonl（R-020）
 * 评分用 data/elo-current.csv（ClubElo 快照 + 五大联赛新比分推算，见 bin/elo-update.mjs）；该文件不存在时退回快照。
 *
 * 该模型只在五大联赛联赛内比赛上校准过，没有欧战样本可回测，所以这里的预测只是候选，
 * 不进入结论、不计入实盘规则 R-004（欧冠 v1 台账口径 R-014，v2 推算口径 R-017；欧联 R-020）。
 *
 * 用法：
 *   node football/bin/ucl.mjs [--competition uel] --fetch --date 2026-11-24   抓 UEFA 官方当天赛程，存 football/fixtures/<ucl|uel>/<date>.json（精简快照；已存在不覆盖，--refresh 强制重抓）
 *   node football/bin/ucl.mjs --date 2026-11-24 [--dry-run]   读快照，出预测并写候选台账
 *
 * 口径（出预测前固定）：
 * - 球队按 UEFA 球队编号查 data/uefa-teams.json（欧冠、欧联共用），再查 data/elo-current.csv；任一方查不到 → 不出预测。
 * - 任一方评分日期（推算到的最后一场比赛；五大联赛之外的球队就是快照日）早于开赛 MAX_ELO_AGE_DAYS 天 → 评分过旧，不出预测。
 * - 只预测未开赛（now < kickoff）且各版本候选台账里都还没有预测的场次（同一场不重复出）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { loadEloLatest, loadEloModel, predictElo } from '../src/elo.mjs';
import { loadEloCurrent, loadEloUpdate } from '../src/elo-update.mjs';
import { ledgerLabel } from '../src/pipeline.mjs';
import { loadRegistry } from '../src/rules.mjs';
import { abstainOf, currentAbstain } from '../src/tiers.mjs';
import { appendEntries, foldLedger, predictionEntry, readLedger } from '../src/ledger.mjs';
import { LiveError, precheckAppend } from '../src/live.mjs';
import { UEFA_MATCHES_URL, competitionOf, eloNames, loadUefaTeamMap, uclMatchId } from '../src/ucl.mjs';
import { CliError, now, parseArgs, run } from '../src/cli.mjs';

export const MAX_ELO_AGE_DAYS = 120;
const PICK = { h: '主胜', d: '平', a: '客胜' };

async function fetchSnapshot(date, comp) {
  const url = UEFA_MATCHES_URL(date, comp.uefaId);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20000) });
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
  return { source: url, fetchedAt: now(), date, matches: slim };
}

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['fetch', 'refresh', 'dry-run', 'skip-missing'], options: ['date', 'ledger', 'competition'] });
  const comp = competitionOf(args.competition ?? 'ucl');
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new CliError('需要 --date YYYY-MM-DD');
  const snapshotFile = path.join(comp.snapshotDir, `${args.date}.json`);
  if (args.fetch) {
    // 快照是出预测时的依据（赛前证据），已存在就不覆盖；确需重抓加 --refresh。
    if (existsSync(snapshotFile) && !args.refresh) {
      console.log(`${path.relative(process.cwd(), snapshotFile)} 已存在，保留原快照（重抓请加 --refresh）。`);
      return;
    }
    const snapshot = await fetchSnapshot(args.date, comp);
    if (!snapshot.matches.length) {
      console.log(`${args.date} 没有${comp.name}比赛，不写快照。`);
      return;
    }
    mkdirSync(comp.snapshotDir, { recursive: true });
    writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`已保存 ${snapshot.matches.length} 场到 ${path.relative(process.cwd(), snapshotFile)}`);
    return;
  }
  if (!existsSync(snapshotFile)) {
    if (args['skip-missing']) {
      console.log(`没有 ${args.date} 的快照，跳过。`);
      return;
    }
    throw new CliError(`没有快照 ${snapshotFile}，先加 --fetch`, 3);
  }
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  const teamMap = loadUefaTeamMap();
  const current = loadEloCurrent();
  const elo = current ?? loadEloLatest();
  const params = loadEloModel();
  const modelLabel = current ? `${params.model}+${loadEloUpdate().method}` : params.model;
  const ledger = args.ledger ? path.resolve(args.ledger) : comp.ledger;
  const entries = readLedger(ledger);
  const others = args.ledger ? [] : comp.ledgers.filter((f) => path.resolve(f) !== ledger && existsSync(f));
  const existing = new Map([...others.flatMap((f) => foldLedger(readLedger(f))), ...foldLedger(entries)].map((x) => [x.id, x]));
  const abstainRule = currentAbstain(loadRegistry(PATHS.registry), ledgerLabel(PATHS.eloBacktestLedger));
  const at = now();
  const additions = [];
  for (const m of snapshot.matches) {
    const label = `${m.kickoff} ${m.home.name} vs ${m.away.name}`;
    const names = eloNames(m, teamMap);
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
    const id = uclMatchId(m, names, comp.prefix);
    if (existing.get(id)?.prediction) {
      console.log(`  [已预测] ${label} #${existing.get(id).prediction.seq}`);
      continue;
    }
    if (!(Date.parse(at) < Date.parse(m.kickoff))) {
      console.log(`  [已锁定] ${label}：已开赛`);
      continue;
    }
    const match = { id, league: comp.prefix, kickoff: m.kickoff, home: names[0], away: names[1] };
    const pred = predictElo(params, ratings[0].elo, ratings[1].elo);
    additions.push(predictionEntry({ match, createdAt: at, mode: 'live', model: modelLabel, pred, market: null }));
    const p = pred.probs;
    const pick = ['h', 'd', 'a'].reduce((x, y) => (p[y] > p[x] ? y : x), 'h');
    const abstain = abstainOf([p.h, p.d, p.a].map((x) => Math.round(x * 1e4) / 1e4), abstainRule); // 与台账里四舍五入后的概率同口径
    const call = abstain ? `不下判断（概率差 ${abstain.margin.toFixed(3)} < ${abstainRule.sample.filter.maxMargin}，${abstainRule.id}；台账照记${PICK[pick]}）` : PICK[pick];
    console.log(`  [候选] ${label}  Elo ${ratings[0].elo.toFixed(0)}${ratings[0].basis === 'propagated' ? '*' : ''} vs ${ratings[1].elo.toFixed(0)}${ratings[1].basis === 'propagated' ? '*' : ''}  → ${call}  胜/平/负 ${(p.h * 100).toFixed(1)}/${(p.d * 100).toFixed(1)}/${(p.a * 100).toFixed(1)}%  λ ${pred.lam.home.toFixed(2)}/${pred.lam.away.toFixed(2)}`);
  }
  if (current) console.log('  （* = 已用五大联赛新比分推算；无 * 的是 ClubElo 快照原值）');
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
