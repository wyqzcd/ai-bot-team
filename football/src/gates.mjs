/**
 * 8 道机械门禁：任一 ERROR 即阻断发布（publish.mjs 不写任何文件，退出码 1）。
 *
 *   G1 结构完整性  每条字段齐全、类型正确、字段序与规范一致、seq 从 1 连续
 *   G2 哈希链      prev/hash 逐条可复算；已发布锚点（published.json）记录的前缀不得被改写
 *   G3 概率量化    概率在 [0,1]、三项和≈1、pick 是最大项、conf=probs[pick]、档位和≈1、TOP3 有序
 *   G4 开赛锁定    预测必须早于开赛；赛果不得早于开赛 + 105 分钟；有赛果后不得再预测；同场改判必须先赛前撤回
 *   G5 覆盖率      回测：样本库窗口内每场都有预测和赛果（不许挑场）；实盘：开赛超 72h 仍无赛果即阻断
 *   G6 规则登记    active 规则三要素齐全；撤回必须留痕；候选规则只警告
 *   G7 复算一致    active 规则的 claim 现场复算，rate 误差 ≤ 0.0005 且 n 一致
 *   G8 数据质量    样本库指纹、队名分裂、行级校验、新鲜度（见 quality.mjs）
 */
import { existsSync, readFileSync } from 'node:fs';
import { FIELD_ORDER, GENESIS, PICKS, foldLedger, hashEntry } from './ledger.mjs';
import { checkDataQuality } from './quality.mjs';
import { checkRegistry } from './rules.mjs';

const MAX_LISTED = 20;
export const RESULT_GRACE_HOURS = 72;
/** 常规时间 90 分钟 + 中场 15 分钟：早于开赛 + 105 分钟的赛果不可能是完场比分。 */
export const MIN_RESULT_MINUTES = 105;
export const MODES = ['backtest', 'live'];

const isIso = (value) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
const isProb = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isGoals = (value) => Array.isArray(value) && value.length === 2 && value.every((g) => Number.isInteger(g) && g >= 0 && g <= 30);

function gate(id, name) {
  const errors = [];
  const warnings = [];
  return {
    id,
    name,
    errors,
    warnings,
    error: (message) => errors.push(message),
    warn: (message) => warnings.push(message),
    done() {
      const total = errors.length;
      return { id, name, ok: total === 0, errorCount: total, errors: errors.slice(0, MAX_LISTED), warnings: warnings.slice(0, MAX_LISTED) };
    },
  };
}

function eventTime(entry) {
  return entry.type === 'result' ? entry.recordedAt : entry.createdAt;
}

