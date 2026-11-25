/** 竞彩看板输入（三选一）：--date（找 fixtures/<date>.live-raw.json 或 fixtures/<date>.json）/ --raw / --fixture。jczq.mjs 与 ucl-market.mjs 共用。 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mapLiveResponse } from '../../scripts/jczq-board.mjs';
import { PATHS } from './config.mjs';
import { CliError } from './cli.mjs';

function readJson(file) {
  if (!existsSync(file)) throw new CliError(`文件不存在：${file}`, 3);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`JSON 非法：${file}（${error.message}）`, 3);
  }
}

/** @returns {{ source, fixture, capturedAt }} capturedAt：官方响应按读取时刻，看板 fixture 用其自带的 capturedAt */
export function loadBoardFixture(args, at, fixturesDir = PATHS.jczqFixtures) {
  const inputs = ['date', 'raw', 'fixture'].filter((k) => args[k]);
  if (inputs.length !== 1) throw new CliError('必须且只能指定 --date / --raw / --fixture 之一');
  let rawFile = args.raw ? path.resolve(args.raw) : null;
  let fixtureFile = args.fixture ? path.resolve(args.fixture) : null;
  if (args.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new CliError('--date 必须是 YYYY-MM-DD');
    const raw = path.join(fixturesDir, `${args.date}.live-raw.json`);
    const fixture = path.join(fixturesDir, `${args.date}.json`);
    if (existsSync(raw)) rawFile = raw;
    else if (existsSync(fixture)) fixtureFile = fixture;
    else throw new CliError(`找不到 ${raw} 或 ${fixture}；先在能访问竞彩官网的机器上跑 node scripts/jczq-board.mjs --live`, 3);
  }
  if (rawFile) {
    try {
      const fixture = mapLiveResponse(readJson(rawFile), { capturedAt: at, source: rawFile });
      return { source: rawFile, fixture, capturedAt: fixture.capturedAt ?? at };
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(`官方响应解析失败：${error.message}`, 3);
    }
  }
  const fixture = readJson(fixtureFile);
  return { source: fixtureFile, fixture, capturedAt: fixture.capturedAt ?? at };
}
