# pstack 安装向导（Windows / PowerShell 5 兼容）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/install-pstack.ps1
#       powershell -ExecutionPolicy Bypass -File scripts/install-pstack.ps1 -SkillsCli   # 用社区镜像按技能安装
#       powershell -ExecutionPolicy Bypass -File scripts/install-pstack.ps1 -OpenPstack  # 用 open-pstack 社区移植

param(
  [switch]$SkillsCli,
  [switch]$OpenPstack
)

$ErrorActionPreference = 'Continue'

function Test-Cmd($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host ""
Write-Host "== pstack 安装向导 ==" -ForegroundColor Cyan
Write-Host "pstack 是 Lauren Tan 的 Agent Skills 工程技能库（MIT），入口技能 poteto-mode。" -ForegroundColor DarkGray

if (-not (Test-Cmd 'claude')) {
  Write-Host "[警告] 未检测到 claude CLI。请先安装 Claude Code：" -ForegroundColor Yellow
  Write-Host "  npm install -g @anthropic-ai/claude-code" -ForegroundColor Yellow
}

if ($SkillsCli) {
  Write-Host ""
  Write-Host ">> 方案 A：npx skills 社区镜像（backnotprop/pstack，逐技能安装，跨 agent 通用）" -ForegroundColor Cyan
  Write-Host "   会进入交互列表：搜索 pstack 选择要装的技能（poteto-mode 会自动带依赖），再选 Claude Code。" -ForegroundColor DarkGray
  if (-not (Test-Cmd 'npx')) { Write-Host "[错误] 未检测到 npx，请先安装 Node.js >= 18" -ForegroundColor Red; exit 1 }
  npx -y skills add backnotprop/pstack
  exit $LASTEXITCODE
}

if ($OpenPstack) {
  Write-Host ""
  Write-Host ">> 方案 B：open-pstack 社区移植（ericlitman/open-pstack，支持多模型面板）" -ForegroundColor Cyan
  if (-not (Test-Cmd 'claude')) { Write-Host "[错误] 未检测到 claude CLI" -ForegroundColor Red; exit 1 }
  claude plugin marketplace add ericlitman/open-pstack
  claude plugin install pstack@open-pstack
  Write-Host "完成。进入 Claude Code 后运行 /pstack:setup-pstack 选模型。" -ForegroundColor Green
  exit 0
}

# 默认：官方 cursor/plugins 市场（Lauren 原版，Claude 模型版最省事）
Write-Host ""
Write-Host ">> 默认方案：官方 cursor/plugins 市场（Lauren 原版 pstack，Claude Code 适配版）" -ForegroundColor Cyan
if (Test-Cmd 'claude') {
  Write-Host "尝试自动安装…" -ForegroundColor DarkGray
  claude plugin marketplace add cursor/plugins
  claude plugin install pstack@cursor-plugins
  if ($LASTEXITCODE -eq 0) {
    Write-Host "完成。进入 Claude Code 后运行 /pstack:setup-pstack 选择模型。" -ForegroundColor Green
    Write-Host "日常用法：任何需要严谨工程的任务用 /pstack:poteto-mode 开头。" -ForegroundColor Green
    exit 0
  }
  Write-Host "[提示] 自动安装未成功（可能是 CLI 版本差异），请在 Claude Code 交互界面手动执行：" -ForegroundColor Yellow
  Write-Host "  /plugin marketplace add cursor/plugins" -ForegroundColor Yellow
  Write-Host "  /plugin install pstack@cursor-plugins" -ForegroundColor Yellow
} else {
  Write-Host "未检测到 claude CLI，跳过自动安装。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host ">> 替代方案（无需插件机制，适合任意 agent）" -ForegroundColor Cyan
Write-Host "  npx skills add backnotprop/pstack   # 社区镜像，逐技能装到 Claude Code/Codex/Cursor 等" -ForegroundColor DarkGray
Write-Host "  claude plugin marketplace add ericlitman/open-pstack; claude plugin install pstack@open-pstack" -ForegroundColor DarkGray