export function g1Structure(entries, label) {
  const g = gate('G1', '结构完整性');
  entries.forEach((entry, index) => {
    const at = `${label}#${index + 1}`;
    const order = FIELD_ORDER[entry?.type];
    if (!order) {
      g.error(`${at}: 未知 type=${entry?.type}`);
      return;
    }
    const keys = Object.keys(entry);
    if (keys.join(',') !== order.join(',')) g.error(`${at}: 字段/字段序不符，期望 ${order.join(',')}`);
    if (entry.seq !== index + 1) g.error(`${at}: seq=${entry.seq}，应为 ${index + 1}（不得跳号/插入）`);
    if (typeof entry.id !== 'string' || entry.id === '') g.error(`${at}: id 为空`);
    if (entry.type === 'prediction') {
      for (const key of ['league', 'home', 'away', 'model']) if (typeof entry[key] !== 'string' || entry[key] === '') g.error(`${at}: ${key} 为空`);
      if (!isIso(entry.kickoff) || !isIso(entry.createdAt)) g.error(`${at}: kickoff/createdAt 必须是带时区 ISO`);
      if (!MODES.includes(entry.mode)) g.error(`${at}: mode 必须是 ${MODES.join('/')}`);
      if (!Array.isArray(entry.probs) || entry.probs.length !== 3) g.error(`${at}: probs 必须是 3 项`);
      if (!Array.isArray(entry.lam) || entry.lam.length !== 2) g.error(`${at}: lam 必须是 [λ主, λ客]`);
      if (!Array.isArray(entry.totals) || entry.totals.length !== 3) g.error(`${at}: totals 必须是 3 档`);
      if (!Array.isArray(entry.top3) || entry.top3.length !== 3) g.error(`${at}: top3 必须是 3 个比分`);
      if (!PICKS.includes(entry.pick)) g.error(`${at}: pick 必须是 h/d/a`);
      if (typeof entry.known !== 'boolean') g.error(`${at}: known 必须是布尔`);
      if (entry.market !== null && !(Array.isArray(entry.market) && entry.market.length === 3 && entry.market.every((o) => typeof o === 'number' && o > 1))) {
        g.error(`${at}: market 必须是 null 或 3 个 > 1 的赔率`);
      }
    } else if (entry.type === 'result') {
      if (!isGoals(entry.ft)) g.error(`${at}: ft 必须是 [主, 客] 非负整数`);
      if (entry.ht !== null && !isGoals(entry.ht)) g.error(`${at}: ht 必须是 null 或 [主, 客]`);
      if (!isIso(entry.recordedAt)) g.error(`${at}: recordedAt 必须是带时区 ISO`);
      if (typeof entry.source !== 'string' || entry.source === '') g.error(`${at}: source 为空`);
    } else if (entry.type === 'retraction') {
      if (!Number.isInteger(entry.target)) g.error(`${at}: target 必须是被撤回条目的 seq`);
      if (typeof entry.reason !== 'string' || entry.reason.trim().length < 4) g.error(`${at}: 撤回必须写明原因（≥4 字）`);
      if (!isIso(entry.createdAt)) g.error(`${at}: createdAt 必须是带时区 ISO`);
    }
  });
  return g.done();
}

/** anchor: { entries, lastHash } —— 上次发布时的台账长度与末条 hash */
export function g2HashChain(entries, label, anchor = null) {
  const g = gate('G2', '哈希链');
  let prev = GENESIS;
  entries.forEach((entry, index) => {
    const at = `${label}#${index + 1}`;
    if (entry.prev !== prev) g.error(`${at}: prev 断链（期望 ${prev}，实际 ${entry.prev}）`);
    let expected = null;
    try {
      expected = hashEntry(entry);
    } catch (error) {
      g.error(`${at}: 无法计算 hash（${error.message}）`);
    }
    if (expected !== null && entry.hash !== expected) g.error(`${at}: hash 不符，条目被改写过（期望 ${expected}）`);
    prev = entry.hash;
  });
  if (anchor) {
    if (entries.length < anchor.entries) g.error(`${label}: 已发布 ${anchor.entries} 条，现在只有 ${entries.length} 条（台账被截断）`);
    else if (anchor.entries > 0 && entries[anchor.entries - 1].hash !== anchor.lastHash) {
      g.error(`${label}: 第 ${anchor.entries} 条 hash 与发布锚点 ${anchor.lastHash} 不符（已发布内容被改写）`);
    }
  }
  return g.done();
}

