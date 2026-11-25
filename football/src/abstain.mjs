/**
 * "不下判断"阈值的固定选择流程（bin/abstain.mjs 调用）。说明见 bin/abstain.mjs 文件头。
 */
import { marginOf } from './metrics.mjs';

export const Z_CRITICAL = 1.645;
export const MARGIN_GRID = Array.from({ length: 30 }, (_, i) => Math.round((i + 1) * 0.01 * 100) / 100);

const r4 = (x) => Math.round(x * 1e4) / 1e4;
export const outcomeIndex = (ft) => (ft[0] > ft[1] ? 0 : ft[0] === ft[1] ? 1 : 2);

/** probs [h,d,a] + 实际结果下标 → { margin, h1, h2 } */
export function rowOf(probs, outcome) {
  const order = [0, 1, 2].sort((a, b) => probs[b] - probs[a] || a - b);
  return { margin: marginOf(probs), h1: outcome === order[0], h2: outcome === order[1] };
}

export function bucket(rows, m) {
  const b = rows.filter((r) => r.margin < m);
  const h1 = b.filter((r) => r.h1).length;
  const h2 = b.filter((r) => r.h2).length;
  return { m, n: b.length, h1, h2, rate1: b.length ? r4(h1 / b.length) : null, rate2: b.length ? r4(h2 / b.length) : null, z: h1 + h2 ? r4((h1 - h2) / Math.sqrt(h1 + h2)) : 0 };
}

/** 返回阈值（可能为 null：0.01 就已显著，说明没有需要弃权的区间）与逐步表。 */
export function selectAbstain(trainRows, grid = MARGIN_GRID, zCritical = Z_CRITICAL) {
  const steps = [];
  let threshold = null;
  for (const m of grid) {
    const step = bucket(trainRows, m);
    steps.push(step);
    if (step.z >= zCritical) break;
    if (step.n > 0) threshold = m; // 空档不算：训练段一场都没有的区间谈不上"分不出高下"
  }
  return { threshold, steps };
}

