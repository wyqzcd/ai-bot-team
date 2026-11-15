#!/usr/bin/env node
/**
 * 竞彩足球盘口看板：零依赖 ESM（Node >= 18），CLI + 可直接单测的导出。
 *
 * 口径（与需求一致，不在此处硬编码任何场次结论）：
 * - 去水 p_i = (1/odds_i) / Σ(1/odds_j)，SPF 与 RQSPF 各自独立归一化。
 * - handicap 负=主队让球，正=主队受让；spf=[主胜,平,客胜]，rqspf=[让球主胜,让球平,让球客胜]。
 * - 由 handicap 符号确定让球方；整数一球盘下 RQSPF 三项是让球方结果的三段划分。
 * - support 只做展示，不参与任何计算、排序或分组。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EPS = 1e-9;
export const HIGH_CONFIDENCE_THRESHOLD = 0.6;

const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.dirname(path.dirname(__filename));

const EXIT_CODES = {
  E_INTERNAL: 1,
  E_USAGE: 2,
  E_FIXTURE_NOT_FOUND: 3,
  E_FIXTURE_JSON: 4,
  E_FIXTURE_SCHEMA: 5,
  E_LIVE_FETCH: 6,
};

const SPF_LABELS = ['主胜', '平局', '客胜'];
const RQSPF_LABELS = ['让球主胜', '让球平', '让球客胜'];
const GROUP_LABELS = {
  win_cover: '赢球赢盘',
  win_no_cover: '赢球赢不了盘',
  lose_cover: '输球赢盘',
  lose_no_cover: '输球输盘',
  no_handicap: '无让球盘',
  ambiguous: '无法判定（ambiguous）',
};
const FOUR_GROUPS = [
  ['win_cover', '赢球赢盘'],
  ['win_no_cover', '赢球赢不了盘'],
  ['lose_cover', '输球赢盘'],
  ['lose_no_cover', '输球输盘'],
];
const LOSE_COVER_EMPTY_NOTE =
  '整数一球盘下，输 1 球为走盘（让球平），受让方输球不可能赢盘；真正的「输球赢盘」需要半盘。本批无半盘，该组恒为空，未硬凑场次、未虚构半盘。';
const MISSING_CELL = '未开售（官方未提供）';
const DEFAULT_LIVE_URL =
  'https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry?poolCode=hhad,had&channel=c';

/** 官方接口有反爬：必须带桌面浏览器 UA 与官方 referer，否则返回 567 HTML。 */
export const LIVE_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  referer: 'https://www.sporttery.cn/jc/jsq/zqspf/',
  accept: 'application/json, text/plain, */*',
};

const HELP_TEXT = `竞彩足球盘口看板（零依赖 ESM）

用法（三种模式互斥，必须且只能选一种）：
  node scripts/jczq-board.mjs --date <YYYY-MM-DD>   读取 fixtures/<date>.json
  node scripts/jczq-board.mjs --fixture <path>      读取指定 JSON（相对仓库根，也接受绝对路径）
  node scripts/jczq-board.mjs --live                从官方 JSON 接口抓取实时数据
  node scripts/jczq-board.mjs --help                显示本帮助

可选：
  --out <path>     报告改写到指定路径（相对 cwd 或绝对路径；父目录须已存在）
  --dry-run        只抓取/校验/分析并打印一行 JSON 摘要，不写任何文件（与 --out 互斥）

默认输出 reports/<fixture.date>.html（与 cwd 无关）。
--live 会同时刷新 fixtures/<fixture.date>.live-raw.json（官方响应原文快照）；--dry-run 不写该快照。
环境变量：
  JCZQ_NOW       覆盖生成时间 generatedAt（带时区 ISO，便于复现）
  JCZQ_LIVE_URL  覆盖 --live 的抓取地址
退出码：0 成功，1 内部错误，2 用法错误，3 fixture 不存在，4 JSON 非法，
        5 schema/赔率非法，6 实时抓取失败。
`;

export class BoardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BoardError';
    this.code = code;
  }
}

function usageError(message) {
  throw new BoardError('E_USAGE', message);
}

