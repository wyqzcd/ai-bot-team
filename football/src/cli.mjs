/** CLI 小工具：参数解析 + 统一的"可复现当前时间" + 统一的台账路径解析。 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FOOTBALL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 路径参数：先按当前目录解析，找不到再按 football/ 目录解析（两种写法都可以）。 */
export function resolveInput(p) {
  const fromCwd = path.resolve(p);
  if (existsSync(fromCwd)) return fromCwd;
  return path.resolve(FOOTBALL_DIR, p);
}
export function parseArgs(argv, { flags = [], options = [] } = {}) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const name = token.slice(2);
    if (flags.includes(name)) out[name] = true;
    else if (options.includes(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new CliError(`--${name} 需要一个值`);
      out[name] = value;
      index += 1;
    } else throw new CliError(`未知参数：${token}`);
  }
  return out;
}

export class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** FOOTBALL_NOW 覆盖当前时间（带时区 ISO），便于测试与复现。 */
export function now() {
  const override = process.env.FOOTBALL_NOW;
  if (override) {
    const parsed = Date.parse(override);
    if (Number.isNaN(parsed)) throw new CliError(`FOOTBALL_NOW 非法：${override}`);
    return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function run(main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`错误：${error.message}`);
      process.exit(error.exitCode);
    }
    console.error(error.stack ?? String(error));
    process.exit(1);
  }
}
