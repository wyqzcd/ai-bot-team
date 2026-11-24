#!/usr/bin/env node
/**
 * 跑全部机械门禁（G1~G7）。全部通过退出 0；任一 ERROR 退出 1。
 * 用法：node football/bin/gates.mjs [--json]
 */
import { runAllGates } from '../src/pipeline.mjs';
import { now, parseArgs, run } from '../src/cli.mjs';

run(async () => {
  const args = parseArgs(process.argv.slice(2), { flags: ['json'] });
  const report = runAllGates({ now: now() });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const g of report.gates) {
      console.log(`${g.ok ? 'PASS' : 'FAIL'} ${g.id} ${g.name}${g.ok ? '' : `（${g.errorCount} 个错误）`}`);
      for (const e of g.errors) console.log(`    ERROR ${e}`);
      for (const w of g.warnings) console.log(`    WARN  ${w}`);
    }
    console.log(report.ok ? '门禁全部通过' : '门禁未通过：阻断发布');
  }
  if (!report.ok) process.exit(1);
});
