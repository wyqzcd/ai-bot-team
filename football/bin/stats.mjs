#!/usr/bin/env node
/**
 * 复算口（一键重算任何登记过的命中率）。
 *
 *   node football/bin/stats.mjs --rule R-002            复算登记规则，并与登记值比对
 *   node football/bin/stats.mjs --all                   复算全部 active 规则
 *   node football/bin/stats.mjs --filter '{"from":"2024-07-01","minConf":0.56}' [--ledger <path>]
 *   node football/bin/stats.mjs --curve [--filter ...]  置信度-覆盖率曲线
 *   node football/bin/stats.mjs --review --filter '{"from":"2026-08-01"}'   赛后归因
 */
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { readLedger } from '../src/ledger.mjs';
import { computeStats, coverageCurve, review } from '../src/metrics.mjs';
import { RATE_TOLERANCE, checkRegistry, effectiveStatus, loadRegistry, recomputeRule } from '../src/rules.mjs';
import { CliError, parseArgs, run } from '../src/cli.mjs';

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['all', 'curve', 'review', 'details'], options: ['rule', 'filter', 'ledger', 'registry'] });
  if (args.rule || args.all) {
    const registry = loadRegistry(args.registry);
    const targets = args.all ? registry.rules.filter((r) => effectiveStatus(r) === 'active') : registry.rules.filter((r) => r.id === args.rule);
    if (!targets.length) throw new CliError(`登记表里没有规则 ${args.rule ?? '(active)'}`);
    let failed = false;
    for (const rule of targets) {
      const status = effectiveStatus(rule);
      if (status !== 'active') {
        console.log(JSON.stringify({ id: rule.id, status, note: '非 active 规则不复算结论', missing: checkRegistry({ rules: [rule] }).rules[0].missing }));
        continue;
      }
      const result = recomputeRule(rule);
      const match = result.n === rule.claim.n && Math.abs(result.rate - rule.claim.rate) <= RATE_TOLERANCE;
      if (!match) failed = true;
      console.log(JSON.stringify({ id: rule.id, metric: result.metric, claimed: rule.claim, recomputed: { rate: result.rate, n: result.n, coverage: result.coverage }, baselines: result.baselines, reproduced: match }));
    }
    if (failed) process.exit(1);
    return;
  }
  let filter = {};
  if (args.filter) {
    try {
      filter = JSON.parse(args.filter);
    } catch (error) {
      throw new CliError(`--filter 不是合法 JSON：${error.message}`);
    }
  }
  const entries = readLedger(args.ledger ? path.resolve(args.ledger) : PATHS.backtestLedger);
  if (args.curve) console.log(JSON.stringify(coverageCurve(entries, filter), null, 2));
  else if (args.review) {
    const result = review(entries, filter);
    if (!args.details) delete result.detail;
    console.log(JSON.stringify(result, null, 2));
  } else console.log(JSON.stringify(computeStats(entries, filter), null, 2));
});
