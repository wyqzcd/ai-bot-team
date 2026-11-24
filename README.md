# ai-bot-team

照搬 Lauren Tan（xAI Grok Bot，"土豆女神"）工作法的通用模板：

> **Bot 负责收集上下文和派活，Agents 干实际工程活，pstack 工程技能库保证实现和验证质量；你本人从"盯每个 PR"逐渐过渡到让部分 AI 写的 PR 自动合并。**

运行时基于 **Claude Code**（本地 CLI + GitHub Actions 双栖），技能库用 Lauren 开源的 **pstack**（MIT），放权用本模板自带的**混合信任评分引擎**（评分 + 目录风险 + 任务类型）。

```mermaid
flowchart LR
    U[你: /dispatch 任务<br>或 GitHub Issue] --> D[首席 Bot<br>收集上下文 + 分类 + 派活]
    D --> PM[PM 子代理<br>把需求规格化]
    PM --> E[Engineer 子代理<br>按 pstack poteto-mode 实现]
    E --> QA[QA 子代理<br>证明真的能用, 出验证报告]
    QA --> PR[开 PR + bot-authored 标签]
    PR --> CI[CI: 测试 + 评分引擎]
    CI -->|评分达标| M[自动合并]
    CI -->|不达标| R[指派你 review]
    R -->|你合并/驳回| BOT[Bot 学习教训]
```

## 目录结构

```
ai-bot-team/
├── .claude/
│   ├── settings.json          # 权限配置
│   ├── commands/
│   │   ├── dispatch.md        # /dispatch 首席 Bot 入口（本地）
│   │   └── review.md          # /bot-review 评审入口（本地）
│   └── agents/
│       ├── pm.md              # 规格化子代理
│       ├── engineer.md        # 干活子代理（挂 pstack 纪律）
│       ├── qa.md              # 验证子代理（prove-it-works）
│       └── reviewer.md        # 评审子代理（interrogate 风格）
├── config/
│   ├── trust.json             # 渐进放权配置（评分阈值/目录风险/任务类型/上限）
│   ├── routing.json           # 任务类型 → 子代理 + pstack playbook 路由
│   └── verification/          # QA 验证报告落盘处（.gitkeep）
├── scripts/
│   ├── trust-score.mjs        # 混合信任评分引擎（零依赖，本地/CI 通用）
│   ├── build-dispatch-prompt.mjs  # CI 派活提示词构建
│   ├── install-pstack.ps1     # Windows 安装 pstack
│   └── install-pstack.sh      # Linux/macOS 安装 pstack
├── .github/workflows/
│   ├── bot-dispatch.yml       # CI 里的 Bot（issue 触发/手动触发）
│   └── verify-and-merge.yml   # 校验 + 评分 + 渐进自动合并
├── football/                  # 可复算的泊松足球分析流水线（台账/门禁/规则登记，见 football/README.md）
└── demo/                      # 演示项目（Node.js 小工具，含测试）
```

## 快速开始

### 第 0 步：装 Claude Code 和 pstack

```powershell
npm install -g @anthropic-ai/claude-code
# 国内用户（推荐路线）：配 DeepSeek 官方 Anthropic 兼容端点，-Persist 写入 $PROFILE 永久生效
powershell -ExecutionPolicy Bypass -File scripts/setup-deepseek.ps1 -Persist
# Windows：
powershell -ExecutionPolicy Bypass -File scripts/install-pstack.ps1
# Linux/macOS：
bash scripts/install-pstack.sh
```

安装脚本会优先走官方插件方式（`cursor/plugins` 市场里的 `pstack@cursor-plugins`），失败时给出 `npx skills add backnotprop/pstack` 社区镜像的替代方案。装完后在 Claude Code 里跑一次 `/pstack:setup-pstack` 选择各角色的模型（没有 Grok/Codex 就全选 Claude 模型，`pstack@cursor-plugins` 会把所有角色跑在当前 Claude 模型上）。

### 第 1 步：本地跑通一次闭环（盯每个 PR 阶段）

```powershell
cd ai-bot-team/demo
claude
# 在交互会话里：
#   /dispatch 给 stringy 的 slugify 加一个保留中文的选项，带测试
```

