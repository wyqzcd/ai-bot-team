/**
 * G8 数据质量：样本库在进入建模之前必须过的机械检查。
 *   - 指纹：data/manifest.json 记录原始文件与产出文件的 sha256；产出文件对不上 = 被手改或未用 build-dataset 重建。
 *   - 队名分裂：同一联赛里，去掉大小写与标点后相同的不同写法（如 Nottm Forest / Nott'm Forest）= 同一球队被拆开。
 *   - 行级：id 唯一、联赛合法、比分为 0~15 的整数且半场不超过全场、赔率 > 1、射正为非负整数、Elo 在 1000~2500。
 *   - 新鲜度：样本库最后一场距今超过 FRESH_WARN_DAYS 提示，超过 FRESH_ERROR_DAYS 阻断（实盘拟合会用到它）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCsv } from './csv.mjs';
import { FOOTBALL_ROOT, LEAGUES } from './dataset.mjs';

export const MANIFEST_FILE = path.join(FOOTBALL_ROOT, 'data', 'manifest.json');
export const FRESH_WARN_DAYS = 30;
export const FRESH_ERROR_DAYS = 120;
const MAX_LISTED = 20;

export const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
export const teamKey = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** pairs: [[分组, 队名], ...] → [{ group, key, names }]，同组内同 key 不同写法 */
export function findSplitNames(pairs) {
  const groups = new Map();
  for (const [group, name] of pairs) {
    const k = `${group}\u0000${teamKey(name)}`;
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(name);
  }
  return [...groups.entries()].filter(([, names]) => names.size > 1).map(([k, names]) => ({ group: k.split('\u0000')[0], names: [...names].sort() }));
}

const isGoals = (v) => /^\d{1,2}$/.test(v) && Number(v) <= 15;
const optionalOdds = (v) => v === '' || (Number.isFinite(Number(v)) && Number(v) > 1);
const optionalCount = (v) => v === '' || /^\d{1,3}$/.test(v);
const optionalElo = (v) => v === '' || (Number(v) >= 1000 && Number(v) <= 2500);

export function checkRows(rows) {
  const errors = [];
  const seen = new Set();
  rows.forEach((r, i) => {
    const at = `big5.csv 第 ${i + 2} 行`;
    const id = `${r.league}|${r.date}|${r.home}|${r.away}`;
    if (seen.has(id)) errors.push(`${at}: 重复场次 ${id}`);
    seen.add(id);
    if (!(r.league in LEAGUES)) errors.push(`${at}: 联赛 ${r.league} 不在样本库范围`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date))) errors.push(`${at}: 日期非法 ${r.date}`);
    if (!r.home || !r.away || r.home === r.away) errors.push(`${at}: 主客队为空或相同`);
    if (!isGoals(r.fthg) || !isGoals(r.ftag)) errors.push(`${at}: 全场比分非法 ${r.fthg}-${r.ftag}`);
    else if (r.hthg !== '' && r.htag !== '' && (Number(r.hthg) > Number(r.fthg) || Number(r.htag) > Number(r.ftag))) errors.push(`${at}: 半场进球多于全场`);
    for (const k of ['odd_h', 'odd_d', 'odd_a', 'odd_over25', 'odd_under25']) if (!optionalOdds(r[k])) errors.push(`${at}: ${k} 非法 ${r[k]}`);
    for (const k of ['hst', 'ast']) if (!optionalCount(r[k])) errors.push(`${at}: ${k} 非法 ${r[k]}`);
    for (const k of ['home_elo', 'away_elo']) if (!optionalElo(r[k])) errors.push(`${at}: ${k} 超出 1000~2500：${r[k]}`);
  });
  return errors;
}

/**
 * @returns {{ errors: string[], warnings: string[], lastDate: string|null }}
 */
export function checkDataQuality({ dataDir = path.join(FOOTBALL_ROOT, 'data'), manifestFile = MANIFEST_FILE, now }) {
  const errors = [];
  const warnings = [];
  const big5 = path.join(dataDir, 'big5.csv');
  const elo = path.join(dataDir, 'elo-latest.csv');
  if (!existsSync(manifestFile)) errors.push('缺少 data/manifest.json（用 build-dataset.mjs 重建样本库）');
  else {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    for (const [name, file] of [['big5.csv', big5], ['elo-latest.csv', elo]]) {
      const expected = manifest.outputs?.[name];
      if (!existsSync(file)) errors.push(`缺少 ${name}`);
      else if (sha256File(file) !== expected) errors.push(`${name} 与 manifest 指纹不符：被手改，或未用 build-dataset.mjs 重建`);
    }
    if (!/^[0-9a-f]{64}$/.test(manifest.source?.sha256 ?? '')) errors.push('manifest 缺少原始文件 sha256');
  }
  const rows = existsSync(big5) ? parseCsv(readFileSync(big5, 'utf8')) : [];
  errors.push(...checkRows(rows));
  const splits = findSplitNames(rows.flatMap((r) => [[r.league, r.home], [r.league, r.away]]));
  for (const s of splits) errors.push(`${s.group} 队名分裂：${s.names.join(' / ')}（同一球队被拆成多种写法，补到 TEAM_ALIASES）`);
  if (existsSync(elo)) {
    const eloRows = parseCsv(readFileSync(elo, 'utf8'));
    for (const s of findSplitNames(eloRows.map((r) => ['elo', r.team]))) errors.push(`elo-latest 队名分裂：${s.names.join(' / ')}`);
  }
  const lastDate = rows.reduce((max, r) => (r.date > max ? r.date : max), '');
  if (lastDate && now) {
    const ageDays = Math.floor((Date.parse(now) - Date.parse(`${lastDate}T00:00:00Z`)) / 86400000);
    const msg = `样本库最后一场 ${lastDate}，距今 ${ageDays} 天`;
    if (ageDays > FRESH_ERROR_DAYS) errors.push(`${msg}，超过 ${FRESH_ERROR_DAYS} 天上限，先刷新样本库`);
    else if (ageDays > FRESH_WARN_DAYS) warnings.push(`${msg}（超过 ${FRESH_WARN_DAYS} 天，实盘拟合在变旧）`);
  }
  return { errors: errors.slice(0, MAX_LISTED).concat(errors.length > MAX_LISTED ? [`……另有 ${errors.length - MAX_LISTED} 条`] : []), errorCount: errors.length, warnings, lastDate: lastDate || null };
}
