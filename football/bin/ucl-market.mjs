#!/usr/bin/env node
/**
 * 欧冠赔率对照：把竞彩欧冠场次的胜平负赔率记到 ledger/ucl-market.json，并打印模型与市场的差。
 * 网络抓取仍由 scripts/jczq-board.mjs --live 负责（竞彩官网只能在国内网络访问），本脚本只读本地文件。
 *
 * 用法（三选一输入，与 jczq.mjs 相同）：
 *   node football/bin/ucl-market.mjs --date 2026-12-09
 *   node football/bin/ucl-market.mjs --raw <官方接口响应.json>
 *   node football/bin/ucl-market.mjs --fixture <看板 fixture.json>
 * 选项：--check 只列映射状态不写文件；--dry-run 打印对照不写文件。
 * 先跑 ucl.mjs 出候选预测，再跑本脚本；必须在开赛前跑（开赛后抓的赔率一律拒绝）。
 * 退出码：0 成功；2 用法错误；3 输入文件不存在/非法；5 有未映射队名（--check）。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadBoardFixture } from '../src/board-input.mjs';
import { readLedger } from '../src/ledger.mjs';
import { uclLedgerFiles } from '../src/pipeline.mjs';
import { UCL_MARKET_FILE, addSnapshot, compare, loadUclTeamMap, readMarketFile, resolveUclMarket, uclPredictions } from '../src/ucl-market.mjs';
import { CliError, now, parseArgs, run } from '../src/cli.mjs';
import { existsSync } from 'node:fs';

const STATUS = { ready: '可记录', not_ucl: '非欧冠', unmapped: '未映射', no_prediction: '无候选预测', no_odds: '未开售胜平负', locked: '已开赛' };
const PICK = { h: '主胜', d: '平', a: '客胜' };
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const signed = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['check', 'dry-run'], options: ['date', 'raw', 'fixture'] });
  const at = now();
  const { source, fixture, capturedAt } = loadBoardFixture(args, at);
  const teamMap = loadUclTeamMap();
  const predictions = uclPredictions(uclLedgerFiles().filter((f) => existsSync(f)).map((f) => readLedger(f)));
  const rows = resolveUclMarket(fixture, teamMap, { predictions, capturedAt });
  const ucl = rows.filter((r) => r.status !== 'not_ucl');
  console.log(`输入：${path.relative(process.cwd(), source)}（欧冠 ${ucl.length} 场 / 共 ${rows.length} 场）  抓取时间：${capturedAt}`);
  for (const r of ucl) {
    console.log(`  [${STATUS[r.status]}] ${r.ref.no} ${r.ref.home} vs ${r.ref.away}${r.id ? `  → ${r.id}` : ''}${r.missing ? `  （未映射：${r.missing.join('、')}）` : ''}${r.reason ? `  （${r.reason}）` : ''}`);
  }
  const unmapped = [...new Set(ucl.filter((r) => r.status === 'unmapped').flatMap((r) => r.missing))];
  if (unmapped.length) console.log(`未映射队名（补到 football/data/jczq-ucl-teams.json；五大联赛球队补到 jczq-teams.json）：${unmapped.join('、')}`);
  if (args.check) {
    if (unmapped.length) process.exit(5);
    return;
  }
  const ready = ucl.filter((r) => r.status === 'ready');
  if (!ready.length) {
    console.log('没有可记录的赔率。');
    return;
  }
  let doc = readMarketFile(UCL_MARKET_FILE);
  let added = 0;
  for (const r of ready) {
    const c = compare(r.prediction, { market: r.market });
    console.log(`  ${r.ref.home} vs ${r.ref.away}  赔率 ${r.odds.join('/')}  市场 ${r.market.map(pct).join('/')}（热门 ${PICK[c.marketPick]}）  模型 ${r.prediction.probs.map(pct).join('/')}（${PICK[r.prediction.pick]}）  差 ${c.diff.map(signed).join('/')}${c.flagged ? '  【分歧大】' : ''}${c.agrees ? '' : '  【方向不同】'}`);
    const res = addSnapshot(doc, r, { capturedAt, oddsUpdatedAt: fixture.oddsUpdatedAt, source: path.basename(source) });
    doc = res.doc;
    if (res.added) added += 1;
  }
  if (args['dry-run']) {
    console.log(`（dry-run：${added} 条快照未写入）`);
    return;
  }
  if (added) writeFileSync(UCL_MARKET_FILE, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`已记录 ${added} 条赔率快照到 ${path.relative(process.cwd(), UCL_MARKET_FILE)}（赔率未变的场次不重复记）`);
});
