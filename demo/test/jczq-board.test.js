import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EPS,
  HIGH_CONFIDENCE_THRESHOLD,
  REPO_ROOT,
  BoardError,
  devig,
  describeHandicap,
  classifyMatch,
  findLikelyDraw,
  analyzeFixture,
  renderHtml,
  parseArgs,
  validateFixture,
} from '../../scripts/jczq-board.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/jczq-board.mjs', import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/2026-11-15.json', import.meta.url));
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const NOW = '2026-11-15T09:30:00+08:00';

const LOSE_COVER_EMPTY_NOTE =
  '整数一球盘下，输 1 球为走盘（让球平），受让方输球不可能赢盘；真正的「输球赢盘」需要半盘。本批无半盘，该组恒为空，未硬凑场次、未虚构半盘。';

function cloneFixture() {
  return JSON.parse(JSON.stringify(FIXTURE));
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 15000,
  });
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
  assert.ok(html.includes('本组无场次'));

  assert.ok(html.includes('西班牙 VS 英格兰'));
  assert.ok(html.includes('比利时 VS 意大利'));

  const groupsHtml = html.slice(html.indexOf('id="groups"'), html.indexOf('id="matches"'));
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