export function g3Probability(entries, label) {
  const g = gate('G3', '概率量化');
  for (const entry of entries) {
    if (entry.type !== 'prediction') continue;
    const at = `${label}#${entry.seq}`;
    const { probs, totals, top3, lam } = entry;
    if (!Array.isArray(probs) || !probs.every(isProb)) {
      g.error(`${at}: probs 越界`);
      continue;
    }
    const sum = probs.reduce((s, p) => s + p, 0);
    if (Math.abs(sum - 1) > 1e-3) g.error(`${at}: 方向概率和 ${sum.toFixed(4)} ≠ 1`);
    const max = Math.max(...probs);
    const index = PICKS.indexOf(entry.pick);
    if (index === -1 || probs[index] < max - 1e-4) g.error(`${at}: pick=${entry.pick} 不是概率最大项`);
    else if (Math.abs(entry.conf - probs[index]) > 1e-9) g.error(`${at}: conf ≠ probs[pick]`);
    if (!Array.isArray(totals) || !totals.every(isProb) || Math.abs(totals.reduce((s, p) => s + p, 0) - 1) > 1e-3) g.error(`${at}: 总进球档位概率非法或和 ≠ 1`);
    if (!isProb(entry.over25)) g.error(`${at}: over25 越界`);
    if (!Array.isArray(lam) || !lam.every((l) => typeof l === 'number' && Number.isFinite(l) && l > 0 && l < 10)) g.error(`${at}: λ 必须在 (0, 10)`);
    if (Array.isArray(top3)) {
      const ok = top3.every((item, i) => Array.isArray(item) && /^\d+-\d+$/.test(item[0]) && isProb(item[1]) && (i === 0 || item[1] <= top3[i - 1][1]));
      if (!ok) g.error(`${at}: top3 比分格式非法或未按概率降序`);
    }
  }
  return g.done();
}

export function g4Lock(entries, label) {
  const g = gate('G4', '开赛锁定');
  const bySeq = new Map();
  const resulted = new Set();
  const active = new Map();
  const retracted = new Set();
  let lastTime = -Infinity;
  for (const entry of entries) {
    const at = `${label}#${entry.seq}`;
    bySeq.set(entry.seq, entry);
    const t = Date.parse(eventTime(entry));
    if (t < lastTime) g.error(`${at}: 时间 ${eventTime(entry)} 早于上一条，疑似补录倒签`);
    lastTime = Math.max(lastTime, t);
    if (entry.type === 'prediction') {
      if (!(Date.parse(entry.createdAt) < Date.parse(entry.kickoff))) g.error(`${at}: 预测时间 ${entry.createdAt} 不早于开赛 ${entry.kickoff}`);
      if (resulted.has(entry.id)) g.error(`${at}: ${entry.id} 已有赛果，禁止再预测/改判`);
      if (active.has(entry.id)) g.error(`${at}: ${entry.id} 已有有效预测 #${active.get(entry.id)}，改判须先赛前撤回`);
      active.set(entry.id, entry.seq);
    } else if (entry.type === 'result') {
      const prediction = active.get(entry.id) ? bySeq.get(active.get(entry.id)) : null;
      if (resulted.has(entry.id)) g.error(`${at}: ${entry.id} 赛果重复入账（更正须走撤回）`);
      if (prediction && Date.parse(entry.recordedAt) < Date.parse(prediction.kickoff) + MIN_RESULT_MINUTES * 60000) {
        g.error(`${at}: 赛果记录时间早于开赛 + ${MIN_RESULT_MINUTES} 分钟，不可能是完场比分`);
      }
      resulted.add(entry.id);
    } else if (entry.type === 'retraction') {
      const target = bySeq.get(entry.target);
      if (!target || target.type !== 'prediction') {
        g.error(`${at}: 撤回目标 #${entry.target} 不存在或不是预测`);
        continue;
      }
      if (target.id !== entry.id) g.error(`${at}: 撤回 id 与目标预测不一致`);
      if (retracted.has(entry.target)) g.error(`${at}: #${entry.target} 重复撤回`);
      retracted.add(entry.target);
      const beforeKickoff = Date.parse(entry.createdAt) < Date.parse(target.kickoff);
      if (beforeKickoff && active.get(target.id) === target.seq) active.delete(target.id);
      if (!beforeKickoff) g.warn(`${at}: 开赛后撤回 #${entry.target}，只留痕，仍计入命中率`);
    }
  }
  return g.done();
}

/**
 * expected: 回测时传入样本库中应覆盖的比赛 id 集合；now: 实盘判断赛果是否逾期。
 */
