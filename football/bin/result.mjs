#!/usr/bin/env node
/**
 * 录入赛果（开赛后才允许；同场只能录一次）。
 * 用法：node football/bin/result.mjs --id "E0|2026-11-28|Arsenal|Chelsea" --ft 2-1 [--ht 1-0] --source "官方赛果"
 */
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { appendEntries, readLedger } from '../src/ledger.mjs';
import { LiveError, parseScore, planResult } from '../src/live.mjs';
import { CliError, now, parseArgs, run } from '../src/cli.mjs';

run(async () => {
  const args = parseArgs(process.argv.slice(2), { options: ['id', 'ft', 'ht', 'source', 'ledger'] });
  if (!args.id) throw new CliError('缺少 --id');
  const ledger = args.ledger ? path.resolve(args.ledger) : PATHS.liveLedger;
  try {
    const sealed = planResult({ liveEntries: readLedger(ledger), id: args.id, ft: parseScore(args.ft, '--ft'), ht: args.ht ? parseScore(args.ht, '--ht') : null, now: now(), source: args.source });
    appendEntries(ledger, sealed.map(({ seq, prev, hash, ...rest }) => rest));
    console.log(`已录赛果 #${sealed[0].seq} ${args.id} ${args.ft}`);
  } catch (error) {
    if (error instanceof LiveError) throw new CliError(error.message, 5);
    throw error;
  }
});
