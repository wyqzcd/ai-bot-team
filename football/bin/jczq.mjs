#!/usr/bin/env node
/**
 * 竞彩场次 → 实盘预测（开赛即锁定）。网络抓取仍由 scripts/jczq-board.mjs --live 负责，本脚本只读本地文件。
 *
 * 用法（三选一输入）：
 *   node football/bin/jczq.mjs --date 2026-11-29          依次找 fixtures/<date>.live-raw.json、fixtures/<date>.json
 *   node football/bin/jczq.mjs --raw <官方接口响应.json>
 *   node football/bin/jczq.mjs --fixture <看板 fixture.json>
 * 选项：
 *   --check           只列出每场映射状态，不写台账
 *   --dry-run         算出预测并打印，不写台账
 *   --skip-unmapped   有未映射队名时仍为已映射场次出预测（默认：有未映射就整批拒绝）
 *   --ledger <path>   实盘台账（默认 football/ledger/live.jsonl）
 * 退出码：0 成功；2 用法错误；3 输入文件不存在/非法；5 未映射或预检失败。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadBoardFixture } from '../src/board-input.mjs';
import path from 'node:path';
import { PATHS, refsFor } from '../src/config.mjs';
import { loadDataset } from '../src/dataset.mjs';
import { datasetTeamSets, loadTeamMap, resolveJczq, summarize } from '../src/jczq.mjs';
import { loadRegistry } from '../src/rules.mjs';
import { abstainOf, currentAbstain, currentTiers, tierOf } from '../src/tiers.mjs';
import { ledgerLabel } from '../src/pipeline.mjs';
import { appendEntries, readLedger } from '../src/ledger.mjs';
import { LiveError, planPredictions } from '../src/live.mjs';
import { CliError, now, parseArgs, run } from '../src/cli.mjs';

const STATUS_LABEL = { ready: '待预测', not_covered: '未建模', unmapped: '未映射', locked: '已锁定', already: '已预测', settled: '已结算' };
const PICK = { h: '主胜', d: '平', a: '客胜' };

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['check', 'dry-run', 'skip-unmapped'], options: ['date', 'raw', 'fixture', 'ledger'] });
  const at = now();
  const { source, fixture } = loadBoardFixture(args, at);
  const ledger = args.ledger ? path.resolve(args.ledger) : PATHS.liveLedger;
  const dataset = loadDataset();
  const teamMap = loadTeamMap(undefined, datasetTeamSets(dataset));
  const liveEntries = readLedger(ledger);
  const rows = resolveJczq(fixture, teamMap, { liveEntries, now: at });

  console.log(`输入：${path.relative(process.cwd(), source)}（${rows.length} 场）  当前时间：${at}`);
  for (const row of rows) {
    const r = row.ref;
    console.log(`  [${STATUS_LABEL[row.status]}] ${r.no} ${r.league} ${r.home} vs ${r.away}${row.id ? `  → ${row.id}` : ''}${row.reason ? `  （${row.reason}）` : ''}`);
  }
  const counts = summarize(rows);
  console.log(`汇总：${Object.entries(counts).map(([k, v]) => `${STATUS_LABEL[k]} ${v}`).join('，')}`);

  const unmapped = rows.filter((r) => r.status === 'unmapped');
  if (unmapped.length) {
    const names = [...new Set(unmapped.flatMap((r) => r.missing.map((n) => `${r.league}:${n}`)))];
    console.log(`未映射队名（补到 football/data/jczq-teams.json 后重跑）：${names.join('、')}`);
  }
  if (args.check) {
    if (unmapped.length) process.exit(5);
    return;
  }
  if (unmapped.length && !args['skip-unmapped']) throw new CliError('存在未映射队名，整批拒绝（确认后可加 --skip-unmapped 只预测已映射场次）', 5);

  const ready = rows.filter((r) => r.status === 'ready');
  if (!ready.length) {
    console.log('没有需要新出预测的场次。');
    return;
  }
  let sealed;
  try {
    sealed = planPredictions({ fixtures: ready.map((r) => r.fixture), dataset, liveEntries, now: at });
  } catch (error) {
    if (error instanceof LiveError) throw new CliError(error.message, 5);
    throw error;
  }
  const refById = new Map(ready.map((r) => [r.id, r.ref]));
  const registry = loadRegistry(PATHS.registry);
  const tiers = currentTiers(registry, ledgerLabel(PATHS.backtestLedger));
  const abstainRule = currentAbstain(registry, ledgerLabel(PATHS.backtestLedger));
  for (const e of sealed) {
    const ref = refById.get(e.id);
    const tier = tierOf(e.conf, tiers);
    const abstain = abstainOf(e.probs, abstainRule);
    const call = abstain ? `不下判断（概率差 ${abstain.margin.toFixed(3)} < ${abstainRule.sample.filter.maxMargin}，${abstainRule.id}；台账照记 ${PICK[e.pick]}）` : PICK[e.pick];
    console.log(`  ${ref.no} ${ref.home} vs ${ref.away}  ${call} conf=${e.conf}${tier ? `  【${tier.label}档 ${tier.rule.id}】` : ''}  胜/平/负=${e.probs.join('/')}  TOP3=${e.top3.map((s) => s[0]).join(',')}`);
  }
  if (args['dry-run']) {
    console.log('（dry-run：未写入台账）');
    return;
  }
  appendEntries(ledger, sealed.map(({ seq, prev, hash, ...rest }) => rest));
  const refsFile = refsFor(ledger);
  const refs = existsSync(refsFile) ? JSON.parse(readFileSync(refsFile, 'utf8')) : {};
  for (const e of sealed) refs[e.id] ??= refById.get(e.id);
  writeFileSync(refsFile, `${JSON.stringify(refs, null, 2)}\n`);
  console.log(`已追加 ${sealed.length} 条预测到 ${path.relative(process.cwd(), ledger)}`);
});
