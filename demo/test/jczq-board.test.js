import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EPS,
  HIGH_CONFIDENCE_THRESHOLD,
  LIVE_HEADERS,
  REPO_ROOT,
  BoardError,
  devig,
  describeHandicap,
  classifyMatch,
  findLikelyDraw,
  analyzeFixture,
  renderHtml,
  formatPlus08,
  parseArgs,
  validateFixture,
  mapLiveResponse,
} from '../../scripts/jczq-board.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/jczq-board.mjs', import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/2026-11-15.json', import.meta.url));
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const LIVE_RAW_PATH = fileURLToPath(new URL('../../fixtures/2026-11-15.live-raw.json', import.meta.url));
const LIVE_RAW = JSON.parse(readFileSync(LIVE_RAW_PATH, 'utf8'));
const NOW = '2026-11-15T09:30:00+08:00';

const LOSE_COVER_EMPTY_NOTE =
  '整数一球盘下，输 1 球为走盘（让球平），受让方输球不可能赢盘；真正的「输球赢盘」需要半盘。本批无半盘，该组恒为空，未硬凑场次、未虚构半盘。';

function cloneFixture() {
  return JSON.parse(JSON.stringify(FIXTURE));
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
  });
}

const SUMMARY_KEYS = ['oddsUpdatedAt', 'totalCount', 'matches', 'unclassified', 'skipped', 'groups', 'likelyDraw'];
const GROUP_KEYS = ['win_cover', 'win_no_cover', 'lose_cover', 'lose_no_cover', 'other'];

/** 目录内所有普通文件的 md5 与 mtime，用于断言「没有文件被写」。 */
function snapshotDir(dir) {
  const snapshot = {};
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = statSync(file);
    if (!stat.isFile()) continue;
    snapshot[name] = {
      md5: createHash('md5').update(readFileSync(file)).digest('hex'),
      mtimeMs: stat.mtimeMs,
    };
  }
  return snapshot;
}

/** 断言 stdout 恰好一行 JSON + 换行，返回解析结果。 */
function parseSingleLineJson(stdout) {
  assert.ok(stdout.endsWith('\n'), 'stdout 必须以换行结尾');
  const lines = stdout.split('\n');
  assert.equal(lines.length, 2, `stdout 必须恰好一行，实际 ${lines.length - 1} 行`);
  assert.equal(lines[1], '');
  return JSON.parse(lines[0]);
}

/** 独立于 mapLiveResponse 从官方原文推导已开售场次构成。 */
function liveExpectedCounts(raw) {
  const selling = [];
  let skipped = 0;
  for (const group of raw.value.matchInfoList) {
    for (const sub of group.subMatchList) {
      const hidden = (sub.matchStatus !== undefined && sub.matchStatus !== 'Selling') || sub.isHide === 1 || sub.isHide === true;
      if (hidden) skipped += 1;
      else selling.push(sub);
    }
  }
  const completeMarket = (market) =>
    market !== undefined &&
    market !== null &&
    ['h', 'd', 'a'].every((key) => market[key] !== undefined && market[key] !== null && String(market[key]).trim() !== '');
  const matches = selling.filter((sub) => completeMarket(sub.had) && completeMarket(sub.hhad)).length;
  return {
    totalCount: raw.value.totalCount,
    matches,
    unclassified: selling.length - matches,
    skipped,
  };
}

