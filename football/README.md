# football：可复算的泊松足球分析流水线

参考 [MattCheng23/football-analysis](https://github.com/MattCheng23/football-analysis) 的**流程设计**，零依赖 Node ESM（Node ≥ 18）重新实现。代码与数据都是自己的，没有搬运原仓库。和原仓库一样，这里的价值在流程，不在命中率。

```
数据采集 → 泊松建模 → 8 道机械门禁 → 发布 → 赛后归因 → 规则登记/撤回 → 回到建模
```

## 先说结论：66% 是怎么来的

| 口径 | 方向命中 | n | 覆盖率 | 同样本·赔率热门 |
|---|---|---|---|---|
| R-009 全样本（2019-08 ~ 2026-09，五大联赛，不剔除） | **52.31%** | 12557 | 100% | 53.61% |
| R-010 高置信档 conf ≥ 0.53，**留出段**（2024-07 起） | **66.56%** | 1199 | 33.29% | 66.72% |
| R-015 **精选档** conf ≥ 0.72，**留出段**（2024-07 起） | **85.71%** | 147 | 4.08% | 85.71% |

当前模型是 `dc-poisson-sot@1.1.0`（进球 + 射正混合），台账 v3。

**精选档（目标命中 ≥ 80%）**：阈值 0.72 只在训练段选出（训练段 80.11%，n=367），留出段 85.71%（n=147，95% 置信区间约 79%~90%），2024-25 与 2025-26 两个赛季分别为 85.1% 和 85.3%，五大联赛各自都在 80% 以上。代价是只覆盖约 4% 的比赛（约每个比赛周 1~2 场，多为拜仁、皇马、巴萨、巴黎等强队），而且这一档模型与赔率热门选的完全是同一批比赛、命中率相同——80% 来自"挑最一边倒的比赛"，不是模型比市场更准。实盘精选档（R-016）攒满 100 场后必须裁决。

- **方向** = 胜/平/负三选一，取模型概率最大的一项。
- 全样本里模型略低于赔率热门（52.31% 对 53.61%），和"五大联赛热门约 53%~54%"的经验一致。
- **66% 只在高置信档出现**：只对模型最有把握的约三分之一比赛下结论。阈值只在训练段（2024-07 之前）选出，留出段只报告、不回头调参。
- 高置信档里，赔率热门在同一批比赛上也有 66.72%。这档的命中主要来自"这些比赛本来就一边倒"，**模型并没有跑赢市场**。
- 高置信档留出段里的错判，248/401 是平局。射正混合没有改善这一点（见"实验记录"）。
- R-010 的命中率比上一版 R-007（67.12%）低，是因为同一套选阈值流程在新模型上选出了更低的阈值、覆盖更多比赛；**同覆盖率下新模型略好**，见下方对比。

所以，任何"命中率 X%"都必须和 **n、覆盖率、同样本基线**一起报。发布页和 `stats.mjs` 每次复算都强制附带这三项。

## 目录

```
football/
├── data/
│   ├── big5.csv             样本库：五大联赛 2017-07 起赛果 + 射正 + 赛前赔率 + 赛前 Elo（赔率只做基线，不进模型）
│   ├── elo-latest.csv       全联赛球队最新 ClubElo 快照（欧冠候选用）
│   ├── elo-model.json       Elo 泊松模型参数（只用训练段拟合）
│   ├── manifest.json        原始文件与样本库文件的 sha256 指纹（G8 校验）
│   ├── jczq-teams.json      竞彩中文队名 → 样本库队名对照表
│   └── uefa-teams.json      UEFA 球队编号 → Elo 快照队名对照表
├── fixtures/ucl/            UEFA 官方赛程/赛果精简快照（赛前证据，不覆盖）
├── ledger/
│   ├── backtest-v3.jsonl    当前回测台账（确定性生成，可逐字节复现）
│   ├── backtest-v2.jsonl    v2 回测台账，已冻结
│   ├── backtest.jsonl       v1 回测台账，已冻结
│   ├── backtest-elo.jsonl   Elo 泊松模型留出段回测台账
│   ├── live.jsonl           实盘台账（竞彩 / 手工 fixtures，首次预测时创建，只追加）
│   ├── ucl-candidate.jsonl  欧冠候选台账（只作候选，不作结论）
│   ├── ucl-notes.json       欧冠首发标注（缺阵常规主力，不进模型）
│   ├── jczq-refs.json       竞彩编号/中文队名旁注（只用于展示，不进哈希链）
│   └── published.json       发布锚点：每本台账已发布的条数 + 末条 hash，登记表每条规则的状态与口径指纹
├── rules/registry.json      规则登记表（唯一读入口）
├── reports/<date>.html      发布页
├── src/                     模型、台账、门禁、统计等模块（见下表）
├── bin/                     命令行脚本（见"命令"）
├── test/                    单测（cd football && npm test）
└── package.json
```

| 模块 | 作用 |
|---|---|
| `src/poisson.mjs` `src/walkforward.mjs` | Dixon-Coles 泊松拟合、进球 + 射正混合、滚动前推回测 |
| `src/elo.mjs` | Elo 泊松跨联赛候选模型 |
| `src/ledger.mjs` | 台账条目、哈希链、折叠（撤回口径） |
| `src/metrics.mjs` `src/tiers.mjs` | 复算口（命中率 + 同样本基线）、赛后归因、档位 |
| `src/rules.mjs` `src/gates.mjs` `src/quality.mjs` | 规则登记与锚点、8 道门禁、数据质量 |
| `src/live.mjs` `src/jczq.mjs` `src/ucl.mjs` | 实盘流程、竞彩接入、欧冠场次口径 |
| `src/report.mjs` `src/pipeline.mjs` `src/config.mjs` | 发布页、门禁输入组装、路径与口径常量 |

## 命令（在仓库根目录执行）

```bash
# 复算（任何人都能一键重算登记过的命中率）
node football/bin/stats.mjs --all                    # 复算全部 active 规则，对不上退出 1
node football/bin/stats.mjs --rule R-010
node football/bin/stats.mjs --curve --filter '{"mode":"backtest","from":"2024-07-01"}'   # 置信度-覆盖率曲线
node football/bin/stats.mjs --review --filter '{"from":"2024-07-01","minConf":0.53}'     # 赛后归因
node football/bin/compare.mjs --a ledger/backtest-v2.jsonl --b ledger/backtest-v3.jsonl --from 2024-07-01   # 两版模型同口径对比

# 重建
node football/bin/build-dataset.mjs --raw <Matches.csv>   # 从原始 CSV 裁样本库
node football/bin/backtest.mjs                            # 重新生成回测台账（约 20 秒）
node football/bin/calibrate.mjs --target 0.66             # 训练段选阈值，报告留出段（高置信档）
node football/bin/calibrate.mjs --target 0.80             # 同上（精选档）
node football/bin/elo-backtest.mjs                        # Elo 泊松模型：训练段拟合参数 + 留出段回测台账

# 竞彩实盘（见下方"接入竞彩"）
node football/bin/jczq.mjs --date 2026-11-29 --check      # 只看每场映射状态
node football/bin/jczq.mjs --date 2026-11-29              # 五大联赛场次出预测入账
node football/bin/result.mjs --no 周六001 --ft 2-1 --source "竞彩官方赛果"

# 通用实盘（英文队名）
node football/bin/predict.mjs --fixtures fixtures.json    # 赛前预测（开赛即锁定）
node football/bin/predict.mjs --fixtures fixtures.json --replace --reason "首发确认后复核"   # 赛前改判
node football/bin/result.mjs --id "E0|2026-11-28|Arsenal|Chelsea" --ft 2-1 --ht 1-0 --source "官方赛果"
node football/bin/retract.mjs --seq 12 --reason "<原因>"

# 欧冠（候选，见下方"欧冠候选"）
NODE_USE_ENV_PROXY=1 node football/bin/ucl.mjs --fetch --date 2026-11-24   # 抓 UEFA 官方赛程快照
node football/bin/ucl.mjs --date 2026-11-24                                # 出候选预测（开赛即锁定）
NODE_USE_ENV_PROXY=1 node football/bin/ucl-lineups.mjs --date 2026-11-24   # 首发标注
NODE_USE_ENV_PROXY=1 node football/bin/ucl-results.mjs --date 2026-11-24   # 赛后录比分、算命中

# 门禁与发布
node football/bin/gates.mjs                # 8 道门禁
node football/bin/publish.mjs [--dry-run]  # 门禁全过才写发布页 + 更新锚点
```

`fixtures.json` 格式：`{"matches":[{"league":"E0","kickoff":"2026-11-28T23:00:00+08:00","home":"Arsenal","away":"Chelsea","odds":[1.9,3.6,4.2]}]}`。队名必须与样本库一致，拼错会被拒绝并提示候选名。`odds` 可省略。设置环境变量 `FOOTBALL_NOW` 可以覆盖"当前时间"，便于复现。

## 接入竞彩

竞彩官方接口在部分网络环境下不可达，所以抓取和建模分成两步。抓取仍由 `scripts/jczq-board.mjs --live` 负责（它会把官方响应原文存成 `fixtures/<date>.live-raw.json`）；`football/bin/jczq.mjs` 只读本地文件，不联网。

```bash
node scripts/jczq-board.mjs --live              # 1. 在能访问竞彩官网的机器上抓取（顺带出盘口看板）
node football/bin/jczq.mjs --date 2026-11-29    # 2. 五大联赛场次 → 实盘台账
node football/bin/publish.mjs                   # 3. 门禁全过才发布
node football/bin/result.mjs --no 周六001 --ft 2-1 --source "竞彩官方赛果"   # 4. 完场后录赛果
```

每场会得到一种状态：

| 状态 | 含义 | 处理 |
|---|---|---|
| 待预测 | 五大联赛、队名已映射、未开赛 | 出预测入账 |
| 未建模 | 非五大联赛（荷乙、欧国联、日职等） | 不出预测，不硬凑 |
| 未映射 | 五大联赛，但中文队名不在对照表 | **默认整批拒绝**；补表后重跑，或加 `--skip-unmapped` |
| 已锁定 | 已开赛 | 不出预测 |
| 已预测 / 已结算 | 台账里已有 | 不重复出；改判走 `predict.mjs --replace` |

- 队名只做精确匹配（NFKC 归一化 + 去空白），不做模糊匹配，查不到就停下来让人补表。
- 对照表覆盖样本库 2025-07 以来出现过的全部 110 支球队，另含近几季降级球队（有单测守护）。中文别名按常见译名整理，**还没有用真实的五大联赛竞彩场次逐一核对**；首次接入先跑 `--check`，把报出的未映射队名补进 `data/jczq-teams.json`。
- 竞彩胜平负（had）赔率写进 `market`，只作赛后对照基线；让球胜平负不使用。竞彩赔率返还率低于样本库的博彩公司均值，所以实盘基线和回测基线不能直接比。
- 竞彩编号每周复用；`result.mjs --no` 只在"尚未录赛果"的预测里找，必须唯一命中，否则要求改用 `--id`。

## 欧冠候选

五大联赛模型的球队强弱是"相对本联赛平均"，跨联赛不可比，所以欧冠用 Elo 泊松模型（`src/elo.mjs`）：λ 由赛前 ClubElo 差决定，参数只用 2024-07 之前的五大联赛比赛拟合。它在五大联赛留出段上与 v3 基本持平（R-012、R-013），但**没有任何欧冠样本回测**，所以欧冠预测只登记为候选（R-014），不作结论。

- 赛程、首发、赛果全部来自 UEFA 官方接口（`match.uefa.com`），快照存在 `fixtures/ucl/`，已存在不覆盖。
- 出预测前固定口径：UEFA 球队编号查 `data/uefa-teams.json`，再查 Elo 快照；查不到或 Elo 早于开赛 120 天 → 不出预测。
- 首发只作标注：本季此前欧冠首发 ≥ 3 场的算常规主力，首发公布后列出缺阵者，写入 `ledger/ucl-notes.json`，不改已锁定的概率。
- 伤停：原数据源失效，UEFA 接口不提供，暂不处理。
- 每天的比赛日工作流会自动录前一天赛果、出当天候选预测（见"上线与定时运转"）。
- 本环境访问 UEFA 需代理，Node 内置 fetch 要加 `NODE_USE_ENV_PROXY=1`；GitHub Actions 里不需要。

## 台账版本

台账一经发布即冻结。数据或口径有变化时，生成新版本文件，旧文件原样保留，依赖旧台账的规则改为撤回留痕：

- **v1** `backtest.jsonl`：数据源把同一球队拆成两种写法（`Nottm Forest`/`Nott'm Forest`、`MGladbach`/`M'gladbach`，2024-12 起切换），模型把切换后的两队当成新队。R-001~R-003 因此撤回，但数字仍能在 v1 上复算（G7 会检查）。
- **v2** `backtest-v2.jsonl`：`data/big5.csv` 已合并分裂队名（`src/dataset.mjs` 的 `TEAM_ALIASES`），模型 `dc-poisson@1.0.0`（只用进球）。R-006~R-008 仍然成立、可复算，作为历史结论保留。
- **v3** `backtest-v3.jsonl`：模型 `dc-poisson-sot@1.1.0`（进球 + 射正混合），样本库新增射正列。R-009~R-011。
- **Elo** `backtest-elo.jsonl`：Elo 泊松模型在五大联赛留出段的回测，R-012、R-013。精选档 R-015 与 v3 同一台账。

v1 只能用修正前的样本库复现，即本仓库首次提交该模块时的 `big5.csv`。

## 数据源

| 来源 | 内容 | 用途 |
|---|---|---|
| [xgabora/Club-Football-Match-Data-2000-2025](https://github.com/xgabora/Club-Football-Match-Data-2000-2025) | 赛果、射正、赔率、赛前 ClubElo（截至 2026-09-03） | 样本库历史部分；Elo 快照 |
| football-data.co.uk 的两个独立 GitHub 镜像：[Char2mant/futbol-veri-aynasi](https://github.com/Char2mant/futbol-veri-aynasi)、[maparan1903-bit/futbol-veri-deposu](https://github.com/maparan1903-bit/futbol-veri-deposu) | 赛果、射正、Bet365 赔率（每周两次更新，无 Elo） | 追加历史部分之后的新比赛 |
| UEFA 官方接口 | 欧冠赛程、首发、赛果 | 欧冠候选 |
| 竞彩官方接口（本地） | 在售场次、中文队名、胜平负赔率 | 五大联赛实盘 |

第二数据源的接入规则（`src/sources.mjs`，任何一条不满足就整批拒绝）：
1. **双源核验**：两个镜像的同一文件必须逐字节一致；
2. **重叠核验**：与已有样本库重叠的场次（当前 1851 场），比分、射正、Bet365 赔率必须逐场一致；
3. **只追加**：只接入已有样本库最后一天之后的比赛，历史部分一行不动，回测台账因此不受影响（复现验证会检查）。

新接入的比赛没有 Elo，所以欧冠候选用的 Elo 快照仍停在 2026-08 底。

## 模型

Dixon-Coles 族泊松模型，用赛果和射正（不用赔率）：

- λ主 = μ·γ·进攻主·防守客，λ客 = μ·进攻客·防守主。参数用加权迭代比例拟合估计。
- 同一套拟合分别跑在进球和射正上，最终 λ = 0.5·λ进球 + 0.5·λ射正·转化率（转化率 = 窗口内加权进球 / 加权射正，主客分开）。射正比进球稳定，运气成分小。没有射正数据的比赛（例如实盘只录了比分的场次）只参与进球评分。
- 时间衰减半衰期 180 天，窗口 730 天。球队参数向 1 收缩（4 场伪样本），避免升班马被极端估计。
- 低比分修正 ρ 在训练样本上用网格最大似然估计。
- 回测按"每个联赛、每个比赛日"滚动重拟合，只用当天 00:00 UTC 之前的比赛，无未来数据泄漏（有单测守护）。
- 输出：方向三项概率、比分 TOP3、总进球档位（0-1 / 2-3 / 4+）、大小 2.5。

## 实验记录：平局盲区与高置信档

目标：减少高置信档里的平局错判、提高该档命中率。所有方案只在训练段（开赛 < 2024-07-01）比较和选择，留出段只在选定后看一次。

**诊断（训练段）**：平局概率是准的——整体预测 25.05%、实际 25.27%；高置信档预测 20.2%、实际 20.4%。问题不是低估平局，而是模型分不出"哪些强弱分明的比赛会打平"。

| 方案 | 训练段结果（覆盖 32% 时的高置信档命中） | 结论 |
|---|---|---|
| 现行模型（只用进球） | 66.12%，档内平局 20.4% | 基准 |
| A 调超参数（半衰期 90~365 天、收缩 2~8 场） | 65.39%~66.78% | 差异在随机波动内，不采用 |
| B 换排序方式挑比赛（概率差、λ 差、扣除平局概率等 5 种） | 65.88%~66.40%，档内平局都约 20.3% | 模型自身信息里没有"会平"的信号，不采用 |
| C 加入射正评分，进球权重 0.75 / **0.5** / 0.25 / 0 | 67.34% / **67.90%** / 67.90% / 67.10%，档内平局降到 18.7%~19.6% | **采用 0.5**（目标指标并列最高，对数损失更好） |

**留出段（只看一次）**，`node football/bin/compare.mjs --a ledger/backtest-v2.jsonl --b ledger/backtest-v3.jsonl --from 2024-07-01`：

| 覆盖率 | v2 命中 | v3 命中 | 只被 v2 选中的场次命中 | 只被 v3 选中的场次命中 |
|---|---|---|---|---|
| 20% | 72.08% | 73.33% | 51/94 | 60/94 |
| 30% | 67.35% | 67.81% | 72/128 | 77/128 |
| 35% | 65.27% | 66.14% | 71/138 | 82/138 |
| 45% | 62.43% | 63.48% | 84/174 | 101/174 |

- 模型整体确实变好：留出段对数损失 0.9926 → 0.9888，逐场配对 z = 2.57；比分 TOP3 32.34% → 33.12%。
- 高置信档命中每个覆盖率都略高，但单看这一项差距不显著。
- **平局盲区没有修好**：训练段档内平局率下降，在留出段没有复现（30% 覆盖时两版都是 20.17%）。
- 同样本赔率热门仍然持平或略高，模型没有跑赢市场。

下一步如果还要提高这一档，需要模型之外的新信息（首发、伤停、赛程密度等），或者干脆把赔率当输入——但那样衡量的就不再是"模型自己的判断"了。

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

## 8 道机械门禁

CI（`.github/workflows/verify-and-merge.yml`）每个 PR 都用**运行时的真实时间**跑一遍 `node football/bin/gates.mjs`，所以"开赛超 72 小时没录赛果""候选规则到期没裁决""样本库过旧"都会让 CI 变红。测试或门禁任一失败，`verify` 检查本身都会变红（信任评分照常计算）。

CI 的验证还包括**复现验证**：用 PR 的代码和样本库重新生成 `backtest-v3.jsonl`、`backtest-elo.jsonl` 与 `elo-model.json`，必须与提交的文件逐字节一致，并复算全部 active 规则。改了模型却没重新生成台账、或手改了台账，都会在这里失败。这一步不依赖任何大模型。

| 门禁 | 检查内容 |
|---|---|
| G1 结构完整性 | 字段齐全、类型正确、字段序规范、seq 连续 |
| G2 哈希链 | 逐条复算 hash；已发布前缀不得改写/截断 |
| G3 概率量化 | 概率在 [0,1]、和≈1、pick 为最大项、TOP3 有序、λ 合法 |
| G4 开赛锁定 | 预测早于开赛；赛果晚于开赛 105 分钟；不得倒签；改判先撤回 |
| G5 覆盖率 | 回测不许挑场（样本库每场都要有预测和赛果）；实盘开赛超 72h 必须录赛果 |
| G6 规则登记 | active 三要素齐全；撤回必须留痕；候选规则必须登记裁决阈值 `reviewAt.n`，样本达到阈值必须裁决（转 active 或撤回）；对照 `published.json` 里的登记表锚点，已发布的 active/retracted 规则口径不可改、不可删、不可降回候选、撤回不可恢复 |
| G7 复算一致 | active 与撤回规则的数字现场复算 |
| G8 数据质量 | 样本库与 `data/manifest.json` 指纹一致（不许手改）；同联赛去标点后同名的不同写法 = 队名分裂；行级校验（重复、比分、赔率、射正、Elo）；样本库超 30 天提示、超 120 天阻断 |

## 上线与定时运转

| 工作流 | 何时运行 | 做什么 |
|---|---|---|
| `football-pages.yml` | 推到 main 且改了 `football/**` | 8 道门禁通过才把 `football/reports/` 部署到 GitHub Pages（首页 = 最新发布页）；门禁不过不上线 |
| `football-matchday.yml` | 每天 12:07 UTC（北京时间 20:07），14:37 UTC 备用 | 录前一天欧冠赛果 → 抓当天欧冠赛程并出候选预测 → 门禁、测试、发布 → 开 PR；满足例行数据条件就自动合并并重新部署发布页，否则留待人工审；台账没变化就什么都不做；上一个比赛日 PR 未合并时接在它上面继续（滚动 PR），避免哈希链冲突 |
| `football-data-refresh.yml` | 每周一 03:17 UTC | 下载原始数据重建样本库与指纹清单，门禁、测试、复现验证全过就走例行数据通道自动合并；不刷新的话 G8 会在样本库超 120 天时阻断，欧冠候选也会因 Elo 过旧停出 |
| `verify-and-merge.yml` | 每个 PR | 单测 + 用真实时间跑 8 道门禁，任一失败 `verify` 变红 |

需要在仓库设置里打开的开关：
1. Settings → Pages → Build and deployment → Source 选 **GitHub Actions**（公开仓库的 Pages 是公开网页）。
2. Settings → Actions → General → Workflow permissions 勾选 **Allow GitHub Actions to create and approve pull requests**。
3. 可选：Secret `BOT_PAT`。用默认令牌开的 PR 不会触发其他工作流（GitHub 的限制），配了它，比赛日 PR 才会自动跑 `verify-and-merge`。

定时工作流只在默认分支上运行，本模块合并到 main 后才开始转。竞彩不在 CI 里跑（官方接口海外不可达），仍需本地执行 `jczq-board --live` + `jczq.mjs`。

### 例行数据通道（自动合并）

比赛日和样本库刷新这类 PR 不需要人看：只要同时满足以下条件，就自动 squash 合并，并重新部署发布页。

1. 带 `bot-authored` 标签；
2. 改动只落在 `config/trust.json` 的 `routineData.paths` 白名单内（台账、赛程快照、发布页、样本库三个文件），代码、工作流、规则登记表、对照表一律不在内；
3. CI 全绿：两套测试 + 8 道门禁 + 复现验证；
4. `scripts/routine-merge-check.mjs` 对照 **main** 证明：每本台账都以 main 上的版本为前缀（只追加、不改写、不删除），发布锚点条数不减少，登记表锚点不变。

放权配置和检查脚本都只用 **main 上的版本**，PR 改不了自己的放权规则；信任评分脚本同理。紧急关闭：仓库变量 `ROUTINE_AUTO_MERGE` 设为 `false`。

## 局限

- 只建模五大联赛；竞彩的其他联赛（荷乙、日职、欧国联等）不出预测。
- 实盘赛果目前需要手动录入（`result.mjs`）；竞彩赛果接口还没接。
- 样本库截至 2026-09-03。之后只有录过赛果的实盘场次会进入拟合，没上竞彩的比赛不会，模型会逐渐变旧；要定期用 `build-dataset.mjs` 刷新样本库。回测窗口上界固定在 `src/config.mjs` 的 `BACKTEST_TO`，刷新样本库不会让现有台账"缺场"；要把新比赛纳入回测，就生成新版本台账。
- 半全场未建模；比分 TOP3 口径与单比分口径不可混报。
- 样本库的开球时间缺失时按 12:00 计，且未做时区校正，只用于回测里"预测早于开赛"的判断。
- 本模块仅为统计方法演示，不构成任何投注建议。

数据来源：football-data.co.uk 口径的公开赛果与赔率，经 [xgabora/Club-Football-Match-Data-2000-2025](https://github.com/xgabora/Club-Football-Match-Data-2000-2025) 汇编。
