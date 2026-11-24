#!/usr/bin/env node
/**
 * 赛前预测，追加到实盘台账（开赛即锁定）。
 *
 * 用法：node football/bin/predict.mjs --fixtures <file.json> [--replace --reason "<理由>"] [--allow-unknown] [--dry-run]
 * fixtures 文件：{ "matches": [ { "league": "E0", "kickoff": "2026-11-28T23:00:00+08:00",
 *                  "home": "Arsenal", "away": "Chelsea", "odds": [2.1, 3.4, 3.5] } ] }
 * odds 可省略；它只作为赛后对照基线，不进模型。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { loadDataset } from '../src/dataset.mjs';
import { appendEntries, readLedger } from '../src/ledger.mjs';
import { LiveError, planPredictions } from '../src/live.mjs';
import { CliError, now, parseArgs, run } from '../src/cli.mjs';

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['replace', 'allow-unknown', 'dry-run'], options: ['fixtures', 'reason', 'ledger'] });
  if (!args.fixtures) throw new CliError('缺少 --fixtures <file.json>');
  const ledger = args.ledger ? path.resolve(args.ledger) : PATHS.liveLedger;
  let doc;
  try {
    doc = JSON.parse(readFileSync(path.resolve(args.fixtures), 'utf8'));
  } catch (error) {
    throw new CliError(`读取 fixtures 失败：${error.message}`, 3);
  }
  try {
    const entries = readLedger(ledger);
    const sealed = planPredictions({ fixtures: doc.matches, dataset: loadDataset(), liveEntries: entries, now: now(), replace: Boolean(args.replace), reason: args.reason, allowUnknown: Boolean(args['allow-unknown']) });
    if (!args['dry-run']) appendEntries(ledger, sealed.map(({ seq, prev, hash, ...rest }) => rest));
    for (const e of sealed) {
      if (e.type === 'retraction') console.log(`撤回 #${e.target}  ${e.reason}`);
      else console.log(`${e.id}  pick=${e.pick} conf=${e.conf}  probs=${e.probs.join('/')}  λ=${e.lam.join('/')}  TOP3=${e.top3.map((s) => s[0]).join(',')}`);
    }
    console.log(args['dry-run'] ? '（dry-run：未写入台账）' : `已追加 ${sealed.length} 条到 ${path.relative(process.cwd(), ledger)}`);
  } catch (error) {
    if (error instanceof LiveError) throw new CliError(error.message, 5);
    throw error;
  }
});