export function g5Coverage(entries, label, { expectedIds = null, now = null } = {}) {
  const g = gate('G5', '覆盖率');
  const folded = foldLedger(entries);
  const predicted = new Set(folded.filter((item) => item.prediction).map((item) => item.id));
  if (expectedIds) {
    let missing = 0;
    for (const id of expectedIds) {
      if (!predicted.has(id)) {
        missing += 1;
        if (missing <= MAX_LISTED) g.error(`${label}: 样本库比赛 ${id} 没有预测（不允许挑场）`);
      }
    }
    if (missing > MAX_LISTED) g.error(`${label}: 另有 ${missing - MAX_LISTED} 场缺预测`);
    for (const id of predicted) if (!expectedIds.has(id)) g.error(`${label}: 预测 ${id} 不在样本库窗口内`);
  }
  const nowMs = now ? Date.parse(now) : null;
  for (const item of folded) {
    if (!item.prediction || item.result) continue;
    const overdue = nowMs !== null && nowMs - Date.parse(item.prediction.kickoff) > RESULT_GRACE_HOURS * 3600 * 1000;
    if (item.prediction.mode === 'backtest') g.error(`${label}: 回测预测 ${item.id} 没有赛果`);
    else if (overdue) g.error(`${label}: ${item.id} 开赛已超 ${RESULT_GRACE_HOURS}h 仍未录赛果（错的也必须入账）`);
  }
  for (const item of folded) if (item.result && !item.prediction && item.voided.length === 0) g.warn(`${label}: ${item.id} 有赛果但没有预测`);
  return g.done();
}

export function g6Registry(registry) {
  const g = gate('G6', '规则登记');
  const report = checkRegistry(registry, { recompute: false });
  report.errors.forEach(g.error);
  report.warnings.forEach(g.warn);
  return g.done();
}

export function g7Recompute(registry) {
  const g = gate('G7', '复算一致');
  const report = checkRegistry(registry, { recompute: true });
  report.recomputeErrors.forEach(g.error);
  return { ...g.done(), rules: report.rules.filter((rule) => rule.recomputed).map((rule) => ({ id: rule.id, rate: rule.recomputed.rate, n: rule.recomputed.n })) };
}

export function readAnchor(file) {
  if (!file || !existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * @param {object} input
 * @param {Array<{label, entries, expectedIds?}>} input.ledgers
 * @param {object} input.registry
 * @param {object} input.anchors label → {entries,lastHash}
 * @param {string} input.now
 */
export function g8DataQuality(options) {
  const g = gate('G8', '数据质量');
  const report = checkDataQuality(options);
  report.errors.forEach(g.error);
  report.warnings.forEach(g.warn);
  return { ...g.done(), errorCount: report.errorCount };
}

export function runGates({ ledgers, registry, anchors = {}, now, dataQuality = {} }) {
  const merge = (id, name, parts) => {
    const errors = parts.flatMap((p) => p.errors);
    return { id, name, ok: parts.every((p) => p.ok), errorCount: parts.reduce((s, p) => s + p.errorCount, 0), errors: errors.slice(0, MAX_LISTED), warnings: parts.flatMap((p) => p.warnings).slice(0, MAX_LISTED) };
  };
  const results = [
    merge('G1', '结构完整性', ledgers.map((l) => g1Structure(l.entries, l.label))),
    merge('G2', '哈希链', ledgers.map((l) => g2HashChain(l.entries, l.label, anchors[l.label] ?? null))),
    merge('G3', '概率量化', ledgers.map((l) => g3Probability(l.entries, l.label))),
    merge('G4', '开赛锁定', ledgers.map((l) => g4Lock(l.entries, l.label))),
    merge('G5', '覆盖率', ledgers.map((l) => g5Coverage(l.entries, l.label, { expectedIds: l.expectedIds ?? null, now }))),
    g6Registry(registry),
    g7Recompute(registry),
    g8DataQuality({ ...dataQuality, now }),
  ];
  return { ok: results.every((r) => r.ok), gates: results };
}