function schemaError(message) {
  throw new BoardError('E_FIXTURE_SCHEMA', message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isIsoWithTimezone(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/**
 * 固定输出 YYYY-MM-DDTHH:mm:ss+08:00，与宿主时区无关：
 * 用 UTC 毫秒 +8h 后切片，不使用 toLocaleString。
 */
export function formatPlus08(input) {
  let milliseconds;
  if (input === undefined) milliseconds = Date.now();
  else if (input instanceof Date) milliseconds = input.getTime();
  else if (typeof input === 'number') milliseconds = input;
  else if (typeof input === 'string') milliseconds = Date.parse(input);
  else throw new RangeError(`formatPlus08: 输入必须是 Date、时间戳或 ISO 字符串（${String(input)}）`);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`formatPlus08: 非法时间输入（${String(input)}）`);
  }
  const shifted = new Date(milliseconds + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

/** 赔率去水：仅对非 null 项归一化，null 原样保留。 */
export function devig(odds) {
  if (!Array.isArray(odds) || odds.length === 0) {
    throw new RangeError('devig: 赔率数组不能为空');
  }
  const inverse = odds.map((value, index) => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 1) {
      throw new RangeError(`devig: 第 ${index} 项赔率必须是 > 1 的有限数字`);
    }
    return 1 / value;
  });
  const total = inverse.reduce((sum, value) => sum + (value ?? 0), 0);
  if (total <= 0) {
    throw new RangeError('devig: 至少需要一个非 null 赔率');
  }
  return inverse.map((value) => (value === null ? null : value / total));
}

/** 解析让球：负=主队让球，正=主队受让，0=无让球方。 */
export function describeHandicap(handicap) {
  if (typeof handicap !== 'number' || !Number.isFinite(handicap)) {
    throw new RangeError('describeHandicap: handicap 必须是有限数字');
  }
  if (!Number.isInteger(handicap * 2)) {
    throw new RangeError('describeHandicap: handicap 必须是 0.5 的倍数');
  }
  if (Math.abs(handicap) > 5) {
    throw new RangeError('describeHandicap: |handicap| 不能超过 5');
  }
  const goals = Math.abs(handicap);
  if (handicap === 0) {
    return { side: null, goals: 0, isInteger: true };
  }
  return { side: handicap < 0 ? 'home' : 'away', goals, isInteger: Number.isInteger(handicap) };
}

function topIndices(values) {
  const max = Math.max(...values);
  const indices = [];
  values.forEach((value, index) => {
    if (max - value <= EPS) indices.push(index);
  });
  return { indices, max };
}

/** 两市场所有去水概率中取未舍入最大值；≥ 阈值才标为高置信。 */
function computeHighConfidence(spf, rqspf) {
  const candidates = [];
  spf.forEach((probability, index) => {
    if (typeof probability === 'number') {
      candidates.push({ market: 'SPF', outcome: SPF_LABELS[index], probability });
    }
  });
  rqspf.forEach((probability, index) => {
    if (typeof probability === 'number') {
      candidates.push({ market: 'RQSPF', outcome: RQSPF_LABELS[index], probability });
    }
  });
  let best = null;
  for (const candidate of candidates) {
    if (best === null || candidate.probability > best.probability + EPS) {
      best = candidate;
    }
  }
  if (best !== null && best.probability >= HIGH_CONFIDENCE_THRESHOLD) return best;
  return null;
}

/** 按定稿规则判定单场。输入应已通过 validateFixture。 */
export function classifyMatch(match) {
  const spf = devig(match.spf);
  const rqspf = devig(match.rqspf);
  const handicapInfo = describeHandicap(match.handicap);

  if (handicapInfo.isInteger && handicapInfo.goals >= 2) {
    throw new RangeError(`场次 ${match.no ?? ''} 字段 handicap=${match.handicap}：整数 |h|≥2 的口径未定义`);
  }

  const { indices: topIndicesList, max: spfMax } = topIndices(spf);
  const highConfidence = computeHighConfidence(spf, rqspf);

  let group;
  let reason;

  if (handicapInfo.side === null) {
    group = 'no_handicap';
    reason = 'handicap=0，无让球方，不参与四类归属。';
  } else if (topIndicesList.length > 1) {
    group = 'ambiguous';
    reason = `SPF 去水最大项并列（${topIndicesList.map((index) => SPF_LABELS[index]).join(' / ')}，${percent(spfMax)}），判定为 ambiguous。`;
  } else {
    const top = topIndicesList[0];
    const giverIsHome = handicapInfo.side === 'home';
    const giverIndex = giverIsHome ? 0 : 2;

    if (top !== giverIndex) {
      group = 'lose_no_cover';
      reason = `SPF 最大项为${SPF_LABELS[top]}（${percent(spf[top])}），不是让球方，意味着让球方打平或输球，判定为输球输盘。`;
    } else if (handicapInfo.isInteger) {
      const giverWin = rqspf[giverIndex];
      const push = rqspf[1];
      if (Math.abs(giverWin - push) <= EPS) {
        group = 'ambiguous';
        reason = `整数一球盘：让球方赢盘概率 ${percent(giverWin)} 与走盘概率 ${percent(push)} 相差不超过 EPS，判定为 ambiguous。`;
      } else if (giverWin > push) {
        group = 'win_cover';
        reason = `SPF 最大项为${SPF_LABELS[top]}，属让球方；整数一球盘下让球方赢盘概率 ${percent(giverWin)} 高于走盘概率 ${percent(push)}，判定为赢球赢盘。`;
      } else {
        group = 'win_no_cover';
        reason = `SPF 最大项为${SPF_LABELS[top]}，属让球方；整数一球盘下让球方赢盘概率 ${percent(giverWin)} 低于走盘概率 ${percent(push)}，判定为赢球赢不了盘。`;
      }
    } else {
      const receiverIndex = giverIsHome ? 2 : 0;
      const receiver = rqspf[receiverIndex];
      const giverWin = rqspf[giverIndex];
      if (receiver > giverWin) {
        group = 'lose_cover';
        reason = `半盘（|handicap|=${handicapInfo.goals}）：RQSPF 受让方概率 ${percent(receiver)} 高于让球方概率 ${percent(giverWin)}，判定为输球赢盘。`;
      } else {
        group = 'win_cover';
        reason = `半盘（|handicap|=${handicapInfo.goals}）：RQSPF 受让方概率 ${percent(receiver)} 不高于让球方概率 ${percent(giverWin)}，判定为赢球赢盘；半盘不产生赢球赢不了盘。`;
      }
    }
  }

  return {
    no: match.no,
    league: match.league,
    kickoff: match.kickoff,
    home: match.home,
    away: match.away,
    handicap: match.handicap,
    handicapInfo,
    support: match.support,
    spfOdds: match.spf,
    rqspfOdds: match.rqspf,
    spf,
    rqspf,
    spfTop: {
      indices: topIndicesList,
      labels: topIndicesList.map((index) => SPF_LABELS[index]),
      probability: spfMax,
    },
    group,
    reason,
    highConfidence,
  };
}

/** 跨全部已开售场次取 SPF 平局去水概率最大者，并列按 fixture 顺序全部列出。 */
export function findLikelyDraw(analyses) {
  if (!Array.isArray(analyses) || analyses.length === 0) return null;
  const drawProbabilities = analyses.map((analysis) => analysis.spf[1]);
  const max = Math.max(...drawProbabilities);
  return {
    probability: max,
    matches: analyses.filter((analysis) => max - analysis.spf[1] <= EPS),
  };
}

function validateOdds3(values, where, field) {
  if (!Array.isArray(values) || values.length !== 3) {
    schemaError(`${where} 字段 ${field} 必须是长度 3 的数组`);
  }
  values.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 1) {
      schemaError(`${where} 字段 ${field}[${index}] 必须是 > 1 的有限数字`);
    }
  });
}