`/dispatch` 会让首席 Bot 收集上下文（repo 结构、现有代码、路由配置），派 PM/Engineer/QA 子代理干活，最后开一个带 `bot-authored` 标签的 PR。**这个阶段你把 `config/trust.json` 里 `autoMergeEnabled` 保持 `false`**，每个 PR 都自己看。

### 第 2 步：把模板复制进真实仓库

把 `.claude/`、`config/`、`scripts/`、`.github/workflows/` 拷进目标仓库（demo 换成你自己的项目），改两处：

1. `config/trust.json` 里的 `owner`（你的 GitHub 用户名，兜底 reviewer）和 `directories`（按你仓库的真实目录分风险档）。
2. `verify-and-merge.yml` 里"安装依赖并测试"一步，改成你项目的真实命令。

GitHub 仓库配置：

- Secrets：
  - 海外 Claude：`ANTHROPIC_API_KEY`
  - 国内：`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（DeepSeek/GLM/Kimi 的 Anthropic 兼容端点，见下方"国内使用指南"）
- Variables：`AUTO_MERGE`（`"true"` 才允许真实合并）、`QA_AGENT_ENABLED`（`"true"` 才在 CI 里跑 pstack QA Agent）、`BOT_DISPATCH_ON_ISSUE`（`"true"` 才让新 issue 自动触发 Bot）、`AGENT_MODEL`（可选，指定模型名如 `deepseek-v4-pro`）

### 第 3 步：渐进放权路线图

| 阶段 | trust.json 怎么改 | 效果 |
|---|---|---|
| L0 全人工 | `autoMergeEnabled: false`（默认） | 每个 bot PR 都派给你 review，评分只作参考 |
| L1 小范围 | 打开 autoMergeEnabled，保持 `dryRun: true` | 只看演练报告，验证评分引擎判断符合你的口味 |
| L2 低风险自动 | `dryRun: false` | 仅 docs/tests 等低风险目录 + CI 全绿的 PR 自动合并 |
| L3 放量 | 上调 `levels` 里 L2/L3 的 `minScore` 并逐步放宽 `directories` | fix/test/chore 类、评分达标的中风险改动自动合并 |

任何阶段你都可以给 PR 打 `bot-review-needed` 标签强制转人工。自动合并只作用于带 `bot-authored` 标签的 PR，你自己的 PR 永不自动合并。

## 信任评分机制（混合放权）

`scripts/trust-score.mjs` 是零依赖的 Node 脚本，本地和 CI 用同一套逻辑：

```
基础分 60
+ CI 全绿 +15（未通过 -40）
+ pstack 验证报告通过 +10（缺失 -10）
+ 任务类型调整（docs +20 / test +15 / fix +10 / chore +5 / feat -5 / refactor -10）
+ 目录风险调整（low +8 / medium -5 / high -15，取改动中最高风险文件）
+ 改动量在安全上限内 +5（超限每项 -10）
+ 改动带测试 +5
→ 0~100 分，映射 L0~L3
→ 决策：自动合并 / 自动合并(演练) / 需人工 review
```

用法：

```powershell
# 手动给一批文件打分
node scripts/trust-score.mjs score --files "docs/a.md,demo/src/b.js" --type fix --ci success --verified true

# 对真实 PR 打分（需要 gh 已登录）
node scripts/trust-score.mjs score-pr 12

# 输出 markdown 版评论
node scripts/trust-score.mjs score-pr 12 --format markdown
```

评分规则全在 `config/trust.json`，改配置不需要改代码。建议每两周回看一次：被人工驳回的 bot PR，用 `/bot-review` 的结论去调 `directories` 或 `levels`，这就是"越用越敢放权"的抓手。

## 国内使用指南（Claude 官方 API 不可用时）

Claude Code 本体可以正常安装，只是 Anthropic 官方 API 在大陆不可用。三条路线，按推荐排序：

### 方案 A：Claude Code + DeepSeek 官方 Anthropic 兼容端点（模板零改动，推荐）

DeepSeek 官方提供 Anthropic 消息协议兼容端点，Claude Code 直接指过去即可，整个模板（子代理/命令/pstack 插件）原样可用。

本地 PowerShell（方式一：配置向导，推荐）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-deepseek.ps1 -Persist
# 也支持 -Provider glm / kimi / custom（-BaseUrl + -Model），向导会提示输入 API Key
```

