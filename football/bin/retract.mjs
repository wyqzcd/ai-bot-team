#!/usr/bin/env node
/**
 * 撤回一条预测（不删除原条目，追加 retraction 留痕）。
 * 开赛前撤回：该预测作废，不计入统计；开赛后撤回：只留痕，照样计入命中率。
 * 用法：node football/bin/retract.mjs --seq 12 --reason "<原因>"
 */
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { appendEntries, readLedger } from '../src/ledger.mjs';
import { LiveError, planRetraction } from '../src/live.mjs';
import { CliError, now, parseArgs, run } from '../src/cli.mjs';

run(async () => {
  const args = parseArgs(process.argv.slice(2), { options: ['seq', 'reason', 'ledger'] });
  const seq = Number(args.seq);
  if (!Number.isInteger(seq) || seq < 1) throw new CliError('--seq 必须是正整数');
  const ledger = args.ledger ? path.resolve(args.ledger) : PATHS.liveLedger;
  try {
    const sealed = planRetraction({ liveEntries: readLedger(ledger), seq, reason: args.reason, now: now() });
    appendEntries(ledger, sealed.map(({ seq: s, prev, hash, ...rest }) => rest));
    console.log(`已撤回 #${seq}（撤回条目 #${sealed[0].seq}）`);
  } catch (error) {
    if (error instanceof LiveError) throw new CliError(error.message, 5);
    throw error;
  }
});
