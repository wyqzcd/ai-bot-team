/**
 * 档位：只从登记表里 active 且指向当前回测台账的规则读取阈值，不在代码里硬编码。
 *   elite           精选档（R-015：训练段选出的命中 ≥ 80% 阈值）
 *   high-confidence 高置信档（R-010：训练段选出的命中 ≥ 66% 阈值）
 *   abstain         不下判断（R-018 / R-019：第一、第二选择概率差小于训练段选出的阈值，不给方向）
 */
import path from 'node:path';
import { marginOf } from './metrics.mjs';
import { effectiveStatus } from './rules.mjs';

export const TIER_LABEL = { elite: '精选', 'high-confidence': '高置信', abstain: '不下判断' };

export function currentTiers(registry, backtestLabel) {
  const active = registry.rules.filter((rule) => effectiveStatus(rule) === 'active' && rule.tier && Number.isFinite(rule.sample?.filter?.minConf));
  const pick = (tier) => {
    const list = active.filter((rule) => rule.tier === tier);
    return list.find((rule) => path.basename(rule.sample.ledger, '.jsonl') === backtestLabel) ?? null;
  };
  return { elite: pick('elite'), high: pick('high-confidence') };
}

/** 返回 { key, label, rule } 或 null */
export function tierOf(conf, tiers) {
  if (tiers.elite && conf >= tiers.elite.sample.filter.minConf) return { key: 'elite', label: TIER_LABEL.elite, rule: tiers.elite };
  if (tiers.high && conf >= tiers.high.sample.filter.minConf) return { key: 'high-confidence', label: TIER_LABEL['high-confidence'], rule: tiers.high };
  return null;
}

/** 指向某本回测台账的 active "不下判断"规则（sample.filter.maxMargin 为阈值），没有则 null。 */
export function currentAbstain(registry, backtestLabel) {
  return registry.rules.find((rule) => effectiveStatus(rule) === 'active' && rule.tier === 'abstain' && Number.isFinite(rule.sample?.filter?.maxMargin)
    && path.basename(rule.sample.ledger, '.jsonl') === backtestLabel) ?? null;
}

/** 概率差小于阈值 → { key: 'abstain', label, rule, margin }，否则 null。probs 为 [主, 平, 客]。 */
export function abstainOf(probs, rule) {
  if (!rule) return null;
  const margin = marginOf(probs);
  return margin < rule.sample.filter.maxMargin ? { key: 'abstain', label: TIER_LABEL.abstain, rule, margin } : null;
}