function validateMatch(match, index, seenNos) {
  if (!isPlainObject(match)) schemaError(`场次 #${index + 1} 必须是对象`);
  const where = isNonEmptyString(match.no) ? `场次 ${match.no}` : `场次 #${index + 1}`;

  for (const field of ['no', 'league', 'home', 'away']) {
    if (!isNonEmptyString(match[field])) schemaError(`${where} 字段 ${field} 必须是非空字符串`);
  }
  if (seenNos.has(match.no)) schemaError(`场次 no 重复：${match.no}（字段 no）`);
  seenNos.add(match.no);

  if (!isIsoWithTimezone(match.kickoff)) {
    schemaError(`${where} 字段 kickoff 必须是带时区的 ISO 时间`);
  }

  const handicap = match.handicap;
  if (typeof handicap !== 'number' || !Number.isFinite(handicap) || !Number.isInteger(handicap * 2) || Math.abs(handicap) > 5) {
    schemaError(`${where} 字段 handicap 必须是 0.5 的倍数且 |handicap| ≤ 5`);
  }
  if (Number.isInteger(handicap) && Math.abs(handicap) >= 2) {
    schemaError(`${where} 字段 handicap=${handicap}：整数 |h|≥2 的口径未定义，拒绝处理`);
  }

  validateOdds3(match.spf, where, 'spf');
  validateOdds3(match.rqspf, where, 'rqspf');

  if (match.support !== undefined) {
    if (!isPlainObject(match.support)) schemaError(`${where} 字段 support 必须是对象`);
    for (const field of ['spf', 'rqspf']) {
      if (!Array.isArray(match.support[field]) || match.support[field].length !== 3) {
        schemaError(`${where} 字段 support.${field} 必须是长度 3 的数组`);
      }
    }
  }
}

function validatePending(pending) {
  const seenNos = new Set();
  pending.forEach((item, index) => {
    if (!isPlainObject(item)) schemaError(`待开售条目 #${index + 1} 必须是对象`);
    const where = isNonEmptyString(item.no) ? `待开售条目 ${item.no}` : `待开售条目 #${index + 1}`;
    if (!isNonEmptyString(item.no)) schemaError(`${where} 字段 no 必须是非空字符串`);
    if (seenNos.has(item.no)) schemaError(`待开售条目 no 重复：${item.no}（字段 no）`);
    seenNos.add(item.no);
    if (item.kickoff !== undefined && !isIsoWithTimezone(item.kickoff)) {
      schemaError(`${where} 字段 kickoff 必须是带时区的 ISO 时间`);
    }
    if (item.match !== undefined && !isNonEmptyString(item.match)) {
      schemaError(`${where} 字段 match 必须是非空字符串`);
    }
    if (item.league !== undefined && !isNonEmptyString(item.league)) {
      schemaError(`${where} 字段 league 必须是非空字符串`);
    }
    if (item.note !== undefined && typeof item.note !== 'string') {
      schemaError(`${where} 字段 note 必须是字符串`);
    }
  });
}

/**
 * 数据不足条目：恰好一个市场缺失（null），另一市场保留原值；
 * 允许整数 |h|≥2（如 008 的 -4），因为它不参与分类口径。
 */
function validateUnclassified(item, index, seenNos) {
  if (!isPlainObject(item)) schemaError(`数据不足条目 #${index + 1} 必须是对象`);
  const where = isNonEmptyString(item.no) ? `数据不足条目 ${item.no}` : `数据不足条目 #${index + 1}`;
  for (const field of ['no', 'league', 'home', 'away']) {
    if (!isNonEmptyString(item[field])) schemaError(`${where} 字段 ${field} 必须是非空字符串`);
  }
  if (seenNos.has(item.no)) schemaError(`场次 no 重复：${item.no}（字段 no）`);
  seenNos.add(item.no);

  if (!isIsoWithTimezone(item.kickoff)) {
    schemaError(`${where} 字段 kickoff 必须是带时区的 ISO 时间`);
  }

  const hasSpf = item.spf !== null && item.spf !== undefined;
  const hasRqspf = item.rqspf !== null && item.rqspf !== undefined;
  if (!hasSpf && !hasRqspf) schemaError(`${where} 的 spf 与 rqspf 不能同时缺失`);
  if (hasSpf) validateOdds3(item.spf, where, 'spf');
  if (hasRqspf) validateOdds3(item.rqspf, where, 'rqspf');

  if (item.handicap !== null && item.handicap !== undefined) {
    const handicap = item.handicap;
    if (
      typeof handicap !== 'number' ||
      !Number.isFinite(handicap) ||
      !Number.isInteger(handicap * 2) ||
      Math.abs(handicap) > 5
    ) {
      schemaError(`${where} 字段 handicap 必须是 0.5 的倍数且 |handicap| ≤ 5`);
    }
  } else if (hasRqspf) {
    schemaError(`${where} 缺少 handicap（RQSPF 已开售时必须提供让球）`);
  }

  if (item.note !== undefined && typeof item.note !== 'string') {
    schemaError(`${where} 字段 note 必须是字符串`);
  }
}

