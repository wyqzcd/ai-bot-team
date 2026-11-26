/** 路径与口径常量：脚本之间只从这里取，避免各写各的。 */
import path from 'node:path';
import { FOOTBALL_ROOT } from './dataset.mjs';

export const BACKTEST_FROM = '2019-07-01';
/** 回测窗口上界固定：以后扩充样本库不会让当前台账"缺场"；要覆盖新比赛就生成新版本台账。 */
export const BACKTEST_TO = '2026-09-03';
/** Elo 模型的留出段起点（参数只用此前的比赛拟合）。 */
export const ELO_HOLDOUT_FROM = '2024-07-01';
/**
 * 当前回测台账。台账一经发布即冻结：数据或模型口径变了，就生成新版本文件，旧文件原样保留
 * （只做 G1~G4 与发布锚点校验，不再做覆盖率校验，依赖它的规则改为 retracted 留痕）。
 *   backtest.jsonl     v1：样本库未合并分裂队名（Nottm Forest / MGladbach），已冻结
 *   backtest-v2.jsonl  v2：合并分裂队名，模型 dc-poisson@1.0.0（只用进球），已冻结
 *   backtest-v3.jsonl  v3：模型 dc-poisson-sot@1.1.0（进球 + 射正混合）
 */
export const FROZEN_LEDGERS = [
  path.join(FOOTBALL_ROOT, 'ledger', 'backtest.jsonl'),
  path.join(FOOTBALL_ROOT, 'ledger', 'backtest-v2.jsonl'),
];

export const PATHS = {
  backtestLedger: path.join(FOOTBALL_ROOT, 'ledger', 'backtest-v3.jsonl'),
  liveLedger: path.join(FOOTBALL_ROOT, 'ledger', 'live.jsonl'),
  // Elo 泊松模型：五大联赛留出段回测（参数只用训练段），以及欧冠候选台账（无欧冠回测，只作候选）。
  eloBacktestLedger: path.join(FOOTBALL_ROOT, 'ledger', 'backtest-elo.jsonl'),
  // 欧冠候选台账按评分口径分版本：v1 用 ClubElo 快照（R-014，已停止出新预测，只补录赛果），
  // v2 用推算 Elo（data/elo-current.csv，R-017）。新预测只写 uclLedger；录赛果在全部版本里找对应预测。
  uclLedger: path.join(FOOTBALL_ROOT, 'ledger', 'ucl-candidate-v2.jsonl'),
  uclLedgers: [path.join(FOOTBALL_ROOT, 'ledger', 'ucl-candidate.jsonl'), path.join(FOOTBALL_ROOT, 'ledger', 'ucl-candidate-v2.jsonl')],
  // 欧联候选台账：从一开始就用推算 Elo 口径（R-020）。
  uelLedger: path.join(FOOTBALL_ROOT, 'ledger', 'uel-candidate.jsonl'),
  anchors: path.join(FOOTBALL_ROOT, 'ledger', 'published.json'),
  // 竞彩编号/中文队名旁注：只用于发布页展示，不参与统计，不进哈希链。
  jczqRefs: path.join(FOOTBALL_ROOT, 'ledger', 'jczq-refs.json'),
  jczqFixtures: path.join(FOOTBALL_ROOT, '..', 'fixtures'),
  registry: path.join(FOOTBALL_ROOT, 'rules', 'registry.json'),
  reports: path.join(FOOTBALL_ROOT, 'reports'),
};

/** 竞彩旁注跟随实盘台账所在目录（测试用临时台账时不会写到仓库里）。 */
export const refsFor = (ledgerFile) => path.join(path.dirname(ledgerFile), 'jczq-refs.json');
