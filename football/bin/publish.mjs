#!/usr/bin/env node
/**
 * 发布：先跑全部机械门禁，任一失败 → 退出 1、不写任何文件。
 * 通过 → 写 football/reports/<YYYY-MM-DD>.html，并更新发布锚点 ledger/published.json
 * （记录每本台账已发布的条数与末条 hash；之后任何改写已发布前缀的行为都会被 G2 拦下）。
 *
 * 用法：node football/bin/publish.mjs [--dry-run] [--out <file.html>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { gateInputs } from '../src/pipeline.mjs';
import { runGates } from '../src/gates.mjs';
import { renderReport } from '../src/report.mjs';
import { MODEL_NAME, MODEL_VERSION } from '../src/walkforward.mjs';
import { now, parseArgs, run } from '../src/cli.mjs';

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['dry-run'], options: ['out'] });
  const generatedAt = now();
  const inputs = gateInputs({ now: generatedAt });
  const gates = runGates(inputs);
  const summary = { ok: gates.ok, failed: gates.gates.filter((g) => !g.ok).map((g) => `${g.id} ${g.name}: ${g.errors[0]}`) };
  if (!gates.ok) {
    console.error(JSON.stringify({ ...summary, note: '门禁未通过，阻断发布，未写任何文件' }, null, 2));
    process.exit(1);
  }
  const jczqRefs = existsSync(PATHS.jczqRefs) ? JSON.parse(readFileSync(PATHS.jczqRefs, 'utf8')) : {};
  const html = renderReport({ generatedAt, gates, registry: inputs.registry, ledgers: inputs.ledgers, model: `${MODEL_NAME}@${MODEL_VERSION}`, jczqRefs });
  const out = args.out ? path.resolve(args.out) : path.join(PATHS.reports, `${generatedAt.slice(0, 10)}.html`);
  const anchors = { publishedAt: generatedAt, report: path.relative(path.dirname(PATHS.anchors), out) };
  for (const l of inputs.ledgers) anchors[l.label] = { entries: l.entries.length, lastHash: l.entries.at(-1)?.hash ?? null };
  if (args['dry-run']) {
    console.log(JSON.stringify({ ...summary, dryRun: true, wouldWrite: out, anchors }, null, 2));
    return;
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
  writeFileSync(PATHS.anchors, `${JSON.stringify(anchors, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, wrote: [out, PATHS.anchors] }, null, 2));
});
