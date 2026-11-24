#!/usr/bin/env node
/**
 * 两本回测台账的同口径对比（模型迭代的复算口）：
 * - 同一批已结算场次上的方向命中、对数损失、Brier、比分 TOP3；
 * - 等覆盖率对比：两版各取置信度最高的前 k 场，比较命中与档内平局率，并列出只被一版选中的场次；
 * - 对数损失的配对差及 z 值（逐场配对，差 = 新版 log p − 旧版 log p，正数表示新版更好）。
 *
 * 用法：node football/bin/compare.mjs --a ledger/backtest-v2.jsonl --b ledger/backtest-v3.jsonl [--from 2024-07-01] [--to YYYY-MM-DD]
 * 路径可以相对当前目录，也可以相对 football/ 目录。
 */
import { existsSync } from 'node:fs';
import { foldLedger, readLedger } from '../src/ledger.mjs';
import { computeStats, outcomeOf } from '../src/metrics.mjs';
import { CliError, parseArgs, resolveInput, run } from '../src/cli.mjs';

const COVERAGES = [0.2, 0.3, 0.35, 0.45];
const r4 = (x) => Math.round(x * 1e4) / 1e4;

run(async () => {
  const args = parseArgs(process.argv.slice(2), { options: ['a', 'b', 'from', 'to'] });
  if (!args.a || !args.b) throw new CliError('需要 --a <旧台账> --b <新台账>');
  const filter = { mode: 'backtest', ...(args.from && { from: args.from }), ...(args.to && { to: args.to }) };
  const load = (f) => {
    const file = resolveInput(f);
    if (!existsSync(file)) throw new CliError(`台账不存在：${f}`, 3);
    return readLedger(file);
  };
  const ledgers = { a: load(args.a), b: load(args.b) };
  const settled = (entries) => new Map(foldLedger(entries)
    .filter((x) => x.prediction && x.result && (!filter.from || x.prediction.kickoff.slice(0, 10) >= filter.from) && (!filter.to || x.prediction.kickoff.slice(0, 10) <= filter.to))
    .map((x) => [x.id, x]));
  const A = settled(ledgers.a);
  const B = settled(ledgers.b);
  const ids = [...A.keys()].filter((id) => B.has(id));
  if (ids.length !== A.size || ids.length !== B.size) throw new CliError(`两本台账的场次不一致（a=${A.size}, b=${B.size}, 共同=${ids.length}），不能同口径对比`, 5);

  const overall = Object.fromEntries(Object.entries(ledgers).map(([k, e]) => {
    const s = computeStats(e, filter);
    return [k, { n: s.n, direction: s.direction_hit.rate, logloss: s.logloss, brier: s.brier, score_top3: s.score_top3_hit.rate }];
  }));

  const diffs = ids.map((id) => {
    const idx = ['h', 'd', 'a'].indexOf(outcomeOf(A.get(id).result.ft));
    return Math.log(B.get(id).prediction.probs[idx]) - Math.log(A.get(id).prediction.probs[idx]);
  });
  const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / (diffs.length - 1));

  const ranked = (map) => [...map.values()]
    .map((x) => ({ id: x.id, conf: x.prediction.conf, hit: x.prediction.pick === outcomeOf(x.result.ft), draw: outcomeOf(x.result.ft) === 'd' }))
    .sort((p, q) => q.conf - p.conf || (p.id < q.id ? -1 : 1));
  const ra = ranked(A);
  const rb = ranked(B);
  const equalCoverage = COVERAGES.map((coverage) => {
    const k = Math.round(ids.length * coverage);
    const ta = ra.slice(0, k);
    const tb = rb.slice(0, k);
    const sa = new Set(ta.map((r) => r.id));
    const sb = new Set(tb.map((r) => r.id));
    const onlyA = ta.filter((r) => !sb.has(r.id));
    const onlyB = tb.filter((r) => !sa.has(r.id));
    const rate = (rows, key) => r4(rows.filter((r) => r[key]).length / rows.length);
    return {
      coverage, k,
      a: { direction: rate(ta, 'hit'), drawShare: rate(ta, 'draw') },
      b: { direction: rate(tb, 'hit'), drawShare: rate(tb, 'draw') },
      swapped: { onlyA: onlyA.length, onlyAHits: onlyA.filter((r) => r.hit).length, onlyB: onlyB.length, onlyBHits: onlyB.filter((r) => r.hit).length },
    };
  });

  console.log(JSON.stringify({
    a: args.a, b: args.b, filter, n: ids.length, overall,
    pairedLogGain: { mean: r4(mean), se: r4(sd / Math.sqrt(diffs.length)), z: Math.round((mean / (sd / Math.sqrt(diffs.length))) * 100) / 100 },
    equalCoverage,
  }, null, 2));
});
