#!/usr/bin/env node
/**
 * 录入赛果（开赛后才允许；同场只能录一次）。
 * 用法：node football/bin/result.mjs --id "E0|2026-11-28|Arsenal|Chelsea" --ft 2-1 [--ht 1-0] --source "官方赛果"
 *       node football/bin/result.mjs --no 周六001 --ft 2-1 --source "竞彩官方赛果"   （按竞彩编号，须唯一对应一场未结算预测）
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveJczqNo } from '../src/jczq.mjs';
import { PATHS, refsFor } from '../src/config.mjs';
import { appendEntries, readLedger } from '../src/ledger.mjs';
import { LiveError, parseScore, planResult } from '../src/live.mjs';
import { CliError, now, parseArgs, run } from '../src/cli.mjs';

run(async () => {
  const args = parseArgs(process.argv.slice(2), { options: ['id', 'no', 'ft', 'ht', 'source', 'ledger'] });
  if (Boolean(args.id) === Boolean(args.no)) throw new CliError('必须且只能指定 --id 或 --no 之一');
  const ledger = args.ledger ? path.resolve(args.ledger) : PATHS.liveLedger;
  const liveEntries = readLedger(ledger);
  let id = args.id;
  if (args.no) {
    const refsFile = refsFor(ledger);
    const refs = existsSync(refsFile) ? JSON.parse(readFileSync(refsFile, 'utf8')) : {};
    try {
      id = resolveJczqNo(args.no, refs, liveEntries);
    } catch (error) {
      throw new CliError(error.message, 5);
    }
  }
  try {
    const sealed = planResult({ liveEntries, id, ft: parseScore(args.ft, '--ft'), ht: args.ht ? parseScore(args.ht, '--ht') : null, now: now(), source: args.source });
    appendEntries(ledger, sealed.map(({ seq, prev, hash, ...rest }) => rest));
    console.log(`已录赛果 #${sealed[0].seq} ${id} ${args.ft}`);
  } catch (error) {
    if (error instanceof LiveError) throw new CliError(error.message, 5);
    throw error;
  }
});