方式二：手动三行（写进 `$PROFILE` 或运行前执行）：

```powershell
$env:ANTHROPIC_BASE_URL  = "https://api.deepseek.com/anthropic"
$env:ANTHROPIC_AUTH_TOKEN = "sk-你的DeepSeekKey"
$env:ANTHROPIC_MODEL     = "deepseek-v4-pro"   # 首席 Bot 用 pro；想省钱可换 deepseek-flash
```

CI：仓库 Secrets 配 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，可选 Variables `AGENT_MODEL`。两个 workflow 已内置该支持，无需改代码。

注意：

- 智谱 GLM、月之暗面 Kimi 也提供同类 Anthropic 兼容端点，换 `ANTHROPIC_BASE_URL` 即可。
- pstack 的 SKILL.md 是纯提示词，任何模型都能读；`/pstack:setup-pstack` 若检测不到你的模型可跳过（它只是写模型角色映射），需要时手动编辑 `~/.claude/rules/pstack-models.md`。
- 长链路编排（首席 Bot 派活）建议用 pro 档模型；Engineer/QA 子代理可用 flash 档省成本。

### 方案 B：Qwen Code CLI（国产原生，结构与 Claude Code 最像）

```powershell
npm install -g @qwen-code/qwen-code
# 登录拿免费额度，或配置 DASHSCOPE_API_KEY / 自定义模型端点
Copy-Item .claude/agents .qwen/agents -Recurse   # 子代理目录同格式（.qwen/agents/ 优先级最高）
Copy-Item .claude/commands .qwen/commands -Recurse
```

- 子代理文件格式与 Claude Code 兼容（`.qwen/agents/` 为项目级目录），frontmatter 不用改。
- 认证和自定义模型见官方文档（qwen-code-docs 中文站）。
- CI：官方提供 `qwen-code-action`，把 `bot-dispatch.yml` 里的 `claude -p` 换成 `qwen-code -p` 即可。

### 方案 C：Codex CLI + DeepSeek（DeepSeek 官方文档支持）

- 按 DeepSeek 官方文档《接入 Codex》配置 `~/.codex/config.toml`（`model_providers.deepseek`，base_url 用 `https://api.deepseek.com`）。
- open-pstack 官方支持 Codex：`codex plugin marketplace add ericlitman/open-pstack`。
- 子代理：config.toml 开 `[features] multi_agent = true`，代理定义放 `~/.codex/agents/`。

### 对比

| 方案 | 模板改动量 | pstack | 子代理支持 | 备注 |
| --- | --- | --- | --- | --- |
| A Claude Code + DeepSeek | 零（只配密钥） | 官方插件直接用 | 原生 | 改动最小，推荐先试 |
| B Qwen Code CLI | 小（复制目录） | 提示词平替/skills CLI | 原生 | 国产免费额度友好 |
| C Codex + DeepSeek | 中（重写代理配置） | open-pstack | 需开开关 | 官方文档齐全 |

另外：GitHub Actions 在国内基本可用但偶有延迟；公司内网完全受限时可改用自托管 runner（workflow 无需改，只换 runner 标签）。

## 常见问题

- **CI 里跑 Bot 怕失控？** `bot-dispatch.yml` 的 `dry_run` 输入默认是 `true`，Bot 只会把"计划"评论在 issue 上，不开 PR。
- **自动合并怕把主分支搞挂？** merge 前置条件：verify 全部通过 + 评分达标 + `AUTO_MERGE=true` + 带 `bot-authored` 标签，四者缺一不可。
- **Windows 本地**：评分引擎和安装脚本都兼容 PowerShell 5 + Node 18+，无其他依赖。

## 许可与来源

- pstack 由 [Lauren Tan (@poteto)](https://github.com/cursor/plugins/tree/main/pstack) 创作，MIT 许可，本模板不包含其代码，仅提供安装脚本与调用规范。
- 本模板本体为示例性质，MIT 许可，可自由复制修改。
