#!/usr/bin/env node
/**
 * 例行数据 PR 自动合并资格检查（零依赖，CI 与本地通用）。
 *
 * 只回答一个问题：这个分支相对 base（默认 origin/main）的改动，是不是"只追加数据、不改写历史"的例行数据改动？
 *   1. 放权配置只读 base 上的 config/trust.json（PR 改不了自己的放权规则）；routineData.enabled 必须为 true。
 *   2. 改动的每个文件都必须落在 base 配置的 routineData.paths 白名单内（代码、工作流、登记表、对照表一律不在内）。
 *   3. base 上每本台账 football/ledger/*.jsonl：本分支版本必须以 base 版本的全部字节为前缀（只追加、不改写、不删除）。
 *   4. 发布锚点 published.json：base 里记录的每本台账，条数不得减少；登记表锚点必须与 base 完全一致。
 * 测试、8 道门禁、复现验证由工作流在调用本脚本之前单独跑，本脚本不重复。
 *
 * 用法（在仓库根目录执行）：node scripts/routine-merge-check.mjs [--base origin/main] [--json]
 * CI 中必须运行 base 分支上的版本：git show origin/main:scripts/routine-merge-check.mjs > $RUNNER_TEMP/rmc.mjs
 * 退出码：0 有资格；3 无资格（原因见输出）；1 内部错误。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根 = 当前目录：CI 会把 base 分支上的本脚本拷到临时目录再运行（防止 PR 改脚本给自己放行）。
const REPO = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: REPO, maxBuffer: 1 << 30 });
const gitText = (...args) => git(...args).toString('utf8');

function showAtBase(base, file) {
  try {
    return git('show', `${base}:${file}`);
  } catch {
    return null;
  }
}

export function inAllowlist(file, paths) {
  return paths.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

/** 纯函数：给定 base 配置、改动文件、台账前后内容、锚点前后，判断资格。便于单测。 */
export function evaluate({ config, changed, ledgers, anchors }) {
  const reasons = [];
  const routine = config?.routineData;
  if (!routine?.enabled) reasons.push('base 的 config/trust.json 未开启 routineData.enabled');
  const paths = Array.isArray(routine?.paths) ? routine.paths : [];
  if (changed.length === 0) reasons.push('没有任何改动');
  for (const file of changed) if (!inAllowlist(file, paths)) reasons.push(`改动不在例行数据白名单内：${file}`);
  for (const { file, base, head } of ledgers) {
    if (head === null) reasons.push(`台账被删除：${file}`);
    else if (head.length < base.length || !head.subarray(0, base.length).equals(base)) reasons.push(`台账不是在 base 基础上只追加（已有内容被改写）：${file}`);
  }
  if (anchors.base) {
    if (!anchors.head) reasons.push('发布锚点 published.json 被删除');
    else {
      for (const [label, value] of Object.entries(anchors.base)) {
        if (!value || typeof value !== 'object' || !('entries' in value)) continue;
        const now = anchors.head[label];
        if (!now || !(now.entries >= value.entries)) reasons.push(`发布锚点 ${label} 的条数减少或丢失`);
      }
      if (JSON.stringify(anchors.base.registry ?? null) !== JSON.stringify(anchors.head.registry ?? null)) {
        reasons.push('发布锚点里的登记表锚点被改动（例行数据 PR 不得改规则）');
      }
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf('--base');
  const base = baseIndex === -1 ? 'origin/main' : args[baseIndex + 1];
  const configRaw = showAtBase(base, 'config/trust.json');
  const config = configRaw ? JSON.parse(configRaw.toString('utf8')) : null;
  const mergeBase = gitText('merge-base', base, 'HEAD').trim();
  // 只看已提交的内容（HEAD）：CI 工作目录里会有 result.json、trust-base.json 等未提交的临时文件，不能算作改动
  const changed = gitText('diff', '--name-only', mergeBase, 'HEAD').split('\n').filter(Boolean);

  const baseLedgers = gitText('ls-tree', '-r', '--name-only', base, '--', 'football/ledger/').split('\n').filter((f) => f.endsWith('.jsonl'));
  const ledgers = baseLedgers.map((file) => ({ file, base: showAtBase(base, file), head: showAtBase('HEAD', file) }));
  const anchorFile = 'football/ledger/published.json';
  const baseAnchor = showAtBase(base, anchorFile);
  const headAnchor = showAtBase('HEAD', anchorFile);
  const anchors = {
    base: baseAnchor ? JSON.parse(baseAnchor.toString('utf8')) : null,
    head: headAnchor ? JSON.parse(headAnchor.toString('utf8')) : null,
  };
  const result = { base, changed, ...evaluate({ config, changed, ledgers, anchors }) };
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.eligible ? '例行数据 PR：有资格自动合并' : '例行数据 PR：无资格自动合并');
    for (const r of result.reasons) console.log(`  - ${r}`);
  }
  process.exit(result.eligible ? 0 : 3);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exit(1);
  }
}
