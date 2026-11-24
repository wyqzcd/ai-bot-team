/**
 * 规则登记：凡是声称"某档命中率 X%"的规则，必须同时登记
 *   definition（文字口径） + sample（台账 + 过滤器） + recompute（复算命令）
 * 三要素缺一，有效状态强制降为 candidate；candidate 不能当门禁、不能在发布页当结论展示。
 * active 规则的 claim 必须能被复算重现（rate 误差 ≤ 0.0005 且 n 完全一致）。
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { FOOTBALL_ROOT } from './dataset.mjs';
import { readLedger } from './ledger.mjs';
import { METRICS, computeStats } from './metrics.mjs';

export const DEFAULT_REGISTRY = path.join(FOOTBALL_ROOT, 'rules', 'registry.json');
export const STATUSES = ['active', 'candidate', 'retracted'];
export const RATE_TOLERANCE = 0.0005;

export function loadRegistry(file = DEFAULT_REGISTRY) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function missingElements(rule) {
  const missing = [];
  if (typeof rule.definition !== 'string' || rule.definition.trim() === '') missing.push('definition');
  if (!rule.sample || typeof rule.sample.ledger !== 'string' || typeof rule.sample.filter !== 'object' || rule.sample.filter === null) missing.push('sample');
  if (typeof rule.recompute !== 'string' || rule.recompute.trim() === '') missing.push('recompute');
  return missing;
}

/** 有效状态：声明 active 但三要素不全 → candidate；撤回的永远是 retracted。 */
export function effectiveStatus(rule) {
  if (rule.status === 'retracted') return 'retracted';
  if (missingElements(rule).length) return 'candidate';
  if (!rule.claim || typeof rule.claim.rate !== 'number' || !Number.isInteger(rule.claim.n)) return 'candidate';
  return rule.status === 'active' ? 'active' : 'candidate';
}

const ledgerCache = new Map();
function ledgerFor(rule) {
  const file = path.resolve(FOOTBALL_ROOT, rule.sample.ledger);
  const key = existsSync(file) ? `${file}|${statSync(file).mtimeMs}|${statSync(file).size}` : `${file}|missing`;
  if (!ledgerCache.has(key)) ledgerCache.set(key, readLedger(file));
  return ledgerCache.get(key);
}

export function recomputeRule(rule) {
  const stats = computeStats(ledgerFor(rule), rule.sample.filter);
  const metric = stats[rule.claim?.metric];
  return { id: rule.id, metric: rule.claim?.metric, rate: metric?.rate ?? null, n: stats.n, coverage: stats.coverage, baselines: stats.baselines, stats };
}

/**
 * 返回 { errors, recomputeErrors, warnings, rules }。
 * errors 是登记本身的问题（G6），recomputeErrors 是复算对不上（G7）。
 */
export function checkRegistry(registry, { recompute = true } = {}) {
  const errors = [];
  const recomputeErrors = [];
  const warnings = [];
  const rules = [];
  const seen = new Set();
  if (!Array.isArray(registry.rules)) return { errors: ['registry.rules 必须是数组'], recomputeErrors, warnings, rules };
  for (const rule of registry.rules) {
    const tag = rule.id ?? '(无 id)';
    if (typeof rule.id !== 'string' || !/^R-\d{3}$/.test(rule.id)) errors.push(`${tag}: id 必须形如 R-001`);
    if (seen.has(rule.id)) errors.push(`${tag}: id 重复`);
    seen.add(rule.id);
    if (!STATUSES.includes(rule.status)) errors.push(`${tag}: status 必须是 ${STATUSES.join('/')}`);
    if (rule.claim?.metric !== undefined && !METRICS.includes(rule.claim.metric)) errors.push(`${tag}: claim.metric 未定义（可选 ${METRICS.join('/')}）`);
    const effective = effectiveStatus(rule);
    const missing = missingElements(rule);
    if (rule.status === 'active' && effective !== 'active') {
      errors.push(`${tag}: 声明 active 但缺 ${missing.length ? missing.join('/') : 'claim.rate/claim.n'}，只能算候选`);
    }
    if (rule.status === 'retracted' && (!rule.retraction?.date || !rule.retraction?.reason)) {
      errors.push(`${tag}: 撤回必须写明 retraction.date 与 retraction.reason（留痕）`);
    }
    const row = { id: rule.id, title: rule.title, declared: rule.status, effective, missing };
    const hasClaim = rule.claim && typeof rule.claim.rate === 'number' && Number.isInteger(rule.claim.n);
    // 撤回的规则同样复算：留痕里的数字也必须是真的。
    const recomputable = effective === 'active' || (effective === 'retracted' && missing.length === 0 && hasClaim);
    if (effective === 'active' && !rule.baseline) warnings.push(`${tag}: 未登记对照基线说明`);
    if (recomputable) {
      if (recompute) {
        const recomputed = recomputeRule(rule);
        row.recomputed = recomputed;
        if (recomputed.n !== rule.claim.n) recomputeErrors.push(`${tag}: 复算样本 n=${recomputed.n} ≠ 登记 n=${rule.claim.n}`);
        if (recomputed.rate === null || Math.abs(recomputed.rate - rule.claim.rate) > RATE_TOLERANCE) {
          recomputeErrors.push(`${tag}: 复算 ${rule.claim.metric}=${recomputed.rate} ≠ 登记 ${rule.claim.rate}`);
        }
      }
    } else if (effective === 'candidate' && rule.status === 'candidate') {
      warnings.push(`${tag}: 候选规则（缺 ${missing.length ? missing.join('/') : '可复算的 claim'}），不得作为结论发布`);
      // 候选规则必须登记裁决阈值；样本攒够了就必须裁决（转 active 并登记 claim，或撤回），不许无限期挂着。
      if (!Number.isInteger(rule.reviewAt?.n) || rule.reviewAt.n < 1) {
        errors.push(`${tag}: 候选规则必须登记裁决阈值 reviewAt.n（样本达到多少场必须裁决）`);
      } else if (!missing.includes('sample')) {
        const n = computeStats(ledgerFor(rule), rule.sample.filter).n;
        row.sampleN = n;
        if (n >= rule.reviewAt.n) errors.push(`${tag}: 候选规则样本已达 n=${n} ≥ ${rule.reviewAt.n}，必须裁决：转 active 并登记可复算的 claim，或撤回`);
      }
    }
    rules.push(row);
  }
  return { errors, recomputeErrors, warnings, rules };
}