function approx(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} 与 ${expected} 差值超过 ${tolerance}`);
}

function syntheticMatch(overrides = {}) {
  return {
    no: '周日099',
    league: '测试联赛',
    kickoff: '2026-11-15T13:00:00+08:00',
    home: '主队',
    away: '客队',
    handicap: -1,
    spf: [1.6, 3.8, 5.0],
    rqspf: [2.0, 3.3, 3.6],
    ...overrides,
  };
}

function tempFixture(t, payload) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jczq-board-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.json');
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  return file;
}

function liveSub(overrides = {}) {
  return {
    matchStatus: 'Selling',
    isHide: 0,
    matchNumStr: '周日001',
    leagueAbbName: '测试联赛',
    homeTeamAbbName: '主队A',
    awayTeamAbbName: '客队B',
    matchDate: '2026-11-15',
    matchTime: '13:00:00',
    had: { h: '2.00', d: '3.30', a: '3.60' },
    hhad: { h: '1.90', d: '3.40', a: '3.80', goalLine: '-1' },
    ...overrides,
  };
}

function liveRaw(subs, { totalCount = subs.length, lastUpdateTime = '2026-11-15 12:28:41' } = {}) {
  return {
    success: true,
    value: {
      lastUpdateTime,
      totalCount,
      matchInfoList: [{ businessDate: '2026-11-15', subMatchList: subs }],
    },
  };
}

function syntheticLiveFixture() {
  return mapLiveResponse(
    liveRaw([
      liveSub(),
      liveSub({
        matchNumStr: '周日002',
        homeTeamAbbName: '主队C',
        awayTeamAbbName: '客队D',
        matchTime: '15:00:00',
        had: { h: '1.80', d: '3.50', a: '4.00' },
        hhad: { h: '2.10', d: '3.30', a: '3.10', goalLine: '+1' },
      }),
      liveSub({
        matchNumStr: '周日008',
        leagueAbbName: '欧国联',
        homeTeamAbbName: '芬兰',
        awayTeamAbbName: '圣马力诺',
        matchDate: '2026-11-16',
        matchTime: '01:00:00',
        had: {},
        hhad: { h: '2.47', d: '4.62', a: '1.93', goalLine: '-4' },
      }),
    ]),
    { capturedAt: NOW },
  );
}

test('常量导出符合口径', () => {
  assert.equal(EPS, 1e-9);
  assert.equal(HIGH_CONFIDENCE_THRESHOLD, 0.6);
  const expectedRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  assert.equal(REPO_ROOT, expectedRoot);
});

test('devig 对真实赔率向量归一化，且每个市场各自求和为 1', () => {
  const spf = devig(FIXTURE.matches[0].spf);
  approx(spf[0], 0.378689);
  approx(spf[1], 0.283405);
  approx(spf[2], 0.337906);
  approx(spf.reduce((a, b) => a + b, 0), 1, 1e-12);

  const rqspf = devig(FIXTURE.matches[0].rqspf);
  approx(rqspf[0], 0.158161);
  approx(rqspf[1], 0.227998);
  approx(rqspf[2], 0.613841);
  approx(rqspf.reduce((a, b) => a + b, 0), 1, 1e-12);
});

test('devig 只对非 null 项归一化并保留 null', () => {
  const p = devig([2, null, 2]);
  assert.equal(p[1], null);
  approx(p[0], 0.5, 1e-12);
  approx(p[2], 0.5, 1e-12);
  approx(p[0] + p[2], 1, 1e-12);
});

test('devig 对非法输入抛 RangeError', () => {
  for (const bad of [[], [1], [0.9], [0], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], [1.5, 'x']]) {
    assert.throws(() => devig(bad), RangeError, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('describeHandicap 判定让球方与盘口类型', () => {
  assert.equal(describeHandicap(-1).side, 'home');
  assert.equal(describeHandicap(-1).isInteger, true);
  assert.equal(describeHandicap(1).side, 'away');
  assert.equal(describeHandicap(1).isInteger, true);
  assert.equal(describeHandicap(0).side, null);
  const halfHome = describeHandicap(-1.5);
  assert.equal(halfHome.side, 'home');
  assert.equal(halfHome.isInteger, false);
  assert.equal(halfHome.goals, 1.5);
  const halfAway = describeHandicap(1.5);
  assert.equal(halfAway.side, 'away');
  assert.equal(halfAway.isInteger, false);
});

test('describeHandicap 拒绝非 0.5 倍数与越界值', () => {
  for (const bad of [1.25, 0.3, 5.5, -5.5, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
    assert.throws(() => describeHandicap(bad), RangeError, `应拒绝 ${String(bad)}`);
  }
});

test('validateFixture 接受快照数据并返回 true', () => {
  assert.equal(validateFixture(cloneFixture()), true);
});

test('validateFixture 拒绝整数 |h|>=2（口径未定义）', () => {
  const bad = cloneFixture();
  bad.matches[0].handicap = -2;
  assert.throws(
    () => validateFixture(bad),
    (err) => err instanceof BoardError && err.code === 'E_FIXTURE_SCHEMA' && err.message.includes('handicap'),
  );
});

test('validateFixture 报错含场次 no 与字段名', () => {
  const bad = cloneFixture();
  bad.matches[0].spf = [2.32, 0.9, 2.6];
  assert.throws(
    () => validateFixture(bad),
    (err) =>
      err instanceof BoardError &&
      err.code === 'E_FIXTURE_SCHEMA' &&
      err.message.includes('周日001') &&
      err.message.includes('spf'),
  );
});

test('validateFixture 拒绝赔率长度与 non-finite 值', () => {
  const short = cloneFixture();
  short.matches[0].rqspf = [1.43, 3.85];
  assert.throws(() => validateFixture(short), (err) => err.code === 'E_FIXTURE_SCHEMA' && err.message.includes('rqspf'));

  const inf = cloneFixture();
  inf.matches[1].spf[2] = Number.POSITIVE_INFINITY;
  assert.throws(() => validateFixture(inf), (err) => err.code === 'E_FIXTURE_SCHEMA' && err.message.includes('周日002'));
});

test('validateFixture 拒绝重复编号、缺字段、日期不一致与 support 长度错误', () => {
  const dup = cloneFixture();
  dup.matches[1].no = dup.matches[0].no;
  assert.throws(() => validateFixture(dup), (err) => err.code === 'E_FIXTURE_SCHEMA' && err.message.includes('重复'));

  const missing = cloneFixture();
  delete missing.note;
  assert.throws(() => validateFixture(missing), (err) => err.code === 'E_FIXTURE_SCHEMA' && err.message.includes('note'));

  assert.throws(
    () => validateFixture(cloneFixture(), { date: '2026-11-16' }),
    (err) => err.code === 'E_FIXTURE_SCHEMA' && err.message.includes('date'),
  );

  const badSupport = cloneFixture();
  badSupport.matches[0].support.spf = [55, 29];
  assert.throws(
    () => validateFixture(badSupport),
    (err) => err.code === 'E_FIXTURE_SCHEMA' && err.message.includes('support.spf'),
  );
});

test('五场真实数据的去水概率、分组与高置信与 oracle 一致', () => {
  const oracle = {
    周日001: {
      spf: [0.378689, 0.283405, 0.337906],
      rqspf: [0.158161, 0.227998, 0.613841],
      group: 'win_no_cover',
      high: { market: 'RQSPF', outcome: '让球客胜', probability: 0.613841 },
    },
    周日002: {
      spf: [0.552338, 0.228108, 0.219554],
      rqspf: [0.298547, 0.258155, 0.443297],
      group: 'win_cover',
      high: null,
    },
    周日003: {
      spf: [0.358566, 0.250996, 0.390438],
      rqspf: [0.601523, 0.21162, 0.186856],
      group: 'win_no_cover',
      high: { market: 'RQSPF', outcome: '让球主胜', probability: 0.601523 },
    },
    周日004: {
      spf: [0.471662, 0.233944, 0.294393],
      rqspf: [0.246555, 0.230983, 0.522462],
      group: 'win_cover',
      high: null,
    },
    周日005: {
      spf: [0.302551, 0.254318, 0.44313],
      rqspf: [0.542043, 0.237327, 0.22063],
      group: 'win_no_cover',
      high: null,
    },
  };

  const analyses = FIXTURE.matches.map(classifyMatch);
  assert.equal(analyses.length, 5);
  for (const analysis of analyses) {
    const expected = oracle[analysis.no];
    assert.ok(expected, `缺少 ${analysis.no} 的 oracle`);
    for (let i = 0; i < 3; i += 1) {
      approx(analysis.spf[i], expected.spf[i]);
      approx(analysis.rqspf[i], expected.rqspf[i]);
    }
    assert.equal(analysis.group, expected.group, `${analysis.no} 分组不符`);
    if (expected.high === null) {
      assert.equal(analysis.highConfidence, null, `${analysis.no} 不应高置信`);
    } else {
      assert.ok(analysis.highConfidence, `${analysis.no} 应为高置信`);
      assert.equal(analysis.highConfidence.market, expected.high.market);
      assert.equal(analysis.highConfidence.outcome, expected.high.outcome);
      approx(analysis.highConfidence.probability, expected.high.probability);
    }
  }
});

test('findLikelyDraw 取 SPF 平局去水最大者，并列按 fixture 顺序全列', () => {
  const likely = findLikelyDraw(FIXTURE.matches.map(classifyMatch));
  assert.deepEqual(likely.matches.map((m) => m.no), ['周日001']);
  approx(likely.probability, 0.283405);

  const tied = findLikelyDraw([
    { no: 'A', spf: [0.4, 0.3, 0.3] },
    { no: 'B', spf: [0.3, 0.3, 0.4] },
    { no: 'C', spf: [0.5, 0.2, 0.3] },
  ]);
  assert.deepEqual(tied.matches.map((m) => m.no), ['A', 'B']);
  approx(tied.probability, 0.3);
});

test('SPF 最大项并列时 ambiguous（h=0 优先判无让球）', () => {
  const tied = classifyMatch(syntheticMatch({ spf: [2, 2, 3], rqspf: [2, 3, 4] }));
  assert.equal(tied.group, 'ambiguous');
  assert.equal(tied.spfTop.indices.length, 2);

  const noHandicap = classifyMatch(syntheticMatch({ handicap: 0, spf: [2, 2, 3], rqspf: [2, 3, 4] }));
  assert.equal(noHandicap.group, 'no_handicap');
});

test('整数盘不变式：无论让球方向都不产生 lose_cover', () => {
  const combos = [
    [1.5, 4, 6],
    [6, 4, 1.5],
    [2, 3, 4],
    [4, 3, 2],
    [3, 3, 3],
  ];
  for (const handicap of [-1, 1]) {
    for (const rqspf of combos) {
      const match = syntheticMatch({
        handicap,
        spf: handicap < 0 ? [1.6, 3.8, 5] : [5, 3.8, 1.6],
        rqspf,
      });
      const analysis = classifyMatch(match);
      assert.notEqual(analysis.group, 'lose_cover', `h=${handicap} rqspf=${rqspf} 不应为输球赢盘`);
    }
  }
});

test('半盘：受让方概率高则输球赢盘，且绝不产生 win_no_cover', () => {
  const lose = classifyMatch(syntheticMatch({ handicap: -1.5, rqspf: [6, 4, 1.5] }));
  assert.equal(lose.group, 'lose_cover');
  assert.match(lose.reason, /受让方/);

  const win = classifyMatch(syntheticMatch({ handicap: -1.5, rqspf: [1.5, 4, 6] }));
  assert.equal(win.group, 'win_cover');

  for (const handicap of [-1.5, 1.5]) {
    for (const rqspf of [[1.5, 4, 6], [6, 4, 1.5], [2, 3, 4], [4, 3, 2]]) {
      const analysis = classifyMatch(
        syntheticMatch({ handicap, spf: handicap < 0 ? [1.6, 3.8, 5] : [5, 3.8, 1.6], rqspf }),
      );
      assert.notEqual(analysis.group, 'win_no_cover');
      assert.ok(['win_cover', 'lose_cover'].includes(analysis.group));
    }
  }
});

test('高置信阈值用未舍入值：0.60 含等号，0.59996 为 false', () => {
  const base = syntheticMatch({ handicap: -1, rqspf: [3, 4, 5] });

  const atThreshold = classifyMatch({ ...base, spf: [2, 6, 6] });
  assert.ok(atThreshold.highConfidence);
  assert.equal(atThreshold.highConfidence.market, 'SPF');
  assert.equal(atThreshold.highConfidence.outcome, '主胜');

  const below = classifyMatch({ ...base, spf: [2, 5.99, 5.99] });
  assert.equal(below.highConfidence, null);

  const roundsToSixty = classifyMatch({ ...base, spf: [2, 5.999, 5.999] });
  assert.ok(roundsToSixty.spf[0] < 0.6);
  assert.equal((roundsToSixty.spf[0] * 100).toFixed(2), '60.00');
  assert.equal(roundsToSixty.highConfidence, null);
});

test('parseArgs 识别三种模式并拒绝非法组合', () => {
  assert.deepEqual(parseArgs(['--date', '2026-11-15']), { mode: 'date', date: '2026-11-15' });
  assert.deepEqual(parseArgs(['--fixture', 'fixtures/2026-11-15.json']), {
    mode: 'fixture',
    fixture: 'fixtures/2026-11-15.json',
  });
  assert.deepEqual(parseArgs(['--live']), { mode: 'live' });
  assert.deepEqual(parseArgs(['--help']), { mode: 'help' });

  const bad = [
    [],
    ['--bogus'],
    ['--date'],
    ['--fixture'],
    ['--date', '2026-11-15', '--date', '2026-11-15'],
    ['--date', '2026-11-15', '--fixture', 'fixtures/2026-11-15.json'],
    ['--live', '--date', '2026-11-15'],
    ['2026-11-15'],
    ['--date', '2026-02-30'],
    ['--date', '2026-13-01'],
    ['--help', '--date', '2026-11-15'],
  ];
  for (const argv of bad) {
    assert.throws(
      () => parseArgs(argv),
      (err) => err instanceof BoardError && err.code === 'E_USAGE',
      `应拒绝 ${JSON.stringify(argv)}`,
    );
  }
});

test('CLI 用法错误退出码 2 且 stderr 含 [E_USAGE]', () => {
  for (const argv of [[], ['--bogus'], ['--date', '2026-11-15', '--fixture', 'x'], ['2026-11-15'], ['--date', '2026-99-99']]) {
    const result = runCli(argv);
    assert.equal(result.status, 2, JSON.stringify(argv));
    assert.match(result.stderr, /\[E_USAGE\]/);
  }
});

test('CLI 从任意 cwd 都能定位仓库根，缺失 fixture 退出码 3', () => {
  const result = runCli(['--fixture', 'fixtures/nope.json']);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /\[E_FIXTURE_NOT_FOUND\]/);
  assert.ok(result.stderr.includes(path.join(REPO_ROOT, 'fixtures', 'nope.json')));

  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--date/);
});

test('CLI 损坏 JSON 退出码 4', (t) => {
  const file = tempFixture(t, '{ not json');
  const result = runCli(['--fixture', file]);
  assert.equal(result.status, 4);
  assert.match(result.stderr, /\[E_FIXTURE_JSON\]/);
});

test('CLI schema/赔率非法退出码 5 且含场次与字段', (t) => {
  const badSchema = cloneFixture();
  badSchema.matches[0].spf = [2.32, 3.1];
  const schemaFile = tempFixture(t, badSchema);
  const schemaResult = runCli(['--fixture', schemaFile]);
  assert.equal(schemaResult.status, 5);
  assert.match(schemaResult.stderr, /\[E_FIXTURE_SCHEMA\]/);
  assert.match(schemaResult.stderr, /周日001/);
  assert.match(schemaResult.stderr, /spf/);

  const badOdds = cloneFixture();
  badOdds.matches[2].rqspf[1] = 0.5;
  const oddsFile = tempFixture(t, badOdds);
  const oddsResult = runCli(['--fixture', oddsFile]);
  assert.equal(oddsResult.status, 5);
  assert.match(oddsResult.stderr, /周日003/);
  assert.match(oddsResult.stderr, /rqspf/);
});

test('renderHtml 覆盖快照、结构判断、五类分组、逐场明细与免责声明', (t) => {
  const previous = process.env.JCZQ_NOW;
  process.env.JCZQ_NOW = NOW;
  t.after(() => {
    if (previous === undefined) delete process.env.JCZQ_NOW;
    else process.env.JCZQ_NOW = previous;
  });

  const report = analyzeFixture(cloneFixture());
  const html = renderHtml(report);

  assert.match(html, /竞彩足球盘口看板 · 2026-11-15/);
  assert.ok(html.includes(FIXTURE.capturedAt));
  assert.ok(html.includes(NOW));
  assert.ok(html.includes(FIXTURE.oddsUpdatedAt));
  assert.ok(html.includes(FIXTURE.source));
  assert.ok(html.includes(FIXTURE.note));

  assert.ok(html.includes('是否全为整数一球盘：是'));
  assert.ok(html.includes('已开售场次：5'));
  assert.ok(html.includes('整数盘：5'));
  assert.ok(html.includes('半盘：0'));
  assert.ok(html.includes('RQSPF 让球客胜'));
  assert.ok(html.includes('61.38%'));
  assert.ok(html.includes('未开售（pending）：3'));

  assert.match(html, /赢球赢盘（2 场）/);
  assert.match(html, /赢球赢不了盘（3 场）/);
  assert.match(html, /输球赢盘（0 场）/);
  assert.match(html, /输球输盘（0 场）/);
  assert.match(html, /可能平局（1 场）/);
  assert.ok(html.includes(LOSE_COVER_EMPTY_NOTE));
  assert.ok(html.includes('本日无此类（0 场）'));
  assert.ok(!html.includes('本组无场次'));

  assert.ok(html.includes('西班牙 VS 英格兰'));
  assert.ok(html.includes('比利时 VS 意大利'));

  assert.ok(html.includes('id="unclassified"'));
  assert.ok(html.includes('数据不足（未分类）'));
  assert.ok(html.indexOf('id="groups"') < html.indexOf('id="unclassified"'));
  assert.ok(html.indexOf('id="unclassified"') < html.indexOf('id="matches"'));

  const groupsHtml = html.slice(html.indexOf('id="groups"'), html.indexOf('id="unclassified"'));
  assert.ok(!groupsHtml.includes('西班牙 VS 英格兰'), 'pending 不得进入五类分组');

  assert.ok(html.includes('非赔率概率'));
  assert.ok(html.includes('不构成投注建议'));
  assert.ok(html.includes('未满 18 周岁禁止购彩'));

  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /\bhref\s*=/i);
  assert.doesNotMatch(html, /\bsrc\s*=/i);
  assert.doesNotMatch(html, /url\(/i);
});

test('renderHtml 转义所有动态文本', () => {
  const fixture = {
    date: '2026-01-01',
    source: 'https://example.com/?a=1&b=2',
    oddsUpdatedAt: '2026-01-01T00:00:00+08:00',
    capturedAt: '2026-01-01T00:00:00+08:00',
    note: '注 <script>x</script>',
    matches: [
      {
        no: '周日001',
        league: 'L',
        kickoff: '2026-01-01T13:00:00+08:00',
        home: 'A<b>',
        away: 'C&D',
        handicap: -1,
        spf: [1.5, 4, 7],
        rqspf: [1.7, 3.5, 4.5],
      },
    ],
    pending: [{ no: '周日002', league: 'L', note: '<script>alert(1)</script>' }],
  };
  const html = renderHtml(analyzeFixture(fixture));
  assert.ok(!html.includes('A<b>'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('A&lt;b&gt;'));
  assert.ok(html.includes('C&amp;D'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('https://example.com/?a=1&amp;b=2'));
});

test('mapLiveResponse 将官方 JSON 接口映射为 fixture schema（含单市场缺失）', () => {
  const fixture = syntheticLiveFixture();

  assert.equal(fixture.date, '2026-11-15');
  assert.equal(fixture.capturedAt, NOW);
  assert.equal(fixture.oddsUpdatedAt, '2026-11-15T12:28:41+08:00');
  assert.equal(fixture.totalCount, 3);
  assert.equal(fixture.skipped, 0);
  assert.deepEqual(fixture.pending, []);
  assert.equal(fixture.matches.length, 2);
  assert.equal(fixture.unclassified.length, 1);
  assert.match(fixture.note, /--live/);
  assert.match(fixture.note, /totalCount=3/);
  assert.match(fixture.note, /未提供未开售场次/);
  assert.match(fixture.note, /数据不足/);

  const [first, second] = fixture.matches;
  assert.equal(first.no, '周日001');
  assert.equal(first.kickoff, '2026-11-15T13:00:00+08:00');
  assert.equal(first.handicap, -1);
  assert.deepEqual(first.spf, [2.0, 3.3, 3.6]);
  assert.deepEqual(first.rqspf, [1.9, 3.4, 3.8]);
  assert.equal(first.support, undefined);
  assert.deepEqual(second.spf, [1.8, 3.5, 4.0]);
  assert.deepEqual(second.rqspf, [2.1, 3.3, 3.1]);
  assert.equal(second.handicap, 1);

  const eight = fixture.unclassified[0];
  assert.equal(eight.no, '周日008');
  assert.equal(eight.league, '欧国联');
  assert.equal(eight.kickoff, '2026-11-16T01:00:00+08:00');
  assert.equal(eight.home, '芬兰');
  assert.equal(eight.away, '圣马力诺');
  assert.equal(eight.handicap, -4);
  assert.equal(eight.spf, null);
  assert.deepEqual(eight.rqspf, [2.47, 4.62, 1.93]);
  assert.match(eight.note, /SPF/);

  // 映射结果必须能通过正式校验并进入分析，且不补造 support。
  assert.equal(validateFixture(fixture), true);
  const report = analyzeFixture(fixture);
  assert.equal(report.matches.length, 2);
  assert.equal(report.unclassified.length, 1);
  assert.equal(report.totalCount, 3);
  assert.ok(report.matches.every((match) => match.support === undefined));

  // 008 绝不进入五类分组 / 逐场明细 / 可能平局。
  assert.deepEqual(report.likelyDraw.matches.map((match) => match.no), ['周日001']);
  const html = renderHtml(report);
  const groupsHtml = html.slice(html.indexOf('id="groups"'), html.indexOf('id="unclassified"'));
  const matchesHtml = html.slice(html.indexOf('id="matches"'), html.indexOf('id="pending"'));
  const unclassifiedHtml = html.slice(html.indexOf('id="unclassified"'), html.indexOf('id="matches"'));
  assert.ok(!groupsHtml.includes('芬兰'));
  assert.ok(!matchesHtml.includes('芬兰'));
  assert.ok(unclassifiedHtml.includes('芬兰'));
  assert.ok(unclassifiedHtml.includes('主让 4 球'));
  assert.ok(unclassifiedHtml.includes('未开售（官方未提供）'));
  assert.ok(html.includes('官方 totalCount：3 场（可分类 2 场；数据不足 1 场；跳过 0 场）'));
  assert.ok(html.includes('已开售场次：3 场'));
});

test('本地官方快照可映射并通过校验，且满足 totalCount 不变式', () => {
  const fixture = mapLiveResponse(LIVE_RAW, { capturedAt: NOW });
  assert.equal(validateFixture(fixture), true);
  assert.ok(fixture.matches.length + fixture.unclassified.length + fixture.skipped === fixture.totalCount);
  assert.ok(fixture.matches.length + fixture.unclassified.length > 0);
  for (const item of fixture.unclassified) {
    assert.ok(item.spf === null || Array.isArray(item.spf));
    assert.ok(item.rqspf === null || Array.isArray(item.rqspf));
    assert.ok(item.spf !== null || item.rqspf !== null);
  }
});

test('单市场缺失才进 unclassified，双市场缺失/不完整/键缺失一律 E_LIVE_FETCH', () => {
  const bothMissing = liveRaw([liveSub({ had: {}, hhad: {} })]);
  assert.throws(
    () => mapLiveResponse(bothMissing, { capturedAt: NOW }),
    (err) => err instanceof BoardError && err.code === 'E_LIVE_FETCH' && /两个市场|均不可用/.test(err.message),
  );

  const partialHad = liveRaw([liveSub({ had: { h: '2.00', d: '3.30' } })]);
  assert.throws(
    () => mapLiveResponse(partialHad, { capturedAt: NOW }),
    (err) => err instanceof BoardError && err.code === 'E_LIVE_FETCH' && err.message.includes('had'),
  );

  const undefinedHad = liveRaw([liveSub({ had: undefined })]);
  assert.throws(
    () => mapLiveResponse(undefinedHad, { capturedAt: NOW }),
    (err) => err instanceof BoardError && err.code === 'E_LIVE_FETCH' && err.message.includes('had'),
  );

  const badOdds = liveRaw([liveSub({ hhad: { h: '1.90', d: '3.40', a: '0.5', goalLine: '-1' } })]);
  assert.throws(
    () => mapLiveResponse(badOdds, { capturedAt: NOW }),
    (err) => err instanceof BoardError && err.code === 'E_LIVE_FETCH' && err.message.includes('hhad'),
  );
});

test('totalCount 不变式不成立或无可分类场次时 E_LIVE_FETCH', () => {
  const badTotal = liveRaw([liveSub()], { totalCount: 2 });
  assert.throws(
    () => mapLiveResponse(badTotal, { capturedAt: NOW }),
    (err) => err instanceof BoardError && err.code === 'E_LIVE_FETCH' && /totalCount|不变式/.test(err.message),
  );

  const nothing = liveRaw([liveSub({ matchStatus: 'Canceled' })], { totalCount: 1 });
  assert.throws(
    () => mapLiveResponse(nothing, { capturedAt: NOW }),
    (err) => err instanceof BoardError && err.code === 'E_LIVE_FETCH' && /没有任何可用/.test(err.message),
  );

  const badFixture = cloneFixture();
  badFixture.totalCount = 99;
  badFixture.skipped = 0;
  assert.throws(
    () => validateFixture(badFixture),
    (err) => err instanceof BoardError && err.code === 'E_FIXTURE_SCHEMA' && /totalCount|不变式/.test(err.message),
  );
});

test('validateFixture 接受唯一市场缺失的 unclassified 条目（含整数 |h|≥2）', () => {
  const fixture = cloneFixture();
  fixture.unclassified = [
    {
      no: '周日008',
      league: '欧国联',
      kickoff: '2026-11-16T01:00:00+08:00',
      home: '芬兰',
      away: '圣马力诺',
      handicap: -4,
      spf: null,
      rqspf: [2.47, 4.62, 1.93],
      note: '官方未开售 SPF，不参与推断。',
    },
  ];
  fixture.totalCount = 6;
  fixture.skipped = 0;
  assert.equal(validateFixture(fixture), true);

  const bothNull = cloneFixture();
  bothNull.unclassified = [{ ...fixture.unclassified[0], spf: null, rqspf: null }];
  bothNull.totalCount = 6;
  bothNull.skipped = 0;
  assert.throws(
    () => validateFixture(bothNull),
    (err) => err instanceof BoardError && err.code === 'E_FIXTURE_SCHEMA',
  );
});

test('mapLiveResponse 结构异常一律抛 E_LIVE_FETCH', () => {
  const cloneRaw = () => JSON.parse(JSON.stringify(LIVE_RAW));

  const missingHhad = cloneRaw();
  delete missingHhad.value.matchInfoList[0].subMatchList[0].hhad;
  assert.throws(
    () => mapLiveResponse(missingHhad, { capturedAt: NOW }),
    (err) => err instanceof BoardError && err.code === 'E_LIVE_FETCH' && err.message.includes('hhad'),
  );

  const successFalse = cloneRaw();
  successFalse.success = false;
  assert.throws(
    () => mapLiveResponse(successFalse, { capturedAt: NOW }),
    (err) => err instanceof BoardError && err.code === 'E_LIVE_FETCH' && err.message.includes('success'),
  );

  const missingList = cloneRaw();
  delete missingList.value.matchInfoList;
  assert.throws(
    () => mapLiveResponse(missingList, { capturedAt: NOW }),
    (err) => err instanceof BoardError && err.code === 'E_LIVE_FETCH' && err.message.includes('matchInfoList'),
  );

  assert.throws(
    () => mapLiveResponse('not-json', { capturedAt: NOW }),
    (err) => err instanceof BoardError && err.code === 'E_LIVE_FETCH',
  );
});

test('formatPlus08 固定输出 +08:00，且与宿主时区无关', () => {
  assert.equal(formatPlus08('2026-11-15T04:28:41Z'), '2026-11-15T12:28:41+08:00');
  assert.equal(formatPlus08('2026-11-15T12:28:41+08:00'), '2026-11-15T12:28:41+08:00');
  assert.equal(formatPlus08(new Date('2026-11-15T00:00:00Z')), '2026-11-15T08:00:00+08:00');
  assert.equal(formatPlus08(0), '1970-01-01T08:00:00+08:00');
  assert.match(formatPlus08(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  assert.throws(() => formatPlus08('not-a-date'), RangeError);
  assert.throws(() => formatPlus08(Number.NaN), RangeError);
});

test('JCZQ_NOW 覆盖归一化为 +08:00，非法或缺少时区退出码 1', (t) => {
  const previous = process.env.JCZQ_NOW;
  t.after(() => {
    if (previous === undefined) delete process.env.JCZQ_NOW;
    else process.env.JCZQ_NOW = previous;
  });

  process.env.JCZQ_NOW = '2026-11-15T04:28:41Z';
  assert.equal(analyzeFixture(cloneFixture()).generatedAt, '2026-11-15T12:28:41+08:00');

  process.env.JCZQ_NOW = '2026-11-15T12:28:41+08:00';
  assert.equal(analyzeFixture(cloneFixture()).generatedAt, '2026-11-15T12:28:41+08:00');

  for (const invalid of ['not-a-date', '2026-11-15T09:30:00']) {
    const result = runCli(['--fixture', FIXTURE_PATH], { JCZQ_NOW: invalid });
    assert.equal(result.status, 1, invalid);
    assert.match(result.stderr, /\[E_INTERNAL\]/);
  }
});

test('LIVE_HEADERS 使用桌面浏览器 UA 与官方 referer，且不含 cookie', () => {
  assert.match(LIVE_HEADERS['user-agent'], /Mozilla\/5\.0/);
  assert.equal(LIVE_HEADERS.referer, 'https://www.sporttery.cn/jc/jsq/zqspf/');
  assert.equal(LIVE_HEADERS.accept, 'application/json, text/plain, */*');
  assert.ok(!('cookie' in LIVE_HEADERS));
});

test('空组统一文案，LOSE_COVER_EMPTY_NOTE 仅在全为整数一球盘时附加', () => {
  const previous = process.env.JCZQ_NOW;
  process.env.JCZQ_NOW = NOW;
  try {
    const integerOnly = analyzeFixture(cloneFixture());
    const integerHtml = renderHtml(integerOnly);
    assert.ok(integerHtml.includes(LOSE_COVER_EMPTY_NOTE));

    const halfFixture = cloneFixture();
    halfFixture.matches = [syntheticMatch({ no: '周日100', handicap: -1.5, rqspf: [1.5, 4, 6] })];
    const halfHtml = renderHtml(analyzeFixture(halfFixture));
    assert.match(halfHtml, /输球赢盘（0 场）/);
    assert.ok(halfHtml.includes('本日无此类（0 场）'));
    assert.ok(!halfHtml.includes(LOSE_COVER_EMPTY_NOTE));
  } finally {
    if (previous === undefined) delete process.env.JCZQ_NOW;
    else process.env.JCZQ_NOW = previous;
  }
});

test('数据不足区转义所有动态文本，且空区也渲染', () => {
  const fixture = {
    date: '2026-11-15',
    source: 'https://example.com/?a=1&b=2',
    oddsUpdatedAt: '2026-11-15T12:28:41+08:00',
    capturedAt: '2026-11-15T12:28:41+08:00',
    note: 'n',
    matches: [],
    pending: [],
    unclassified: [
      {
        no: '周日008',
        league: 'L<i>',
        kickoff: '2026-11-16T01:00:00+08:00',
        home: 'A<b>',
        away: 'C&D',
        handicap: -4,
        spf: null,
        rqspf: [2.47, 4.62, 1.93],
        note: '<script>alert(1)</script>',
      },
    ],
  };
  const html = renderHtml(analyzeFixture(fixture));
  assert.ok(!html.includes('A<b>'));
  assert.ok(!html.includes('L<i>'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('A&lt;b&gt;'));
  assert.ok(html.includes('C&amp;D'));
  assert.ok(html.includes('L&lt;i&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('未开售（官方未提供）'));

  const emptyHtml = renderHtml(analyzeFixture(cloneFixture()));
  const emptySection = emptyHtml.slice(emptyHtml.indexOf('id="unclassified"'), emptyHtml.indexOf('id="matches"'));
  assert.match(emptySection, /本日无此类（0 场）/);
});

test('--live 网络不可达退出码 6，不依赖真实网络', () => {
  const result = runCli(['--live'], { JCZQ_LIVE_URL: 'http://127.0.0.1:1/' });
  assert.equal(result.status, 6);
  assert.match(result.stderr, /\[E_LIVE_FETCH\]/);
});

test('--live 响应不是 JSON 退出码 6', () => {
  const result = runCli(['--live'], { JCZQ_LIVE_URL: 'data:text/plain,not-json' });
  assert.equal(result.status, 6);
  assert.match(result.stderr, /\[E_LIVE_FETCH\]/);
  assert.match(result.stderr, /不是 JSON/);
});

test('parseArgs 默认形状不变，并支持 --dry-run / --out', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jczq-out-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outFile = path.join(dir, 'board.html');

  assert.deepEqual(parseArgs(['--date', '2026-11-15']), { mode: 'date', date: '2026-11-15' });
  assert.deepEqual(parseArgs(['--fixture', 'fixtures/2026-11-15.json']), {
    mode: 'fixture',
    fixture: 'fixtures/2026-11-15.json',
  });
  assert.deepEqual(parseArgs(['--live']), { mode: 'live' });
  assert.deepEqual(parseArgs(['--help']), { mode: 'help' });
  assert.deepEqual(parseArgs(['--live', '--dry-run']), { mode: 'live', dryRun: true });
  assert.deepEqual(parseArgs(['--fixture', 'x.json', '--out', outFile]), {
    mode: 'fixture',
    fixture: 'x.json',
    out: path.resolve(outFile),
  });

  const relative = path.relative(process.cwd(), outFile);
  assert.equal(parseArgs(['--live', '--out', relative]).out, path.resolve(outFile));
  assert.equal(parseArgs(['--live', '--out', outFile]).out, path.resolve(outFile));
});

test('parseArgs 拒绝新增选项的重复/缺值/互斥/help 组合与非法 --out 目标', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jczq-out-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plainFile = path.join(dir, 'plain.txt');
  writeFileSync(plainFile, 'x', 'utf8');
  const targetDir = path.join(dir, 'target-dir');
  mkdirSync(targetDir);
  const missingParent = path.join(dir, 'missing', 'board.html');

  const bad = [
    ['--live', '--dry-run', '--dry-run'],
    ['--live', '--out', path.join(dir, 'a.html'), '--out', path.join(dir, 'b.html')],
    ['--live', '--out'],
    ['--live', '--out', ''],
    ['--live', '--out', '--dry-run'],
    ['--live', '--dry-run', '--out', path.join(dir, 'x.html')],
    ['--help', '--dry-run'],
    ['--help', '--out', path.join(dir, 'x.html')],
    ['--live', '--out', missingParent],
    ['--live', '--out', path.join(plainFile, 'x.html')],
    ['--live', '--out', targetDir],
    [`--live`, `--out=${path.join(dir, 'x.html')}`],
    ['--live', '-o', path.join(dir, 'x.html')],
  ];
  for (const argv of bad) {
    assert.throws(
      () => parseArgs(argv),
      (err) => err instanceof BoardError && err.code === 'E_USAGE',
      `应拒绝 ${JSON.stringify(argv)}`,
    );
  }
  assert.ok(!existsSync(path.join(dir, 'missing')), '预检不得创建父目录');
});

test('CLI --fixture --dry-run 输出单行摘要且不写任何文件', (t) => {
  const reportsDir = path.join(REPO_ROOT, 'reports');
  const fixturesDir = path.join(REPO_ROOT, 'fixtures');
  const beforeReports = snapshotDir(reportsDir);
  const beforeFixtures = snapshotDir(fixturesDir);
  const previous = process.env.JCZQ_NOW;
  t.after(() => {
    if (previous === undefined) delete process.env.JCZQ_NOW;
    else process.env.JCZQ_NOW = previous;
  });

  const result = runCli(['--fixture', FIXTURE_PATH, '--dry-run'], { JCZQ_NOW: NOW });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const summary = parseSingleLineJson(result.stdout);

  assert.deepEqual(Object.keys(summary).sort(), [...SUMMARY_KEYS].sort());
  assert.equal(typeof summary.oddsUpdatedAt, 'string');
  assert.equal(summary.oddsUpdatedAt, FIXTURE.oddsUpdatedAt);
  for (const key of ['totalCount', 'matches', 'unclassified', 'skipped']) {
    assert.ok(Number.isInteger(summary[key]) && summary[key] >= 0, `${key} 必须是非负整数`);
  }
  assert.deepEqual(Object.keys(summary.groups).sort(), [...GROUP_KEYS].sort());
  for (const key of GROUP_KEYS) {
    assert.ok(Number.isInteger(summary.groups[key]) && summary.groups[key] >= 0, `groups.${key} 必须是非负整数`);
  }

  const expectedTotal =
    FIXTURE.totalCount ?? FIXTURE.matches.length + (FIXTURE.unclassified ?? []).length + (FIXTURE.skipped ?? 0);
  assert.equal(summary.totalCount, expectedTotal);
  assert.equal(summary.matches, FIXTURE.matches.length);
  assert.equal(summary.unclassified, (FIXTURE.unclassified ?? []).length);
  assert.equal(summary.skipped, FIXTURE.skipped ?? 0);

  const groupSum = GROUP_KEYS.reduce((sum, key) => sum + summary.groups[key], 0);
  assert.equal(groupSum, summary.matches, 'groups 五值之和必须等于 matches');
  assert.equal(groupSum + summary.unclassified + summary.skipped, summary.totalCount);
  assert.deepEqual(summary.likelyDraw, { probability: summary.likelyDraw.probability, nos: ['周日001'] });
  assert.equal(typeof summary.likelyDraw.probability, 'number');

  assert.deepEqual(snapshotDir(reportsDir), beforeReports);
  assert.deepEqual(snapshotDir(fixturesDir), beforeFixtures);
});

test('CLI --live --dry-run 用本地 JSON 快照完成抓取但不落盘', () => {
  const rawText = readFileSync(LIVE_RAW_PATH, 'utf8');
  const url = `data:application/json,${encodeURIComponent(rawText)}`;
  const reportsDir = path.join(REPO_ROOT, 'reports');
  const fixturesDir = path.join(REPO_ROOT, 'fixtures');
  const beforeReports = snapshotDir(reportsDir);
  const beforeFixtures = snapshotDir(fixturesDir);

  const result = runCli(['--live', '--dry-run'], { JCZQ_LIVE_URL: url, JCZQ_NOW: NOW });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const summary = parseSingleLineJson(result.stdout);

  const expected = liveExpectedCounts(LIVE_RAW);
  assert.equal(summary.totalCount, expected.totalCount);
  assert.equal(summary.matches, expected.matches);
  assert.equal(summary.unclassified, expected.unclassified);
  assert.equal(summary.skipped, expected.skipped);
  assert.equal(summary.oddsUpdatedAt, `${LIVE_RAW.value.lastUpdateTime.replace(' ', 'T')}+08:00`);

  const groupSum = GROUP_KEYS.reduce((sum, key) => sum + summary.groups[key], 0);
  assert.equal(groupSum, summary.matches);
  assert.equal(groupSum + summary.unclassified + summary.skipped, summary.totalCount);
  assert.ok(summary.likelyDraw, '当前快照应存在可能平局');
  assert.equal(typeof summary.likelyDraw.probability, 'number');
  assert.ok(Array.isArray(summary.likelyDraw.nos) && summary.likelyDraw.nos.length > 0);
  assert.equal(new Set(summary.likelyDraw.nos).size, summary.likelyDraw.nos.length, 'nos 不得重复');

  assert.deepEqual(snapshotDir(reportsDir), beforeReports);
  assert.deepEqual(snapshotDir(fixturesDir), beforeFixtures);
});

test('CLI --live --dry-run 抓取失败退出 6，stdout 为空且不写文件', () => {
  const reportsDir = path.join(REPO_ROOT, 'reports');
  const fixturesDir = path.join(REPO_ROOT, 'fixtures');
  const beforeReports = snapshotDir(reportsDir);
  const beforeFixtures = snapshotDir(fixturesDir);

  const result = runCli(['--live', '--dry-run'], { JCZQ_LIVE_URL: 'http://127.0.0.1:1/', JCZQ_NOW: NOW });
  assert.equal(result.status, 6);
  assert.match(result.stderr, /\[E_LIVE_FETCH\]/);
  assert.equal(result.stdout, '');
  assert.deepEqual(snapshotDir(reportsDir), beforeReports);
  assert.deepEqual(snapshotDir(fixturesDir), beforeFixtures);
});

test('CLI --dry-run fixture schema 非法退出 5，stdout 为空且不写文件', (t) => {
  const bad = cloneFixture();
  bad.matches[0].spf = [2.32, 3.1];
  const file = tempFixture(t, bad);
  const reportsDir = path.join(REPO_ROOT, 'reports');
  const fixturesDir = path.join(REPO_ROOT, 'fixtures');
  const beforeReports = snapshotDir(reportsDir);
  const beforeFixtures = snapshotDir(fixturesDir);

  const result = runCli(['--fixture', file, '--dry-run']);
  assert.equal(result.status, 5);
  assert.match(result.stderr, /\[E_FIXTURE_SCHEMA\]/);
  assert.equal(result.stdout, '');
  assert.deepEqual(snapshotDir(reportsDir), beforeReports);
  assert.deepEqual(snapshotDir(fixturesDir), beforeFixtures);
});

test('CLI --live --out 写到指定路径，不动 reports/ 并恢复快照', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jczq-out-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outFile = path.join(dir, 'board.html');
  const rawText = readFileSync(LIVE_RAW_PATH, 'utf8');
  const url = `data:application/json,${encodeURIComponent(rawText)}`;
  const snapshotPath = path.join(REPO_ROOT, 'fixtures', '2026-11-15.live-raw.json');
  const originalBytes = readFileSync(snapshotPath);
  const originalStat = statSync(snapshotPath);
  const reportsDir = path.join(REPO_ROOT, 'reports');
  const beforeReports = snapshotDir(reportsDir);

  try {
    const result = runCli(['--live', '--out', outFile], { JCZQ_LIVE_URL: url, JCZQ_NOW: NOW });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `已生成报告：${outFile}\n`);
    assert.ok(existsSync(outFile), '报告必须写到 --out 指定路径');
    const html = readFileSync(outFile, 'utf8');
    assert.ok(html.length > 0);
    assert.ok(html.startsWith('<!doctype html>'));
    assert.deepEqual(snapshotDir(reportsDir), beforeReports, 'reports/ 不得被改动');
    assert.ok(existsSync(snapshotPath), '--live 仍应写官方快照');
  } finally {
    writeFileSync(snapshotPath, originalBytes);
    utimesSync(snapshotPath, originalStat.atime, originalStat.mtime);
  }
});

test('CLI --out 用法错误退出 2 且不创建父目录/不写文件', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jczq-out-err-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plainFile = path.join(dir, 'plain.txt');
  writeFileSync(plainFile, 'x', 'utf8');
  const targetDir = path.join(dir, 'target-dir');
  mkdirSync(targetDir);
  const missingDir = path.join(dir, 'missing');

  const cases = [
    ['--fixture', FIXTURE_PATH, '--out', path.join(missingDir, 'board.html')],
    ['--fixture', FIXTURE_PATH, '--out'],
    ['--fixture', FIXTURE_PATH, '--out', ''],
    ['--fixture', FIXTURE_PATH, '--dry-run', '--out', path.join(dir, 'x.html')],
    ['--fixture', FIXTURE_PATH, '--out', targetDir],
    ['--fixture', FIXTURE_PATH, '--out', path.join(plainFile, 'x.html')],
    ['--help', '--dry-run'],
    ['--help', '--out', path.join(dir, 'x.html')],
  ];
  for (const argv of cases) {
    const before = snapshotDir(dir);
    const result = runCli(argv);
    assert.equal(result.status, 2, JSON.stringify(argv));
    assert.match(result.stderr, /\[E_USAGE\]/);
    assert.equal(result.stdout, '');
    assert.ok(!existsSync(missingDir), '父目录不得被创建');
    assert.deepEqual(snapshotDir(dir), before, '不得写出任何文件');
  }
});
