# football：可复算的泊松足球分析流水线

参考 [MattCheng23/football-analysis](https://github.com/MattCheng23/football-analysis) 的**流程设计**，零依赖 Node ESM（Node ≥ 18）重新实现。代码与数据都是自己的，没有搬运原仓库。和原仓库一样，这里的价值在流程，不在命中率。

```
数据采集 → 泊松建模 → 7 道机械门禁 → 发布 → 赛后归因 → 规则登记/撤回 → 回到建模
```

## 先说结论：66% 是怎么来的

| 口径 | 方向命中 | n | 覆盖率 | 同样本·赔率热门 |
|---|---|---|---|---|
| R-001 全样本（2019-08 ~ 2026-09，五大联赛，不剔除） | **52.23%** | 12557 | 100% | 53.61% |
| R-002 高置信档 conf ≥ 0.56，**留出段**（2024-07 起） | **67.27%** | 1103 | 30.62% | 67.45% |

- **方向** = 胜/平/负三选一，取模型概率最大的一项。
- 全样本里模型略低于赔率热门（52.2% 对 53.6%），和"五大联赛热门约 53%~54%"的经验一致。
- **66% 只在高置信档出现**：只对模型最有把握的约三成比赛下结论。阈值 0.56 只在训练段（2024-07 之前）选出，留出段只报告、不回头调参。
- 高置信档里，赔率热门在同一批比赛上也有 67.45%。这档的命中主要来自"这些比赛本来就一边倒"，**模型并没有跑赢市场**。
- 高置信档留出段里的错判，222/361 是平局（模型几乎从不把平局排第一），这是下一步最值得改进的地方。

所以，任何"命中率 X%"都必须和 **n、覆盖率、同样本基线**一起报。发布页和 `stats.mjs` 每次复算都强制附带这三项。

## 目录

```
football/
├── data/big5.csv            样本库：五大联赛 2017-07 ~ 2026-09 赛果 + 赛前赔率（赔率只做基线，不进模型）
├── ledger/
│   ├── backtest.jsonl       回测台账（确定性生成，可逐字节复现）
│   ├── live.jsonl           实盘台账（首次预测时创建，只追加）
│   └── published.json       发布锚点：每本台账已发布的条数 + 末条 hash
├── rules/registry.json      规则登记表（唯一读入口）
├── reports/<date>.html      发布页
├── src/                     poisson / walkforward / ledger / metrics / rules / gates / live / report
└── bin/                     CLI（见下）
```

## 命令（在仓库根目录执行）

```bash
# 复算（任何人都能一键重算登记过的命中率）
node football/bin/stats.mjs --all                    # 复算全部 active 规则，对不上退出 1
node football/bin/stats.mjs --rule R-002
node football/bin/stats.mjs --curve --filter '{"mode":"backtest","from":"2024-07-01"}'   # 置信度-覆盖率曲线
node football/bin/stats.mjs --review --filter '{"from":"2024-07-01","minConf":0.56}'     # 赛后归因

# 重建
node football/bin/build-dataset.mjs --raw <Matches.csv>   # 从原始 CSV 裁样本库
node football/bin/backtest.mjs                            # 重新生成回测台账（约 20 秒）
node football/bin/calibrate.mjs --target 0.66             # 训练段选阈值，报告留出段

# 实盘
node football/bin/predict.mjs --fixtures fixtures.json    # 赛前预测（开赛即锁定）
node football/bin/predict.mjs --fixtures fixtures.json --replace --reason "首发确认后复核"   # 赛前改判
node football/bin/result.mjs --id "E0|2026-11-28|Arsenal|Chelsea" --ft 2-1 --ht 1-0 --source "官方赛果"
node football/bin/retract.mjs --seq 12 --reason "<原因>"

# 门禁与发布
node football/bin/gates.mjs                # 7 道门禁
node football/bin/publish.mjs [--dry-run]  # 门禁全过才写发布页 + 更新锚点
```

`fixtures.json` 格式：`{"matches":[{"league":"E0","kickoff":"2026-11-28T23:00:00+08:00","home":"Arsenal","away":"Chelsea","odds":[1.9,3.6,4.2]}]}`。队名必须与样本库一致，拼错会被拒绝并提示候选名。`odds` 可省略。设置环境变量 `FOOTBALL_NOW` 可以覆盖"当前时间"，便于复现。

## 模型

Dixon-Coles 族泊松模型，只用赛果：

- λ主 = μ·γ·进攻主·防守客，λ客 = μ·进攻客·防守主。参数用加权迭代比例拟合估计。
- 时间衰减半衰期 180 天，窗口 730 天。球队参数向 1 收缩（4 场伪样本），避免升班马被极端估计。
- 低比分修正 ρ 在训练样本上用网格最大似然估计。
- 回测按"每个联赛、每个比赛日"滚动重拟合，只用当天 00:00 UTC 之前的比赛，无未来数据泄漏（有单测守护）。
- 输出：方向三项概率、比分 TOP3、总进球档位（0-1 / 2-3 / 4+）、大小 2.5。

## 规则怎么才算数

`rules/registry.json` 里，声称命中率的规则必须同时有：

1. **definition**：文字口径（什么算命中）
2. **sample**：台账文件 + 过滤器（哪些场次）
3. **recompute**：复算命令

缺一项，有效状态就强制降为 **candidate**：不进发布页结论，声明 active 会被 G6 拦下。active 规则的 claim 必须现场复算重现（误差 ≤ 0.0005，n 完全一致），否则 G7 拦下。撤回规则不删除，改为 `retracted` 并写明日期和原因；留痕里的数字同样会被复算。R-005 就是一条真实撤回：它的阈值是看着全样本曲线挑的，属于数据窥探。

## 锁定与撤回

| 动作 | 开赛前 | 开赛后 |
|---|---|---|
| 新预测 | 允许 | **拒绝**（G4 + CLI 双重拦截） |
| 改判 | 必须 `--replace --reason`，自动先写撤回 | **拒绝** |
| 录赛果 | 拒绝 | 开赛 105 分钟后允许，只能录一次 |
| 撤回 | 原预测作废，不计入统计 | 只留痕，**照样计入命中率**（防止赛后挑掉错的） |

台账每条带 `prev`/`hash` 组成哈希链。改写、删除、插入任意一条都会被 G2 发现。就算整条链重新算 hash，也改不动 `published.json` 锚定的已发布前缀。

## 7 道机械门禁

| 门禁 | 检查内容 |
|---|---|
| G1 结构完整性 | 字段齐全、类型正确、字段序规范、seq 连续 |
| G2 哈希链 | 逐条复算 hash；已发布前缀不得改写/截断 |
| G3 概率量化 | 概率在 [0,1]、和≈1、pick 为最大项、TOP3 有序、λ 合法 |
| G4 开赛锁定 | 预测早于开赛；赛果晚于开赛 105 分钟；不得倒签；改判先撤回 |
| G5 覆盖率 | 回测不许挑场（样本库每场都要有预测和赛果）；实盘开赛超 72h 必须录赛果 |
| G6 规则登记 | active 三要素齐全；撤回必须留痕 |
| G7 复算一致 | active 与撤回规则的数字现场复算 |

## 局限

- 只建模五大联赛；竞彩（`scripts/jczq-board.mjs`）的中文队名还没有映射到样本库，接入实盘需要先做映射表。
- 半全场未建模；比分 TOP3 口径与单比分口径不可混报。
- 样本库的开球时间缺失时按 12:00 计，且未做时区校正，只用于回测里"预测早于开赛"的判断。
- 本模块仅为统计方法演示，不构成任何投注建议。

数据来源：football-data.co.uk 口径的公开赛果与赔率，经 [xgabora/Club-Football-Match-Data-2000-2025](https://github.com/xgabora/Club-Football-Match-Data-2000-2025) 汇编。