/** 校验 fixture 结构与赔率；失败抛 BoardError(E_FIXTURE_SCHEMA)。 */
export function validateFixture(fixture, { date } = {}) {
  if (!isPlainObject(fixture)) schemaError('fixture 必须是 JSON 对象');

  if (!isIsoDate(fixture.date)) schemaError('fixture.date 必须是合法的 YYYY-MM-DD');
  if (date !== undefined && fixture.date !== date) {
    schemaError(`fixture.date（${fixture.date}）与命令行 --date（${date}）不一致（字段 date）`);
  }
  if (!isNonEmptyString(fixture.source)) schemaError('fixture.source 必须是非空字符串');
  if (typeof fixture.note !== 'string') schemaError('fixture.note 必须是字符串');
  if (!isIsoWithTimezone(fixture.oddsUpdatedAt)) {
    schemaError('fixture.oddsUpdatedAt 必须是带时区的 ISO 时间');
  }
  if (!isIsoWithTimezone(fixture.capturedAt)) {
    schemaError('fixture.capturedAt 必须是带时区的 ISO 时间');
  }
  if (!Array.isArray(fixture.matches)) schemaError('fixture.matches 必须是数组');
  if (!Array.isArray(fixture.pending)) schemaError('fixture.pending 必须是数组');
  if (fixture.unclassified !== undefined && !Array.isArray(fixture.unclassified)) {
    schemaError('fixture.unclassified 必须是数组');
  }
  if (
    fixture.totalCount !== undefined &&
    (typeof fixture.totalCount !== 'number' || !Number.isInteger(fixture.totalCount) || fixture.totalCount < 0)
  ) {
    schemaError('fixture.totalCount 必须是非负整数');
  }
  if (
    fixture.skipped !== undefined &&
    (typeof fixture.skipped !== 'number' || !Number.isInteger(fixture.skipped) || fixture.skipped < 0)
  ) {
    schemaError('fixture.skipped 必须是非负整数');
  }

  const seenNos = new Set();
  fixture.matches.forEach((match, index) => validateMatch(match, index, seenNos));
  const unclassified = fixture.unclassified ?? [];
  unclassified.forEach((item, index) => validateUnclassified(item, index, seenNos));
  validatePending(fixture.pending);

  if (fixture.totalCount !== undefined) {
    const skipped = fixture.skipped ?? 0;
    const sum = fixture.matches.length + unclassified.length + skipped;
    if (sum !== fixture.totalCount) {
      schemaError(
        `不变式不成立：matches(${fixture.matches.length}) + unclassified(${unclassified.length}) + skipped(${skipped}) = ${sum}，与 totalCount=${fixture.totalCount} 不一致`,
      );
    }
  }

  return true;
}

function currentTimestamp() {
  const override = process.env.JCZQ_NOW;
  if (override !== undefined && override !== '') {
    if (!isIsoWithTimezone(override)) {
      throw new BoardError('E_INTERNAL', `JCZQ_NOW 必须是带时区的 ISO 时间：${override}`);
    }
    return formatPlus08(override);
  }
  return formatPlus08();
}

/** 生成看板数据（不含 HTML）。 */
export function analyzeFixture(fixture) {
  validateFixture(fixture);
  const matches = fixture.matches.map((match) => classifyMatch(match));
  return {
    date: fixture.date,
    source: fixture.source,
    oddsUpdatedAt: fixture.oddsUpdatedAt,
    capturedAt: fixture.capturedAt,
    note: fixture.note,
    generatedAt: currentTimestamp(),
    matches,
    unclassified: fixture.unclassified ?? [],
    totalCount: fixture.totalCount,
    skipped: fixture.skipped ?? 0,
    likelyDraw: findLikelyDraw(matches),
    pending: fixture.pending,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function percent(probability) {
  if (typeof probability !== 'number') return '—';
  return `${(probability * 100).toFixed(2)}%`;
}

function fixedOdds(odds) {
  if (typeof odds !== 'number') return '—';
  return odds.toFixed(2);
}

function handicapText(handicapInfo) {
  if (handicapInfo.side === null) return '无让球（平手）';
  return handicapInfo.side === 'home'
    ? `主让 ${handicapInfo.goals} 球`
    : `主受让 ${handicapInfo.goals} 球`;
}

function groupItems(report, groupId) {
  if (groupId === 'likely_draw') {
    return report.likelyDraw ? report.likelyDraw.matches : [];
  }
  return report.matches.filter((match) => match.group === groupId);
}

function allIntegerOneBall(matches) {
  return (
    matches.length > 0 &&
    matches.every((match) => match.handicapInfo.isInteger && match.handicapInfo.goals === 1)
  );
}

function renderGroupSection(groupId, label, items, extraEmptyNote, drawProbability) {
  let body;
  if (items.length === 0) {
    body = '<p class="empty">本日无此类（0 场）</p>';
    if (extraEmptyNote) body += `<p class="empty">${escapeHtml(extraEmptyNote)}</p>`;
  } else {
    const list = items
      .map((match) => {
        const extra = drawProbability ? `（平局 ${percent(match.spf[1])}）` : '';
        return `<li>${escapeHtml(match.no)} ${escapeHtml(match.league)} ${escapeHtml(match.home)} VS ${escapeHtml(match.away)}${extra}</li>`;
      })
      .join('');
    body = `<ul>${list}</ul>`;
  }
  return `<section id="group-${groupId}" class="group"><h3>${label}（${items.length} 场）</h3>${body}</section>`;
}

function renderStructure(report) {
  const matches = report.matches;
  const unclassified = report.unclassified ?? [];
  const integerMatches = matches.filter((match) => match.handicapInfo.isInteger);
  const halfMatches = matches.filter((match) => !match.handicapInfo.isInteger);
  const sellingCount = matches.length + unclassified.length;
  const totalCountLine =
    report.totalCount !== undefined
      ? `<li>官方 totalCount：${escapeHtml(report.totalCount)} 场（可分类 ${matches.length} 场；数据不足 ${unclassified.length} 场；跳过 ${escapeHtml(report.skipped ?? 0)} 场）</li>`
      : '';
  const highConfidence = matches.filter((match) => match.highConfidence);
  const ambiguous = matches.filter((match) => match.group === 'ambiguous');
  const noHandicap = matches.filter((match) => match.group === 'no_handicap');

  const highList = highConfidence.length
    ? `<ul>${highConfidence
        .map(
          (match) =>
            `<li>${escapeHtml(match.no)} — ${match.highConfidence.market} ${escapeHtml(match.highConfidence.outcome)} ${percent(match.highConfidence.probability)}</li>`,
        )
        .join('')}</ul>`
    : '<p>无</p>';

  const ambiguousNos = ambiguous.length ? ambiguous.map((match) => escapeHtml(match.no)).join('、') : '无';

  return `<section id="structure"><h2>结构性判断</h2>
<ul>
<li>是否全为整数一球盘：${allIntegerOneBall(matches) ? '是' : '否'}</li>
<li>已开售场次：${sellingCount} 场（整数盘：${integerMatches.length} 场，半盘：${halfMatches.length} 场）</li>
${totalCountLine}
<li>高置信场次：${highConfidence.length} 场</li>
</ul>
${highList}
<ul>
<li>ambiguous 场次：${ambiguous.length} 场（${ambiguousNos}）</li>
<li>无让球盘场次：${noHandicap.length} 场</li>
<li>未开售（pending）：${report.pending.length} 条</li>
</ul></section>`;
}

function renderMatch(match) {
  const supportLine = match.support
    ? `<dt>人气支持（非赔率概率）</dt><dd>SPF ${match.support.spf.map((value) => `${escapeHtml(value)}%`).join(' / ')}；RQSPF ${match.support.rqspf.map((value) => `${escapeHtml(value)}%`).join(' / ')}</dd>`
    : '';
  const highConfidenceLine = match.highConfidence
    ? `是（${match.highConfidence.market} ${escapeHtml(match.highConfidence.outcome)} ${percent(match.highConfidence.probability)}）`
    : '否';

  return `<article class="match">
<h3>${escapeHtml(match.no)} · ${escapeHtml(match.league)}</h3>
<dl>
<dt>开赛时间</dt><dd>${escapeHtml(match.kickoff)}</dd>
<dt>对阵</dt><dd>${escapeHtml(match.home)} VS ${escapeHtml(match.away)}</dd>
<dt>让球</dt><dd>${escapeHtml(handicapText(match.handicapInfo))}</dd>
<dt>SPF 赔率</dt><dd>${match.spfOdds.map(fixedOdds).join(' / ')}</dd>
<dt>RQSPF 赔率</dt><dd>${match.rqspfOdds.map(fixedOdds).join(' / ')}</dd>
<dt>SPF 去水概率</dt><dd>${match.spf.map(percent).join(' / ')}</dd>
<dt>RQSPF 去水概率</dt><dd>${match.rqspf.map(percent).join(' / ')}</dd>
<dt>SPF 最大项</dt><dd>${match.spfTop.labels.map(escapeHtml).join(' / ')}（${percent(match.spfTop.probability)}）</dd>
<dt>分组</dt><dd>${escapeHtml(GROUP_LABELS[match.group])}</dd>
<dt>判定理由</dt><dd>${escapeHtml(match.reason)}</dd>
<dt>高置信</dt><dd>${highConfidenceLine}</dd>
${supportLine}
</dl>
</article>`;
}

function renderPending(report) {
  if (report.pending.length === 0) {
    return '<section id="pending"><h2>未开售场次</h2><p>无</p></section>';
  }
  const rows = report.pending
    .map((item) => {
      const cells = [
        escapeHtml(item.no),
        escapeHtml(item.league ?? '—'),
        escapeHtml(item.match ?? '对阵未列出'),
        escapeHtml(item.kickoff ?? '开赛时间未列出'),
        escapeHtml(item.note ?? ''),
      ];
      return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
    })
    .join('');
  return `<section id="pending"><h2>未开售场次（pending，原样展示，不推断）</h2>
<table>
<thead><tr><th>编号</th><th>联赛</th><th>对阵</th><th>开赛时间</th><th>备注</th></tr></thead>
<tbody>${rows}</tbody>
</table></section>`;
}

function unclassifiedHandicapText(handicap) {
  if (handicap === null || handicap === undefined) return MISSING_CELL;
  if (handicap === 0) return '无让球（平手）';
  return handicap < 0 ? `主让 ${Math.abs(handicap)} 球` : `主受让 ${handicap} 球`;
}

function unclassifiedOddsText(odds) {
  if (!Array.isArray(odds)) return MISSING_CELL;
  return odds.map(fixedOdds).join(' / ');
}

/** 数据不足（未分类）：官方未开售单一市场，不参与任何分类或推断。 */
function renderUnclassified(report) {
  const items = report.unclassified ?? [];
  if (items.length === 0) {
    return '<section id="unclassified"><h2>数据不足（未分类）</h2><p class="empty">本日无此类（0 场）</p></section>';
  }
  const rows = items
    .map((item) => {
      const cells = [
        escapeHtml(item.no),
        escapeHtml(item.league),
        `${escapeHtml(item.home)} VS ${escapeHtml(item.away)}`,
        escapeHtml(item.kickoff),
        escapeHtml(unclassifiedHandicapText(item.handicap)),
        escapeHtml(unclassifiedOddsText(item.spf)),
        escapeHtml(unclassifiedOddsText(item.rqspf)),
        escapeHtml(item.note ?? ''),
      ];
      return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
    })
    .join('');
  return `<section id="unclassified"><h2>数据不足（未分类）</h2>
<table>
<thead><tr><th>编号</th><th>联赛</th><th>对阵</th><th>开赛时间</th><th>让球</th><th>SPF</th><th>RQSPF</th><th>说明</th></tr></thead>
<tbody>${rows}</tbody>
</table></section>`;
}

/** 渲染单文件 HTML；所有动态文本均转义，无外链。 */
export function renderHtml(report) {
  const onlyIntegerOneBall = allIntegerOneBall(report.matches);
  const mergedGroups = FOUR_GROUPS.map(([groupId, label]) =>
    renderGroupSection(
      groupId,
      label,
      groupItems(report, groupId),
      groupId === 'lose_cover' && onlyIntegerOneBall ? LOSE_COVER_EMPTY_NOTE : null,
      false,
    ),
  ).join('');

  const likelyDrawItems = groupItems(report, 'likely_draw');
  const likelyDrawSection = renderGroupSection(
    'likely_draw',
    '可能平局',
    likelyDrawItems,
    null,
    true,
  );

  const matchSections = report.matches.map((match) => renderMatch(match)).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>竞彩足球盘口看板 · ${escapeHtml(report.date)}</title>
<style>
body { margin: 0; background: #f5f6f8; color: #1f2328; font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; line-height: 1.6; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.6rem; margin: 0 0 8px; }
h2 { font-size: 1.15rem; margin: 0 0 12px; }
h3 { font-size: 1rem; margin: 18px 0 8px; }
section { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px 20px; margin: 16px 0; }
ul { margin: 8px 0; padding-left: 22px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dt { color: #57606a; }
dd { margin: 0; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top; }
.empty { color: #8c959f; }
.match { border-top: 1px solid #eaeef2; padding-top: 4px; }
.match:first-child { border-top: none; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.note { color: #57606a; font-size: 0.92rem; }
</style>
</head>
<body>
<main>
<h1>竞彩足球盘口看板 · ${escapeHtml(report.date)}</h1>
<section id="snapshot"><h2>数据快照</h2>
<ul>
<li>抓取时间 capturedAt：${escapeHtml(report.capturedAt)}</li>
<li>生成时间 generatedAt：${escapeHtml(report.generatedAt)}</li>
<li>官方赔率更新时间 oddsUpdatedAt：${escapeHtml(report.oddsUpdatedAt)}</li>
<li>来源 source：<span class="mono">${escapeHtml(report.source)}</span></li>
<li>备注 note：${escapeHtml(report.note)}</li>
</ul></section>
${renderStructure(report)}
<section id="groups"><h2>五类分组</h2>
${mergedGroups}
${likelyDrawSection}
</section>
${renderUnclassified(report)}
<section id="matches"><h2>逐场明细</h2>
${matchSections || '<p>无已开售场次</p>'}
</section>
${renderPending(report)}
<section id="limits"><h2>口径限制</h2>
<ul>
<li>只有官方已开售场次才有赔率；未开售场次无赔率，本看板不推断、不补造。</li>
<li>「五类分组」与「可能平局」只统计 SPF、RQSPF 均已开售且可分类的场次；官方未开售单一市场的场次列入「数据不足（未分类）」，不参与分组、可能平局与任何推断。</li>
${report.unclassified.length ? `<li>本日数据不足（未分类）场次：${report.unclassified.map((item) => escapeHtml(item.no)).join('、')}；官方未开售的市场没有赔率，不推断、不补造。</li>` : ''}
<li>已定稿口径覆盖整数一球盘与半盘；整数 |h|≥2 的口径未定义，校验阶段直接拒绝。</li>
<li>去水概率是赔率隐含概率，不含其它信息，不构成赛果预测。</li>
<li>support 人气数据不是赔率概率，只原样展示，不参与任何计算、排序或分组。</li>
<li>显示统一保留 2 位小数，各项相加不保证恰好等于 100%。</li>
</ul></section>
<section id="method"><h2>方法论</h2>
<ul>
<li>去水公式：p_i = (1/odds_i) / Σ(1/odds_j)。</li>
<li>SPF 与 RQSPF 各自独立归一化，不混合计算。</li>
<li>handicap 负=主队让球，正=主队受让；spf=[主胜,平,客胜]，rqspf=[让球主胜,让球平,让球客胜]。</li>
<li>并列判定与大小比较使用未舍入值，容差 EPS = ${EPS}。</li>
<li>高置信：两市场所有去水概率的未舍入最大值 ≥ ${HIGH_CONFIDENCE_THRESHOLD.toFixed(2)}。</li>
<li>页面百分比使用 (p * 100).toFixed(2) + "%"，赔率保留 2 位小数。</li>
</ul></section>
<section id="disclaimer"><h2>免责声明</h2>
<p>本看板仅用于赔率数据整理与技术演示，不构成投注建议，也不保证任何赛果。未满 18 周岁禁止购彩。请理性对待，遵守当地法律法规。</p>
</section>
</main>
</body>
</html>
`;
}

/** 解析 CLI 参数；非法时抛 BoardError(E_USAGE)。 */
export function parseArgs(argv) {
  if (!Array.isArray(argv)) usageError('参数必须是数组');

  const seen = new Set();
  const mark = (key) => {
    if (seen.has(key)) usageError(`参数 --${key} 重复`);
    seen.add(key);
  };

  let fixture;
  let date;
  let out;
  let live = false;
  let help = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      mark('help');
      help = true;
    } else if (arg === '--live') {
      mark('live');
      live = true;
    } else if (arg === '--dry-run') {
      mark('dry-run');
      dryRun = true;
    } else if (arg === '--fixture' || arg === '--date' || arg === '--out') {
      const key = arg.slice(2);
      mark(key);
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        usageError(`参数 ${arg} 缺少值`);
      }
      index += 1;
      if (key === 'fixture') fixture = value;
      else if (key === 'date') date = value;
      else out = value;
    } else if (arg.startsWith('-')) {
      usageError(`未知参数：${arg}`);
    } else {
      usageError(`不支持位置参数：${arg}`);
    }
  }

  const modes = [
    help && 'help',
    live && 'live',
    fixture !== undefined && 'fixture',
    date !== undefined && 'date',
  ].filter(Boolean);

  if (modes.length === 0) usageError('缺少模式：需要 --date、--fixture 或 --live 之一');
  if (modes.length > 1) usageError('--date、--fixture、--live、--help 不能同时使用（必须恰好一种模式）');
  if (help) {
    if (dryRun || out !== undefined) usageError('--help 不能与 --dry-run 或 --out 同时使用');
    return { mode: 'help' };
  }
  if (dryRun && out !== undefined) usageError('--dry-run 与 --out 不能同时使用');

  let result;
  if (live) {
    result = { mode: 'live' };
  } else if (date !== undefined) {
    if (!isIsoDate(date)) usageError(`--date 非法：${date}（需要合法的 YYYY-MM-DD）`);
    result = { mode: 'date', date };
  } else {
    result = { mode: 'fixture', fixture };
  }
  if (dryRun) result.dryRun = true;
  if (out !== undefined) result.out = out;
  return result;
}

function readFixtureFile(absolutePath) {
  if (!existsSync(absolutePath)) {
    throw new BoardError('E_FIXTURE_NOT_FOUND', `找不到 fixture 文件：${absolutePath}`);
  }
  let text;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new BoardError('E_FIXTURE_NOT_FOUND', `无法读取 fixture 文件：${absolutePath}（${error.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BoardError('E_FIXTURE_JSON', `fixture JSON 非法：${absolutePath}（${error.message}）`);
  }
}

/**
 * 把官方 JSON 接口响应映射为 fixture schema。纯函数，便于离线单测。
 * 结构不符或赔率缺失一律抛 BoardError(E_LIVE_FETCH)，不静默降级到 fixture。
 */
export function mapLiveResponse(apiJson, { capturedAt, now, source = DEFAULT_LIVE_URL } = {}) {
  const fail = (detail) => {
    throw new BoardError('E_LIVE_FETCH', `实时数据解析失败（${source}）：${detail}`);
  };

  if (!isPlainObject(apiJson)) fail('响应不是 JSON 对象');
  if (apiJson.success !== true) {
    const detail = apiJson.errorMessage ? `，errorMessage=${apiJson.errorMessage}` : '';
    fail(`接口 success 不为 true（success=${JSON.stringify(apiJson.success)}${detail}）`);
  }
  const value = apiJson.value;
  if (!isPlainObject(value)) fail('响应缺少 value 对象');
  if (!Array.isArray(value.matchInfoList)) fail('响应缺少 value.matchInfoList 数组');
  if (!isNonEmptyString(value.lastUpdateTime)) fail('响应缺少 value.lastUpdateTime');

  const oddsUpdatedAt = `${value.lastUpdateTime.trim().replace(' ', 'T')}+08:00`;
  if (!isIsoWithTimezone(oddsUpdatedAt)) {
    fail(`value.lastUpdateTime 无法转为带时区 ISO 时间（${value.lastUpdateTime}）`);
  }

  const capturedInput = capturedAt ?? now;
  let captured;
  if (capturedInput === undefined) {
    captured = currentTimestamp();
  } else {
    if (!isIsoWithTimezone(capturedInput)) fail(`capturedAt 必须是带时区的 ISO 时间（${capturedInput}）`);
    captured = formatPlus08(capturedInput);
  }

  const matches = [];
  const unclassified = [];
  let skipped = 0;
  let date;

  value.matchInfoList.forEach((group, groupIndex) => {
    const groupWhere = `matchInfoList[${groupIndex}]`;
    if (!isPlainObject(group)) fail(`${groupWhere} 必须是对象`);
    if (!Array.isArray(group.subMatchList)) fail(`${groupWhere} 缺少 subMatchList 数组`);
    if (date === undefined && isIsoDate(group.businessDate)) date = group.businessDate;

    group.subMatchList.forEach((sub, subIndex) => {
      const where = isPlainObject(sub) && isNonEmptyString(sub.matchNumStr)
        ? `场次 ${sub.matchNumStr}`
        : `${groupWhere}.subMatchList[${subIndex}]`;
      if (!isPlainObject(sub)) fail(`${where} 必须是对象`);

      // 非开售/隐藏场次不计入已开售，也不补造赔率。
      if ((sub.matchStatus !== undefined && sub.matchStatus !== 'Selling') || sub.isHide === 1 || sub.isHide === true) {
        skipped += 1;
        return;
      }

      for (const field of ['matchNumStr', 'leagueAbbName', 'homeTeamAbbName', 'awayTeamAbbName']) {
        if (!isNonEmptyString(sub[field])) fail(`${where} 缺少 ${field}`);
      }
      if (!isIsoDate(sub.matchDate)) fail(`${where} 缺少合法的 matchDate`);
      if (!isNonEmptyString(sub.matchTime) || !/^\d{2}:\d{2}:\d{2}$/.test(sub.matchTime)) {
        fail(`${where} 缺少合法的 matchTime`);
      }

      // 市场三种状态：三项齐全 → 数组；三项都不可用 → null；
      // 只有 1–2 项可用或市场键缺失 → E_LIVE_FETCH（不猜、不补造）。
      const readMarket = (object, field) => {
        if (object === undefined || !isPlainObject(object)) fail(`${where} 缺少 ${field} 赔率对象`);
        const values = ['h', 'd', 'a'].map((key) => {
          const raw = object[key];
          if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
          const number = typeof raw === 'string' ? Number(raw) : raw;
          return typeof number === 'number' && Number.isFinite(number) && number > 1 ? number : null;
        });
        const available = values.filter((value) => value !== null).length;
        if (available === 3) return values;
        if (available === 0) return null;
        fail(`${where} 字段 ${field} 赔率不完整（只有 ${available} 项可用，需三项齐全或全部未开售）`);
      };

      const spf = readMarket(sub.had, 'had');
      const rqspf = readMarket(sub.hhad, 'hhad');
      if (spf === null && rqspf === null) fail(`${where} had 与 hhad 两个市场均不可用，无法分类`);

      let handicap = null;
      if (rqspf !== null) {
        const goalLine = sub.hhad.goalLine;
        handicap = typeof goalLine === 'string' && goalLine.trim() !== '' ? Number(goalLine) : Number.NaN;
        if (!Number.isFinite(handicap)) fail(`${where} 字段 hhad.goalLine 非法（${JSON.stringify(goalLine)}）`);
      }

      const kickoff = `${sub.matchDate}T${sub.matchTime}+08:00`;
      if (!isIsoWithTimezone(kickoff)) fail(`${where} matchDate/matchTime 拼不出合法的带时区开赛时间`);

      const base = {
        no: sub.matchNumStr,
        league: sub.leagueAbbName,
        kickoff,
        home: sub.homeTeamAbbName,
        away: sub.awayTeamAbbName,
      };

      if (spf !== null && rqspf !== null) {
        matches.push({ ...base, handicap, spf, rqspf });
      } else {
        const missingMarket = spf === null ? 'SPF（had）' : 'RQSPF（hhad）';
        unclassified.push({
          ...base,
          handicap,
          spf,
          rqspf,
          note: `官方未开售 ${missingMarket}，本场不参与五类分组与可能平局推断。`,
        });
      }
    });
  });

  if (date === undefined) {
    const fallback = value.lastUpdateTime.slice(0, 10);
    if (isIsoDate(fallback)) date = fallback;
  }
  if (date === undefined) fail('无法从响应确定比赛日期（businessDate）');

  const hasTotalCount =
    value.totalCount !== undefined && value.totalCount !== null && Number.isFinite(Number(value.totalCount));
  const totalCount = hasTotalCount ? Number(value.totalCount) : undefined;

  if (matches.length + unclassified.length === 0) {
    fail(`响应中没有任何可用的已开售场次（totalCount=${totalCount ?? '未知'}）`);
  }
  if (totalCount !== undefined && matches.length + unclassified.length + skipped !== totalCount) {
    const sum = matches.length + unclassified.length + skipped;
    fail(
      `totalCount 不变式不成立：matches(${matches.length}) + unclassified(${unclassified.length}) + skipped(${skipped}) = ${sum}，与 totalCount=${totalCount} 不一致`,
    );
  }

  const totalLabel = totalCount ?? matches.length + unclassified.length;
  let note = `本次报告来自 --live 实时抓取（官方 JSON 接口）；实时接口返回 totalCount=${totalLabel}，未提供未开售场次，本看板不推断`;
  if (skipped > 0) note += `；另有 ${skipped} 场非开售/隐藏场次已跳过，未补造数据`;
  if (unclassified.length > 0) {
    note += `；另有 ${unclassified.length} 场因官方未开售单一市场无法分类，仅列入「数据不足」，不推断`;
  }

  const fixture = {
    date,
    source,
    oddsUpdatedAt,
    capturedAt: captured,
    note,
    matches,
    unclassified,
    skipped,
    pending: [],
  };
  if (totalCount !== undefined) fixture.totalCount = totalCount;
  return fixture;
}

/**
 * --live 抓取官方 JSON 接口并映射为 fixture。网络调用只存在于本函数内，
 * 其余代码路径绝不联网；失败一律抛 BoardError(E_LIVE_FETCH)，不降级到 fixture。
 */
async function loadLiveFixture() {
  const url = process.env.JCZQ_LIVE_URL || DEFAULT_LIVE_URL;
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: LIVE_HEADERS,
    });
  } catch (error) {
    throw new BoardError('E_LIVE_FETCH', `实时数据抓取失败（${url}）：${error.message}`);
  }
  if (!response.ok) {
    throw new BoardError('E_LIVE_FETCH', `实时数据抓取失败（${url}）：HTTP ${response.status}`);
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new BoardError('E_LIVE_FETCH', `实时数据读取失败（${url}）：${error.message}`);
  }

  let apiJson;
  try {
    apiJson = JSON.parse(text);
  } catch {
    throw new BoardError('E_LIVE_FETCH', `实时数据解析失败（${url}）：响应不是 JSON`);
  }

  return {
    fixture: mapLiveResponse(apiJson, { capturedAt: currentTimestamp(), source: url }),
    rawText: text,
  };
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.mode === 'help') {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  let fixture;
  let outputDate;
  let liveRawText;
  if (args.mode === 'live') {
    const loaded = await loadLiveFixture();
    fixture = loaded.fixture;
    liveRawText = loaded.rawText;
    validateFixture(fixture);
    outputDate = fixture.date;
  } else if (args.mode === 'date') {
    fixture = readFixtureFile(path.join(REPO_ROOT, 'fixtures', `${args.date}.json`));
    validateFixture(fixture, { date: args.date });
    outputDate = args.date;
  } else {
    fixture = readFixtureFile(path.resolve(REPO_ROOT, args.fixture));
    validateFixture(fixture);
    outputDate = fixture.date;
  }

  const report = analyzeFixture(fixture);
  const html = renderHtml(report);

  // 顺序：解析 → 映射 → validate → 渲染 → 写快照 → 写报告。
  // 快照保留官方响应原文；写快照失败则不写报告。
  if (liveRawText !== undefined) {
    const snapshotPath = path.join(REPO_ROOT, 'fixtures', `${outputDate}.live-raw.json`);
    try {
      mkdirSync(path.dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, liveRawText, 'utf8');
    } catch (error) {
      throw new BoardError('E_INTERNAL', `写快照失败：${snapshotPath}（${error.message}）`);
    }
  }

  const outputPath = path.join(REPO_ROOT, 'reports', `${outputDate}.html`);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, 'utf8');
  process.stdout.write(`已生成报告：${outputPath}\n`);
  return 0;
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === __filename;
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const code = error instanceof BoardError ? (EXIT_CODES[error.code] ?? 1) : 1;
      const token = error instanceof BoardError ? error.code : 'E_INTERNAL';
      process.stderr.write(`[${token}] ${error.message}\n`);
      process.exitCode = code;
    },
  );
}
