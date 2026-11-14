# DeepSeek Anthropic 兼容端点配置向导（ai-bot-team 推荐路线）
# 效果：设置 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL，
#       Claude Code 即走国产模型官方端点，模板零改动可用。
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/setup-deepseek.ps1            # DeepSeek，默认模型 deepseek-v4-pro
#   powershell -ExecutionPolicy Bypass -File scripts/setup-deepseek.ps1 -Persist   # 同时写入 $PROFILE，新窗口永久生效
#   powershell -ExecutionPolicy Bypass -File scripts/setup-deepseek.ps1 -Provider glm -Model glm-4.6
#   powershell -ExecutionPolicy Bypass -File scripts/setup-deepseek.ps1 -Provider kimi -Model kimi-k2.5
#   powershell -ExecutionPolicy Bypass -File scripts/setup-deepseek.ps1 -Provider custom -BaseUrl https://你的端点 -Model 你的模型

param(
  [ValidateSet('deepseek', 'glm', 'kimi', 'custom')]
  [string]$Provider = 'deepseek',
  [string]$BaseUrl = '',
  [string]$Model = '',
  [switch]$Persist
)

$ErrorActionPreference = 'Stop'

$presets = @{
  deepseek = @{ url = 'https://api.deepseek.com/anthropic'; model = 'deepseek-v4-pro' }
  glm      = @{ url = 'https://open.bigmodel.cn/api/anthropic'; model = '' }
  kimi     = @{ url = 'https://api.moonshot.cn/anthropic'; model = '' }
}

if ($Provider -eq 'custom' -and -not $BaseUrl) {
  Write-Host '[错误] -Provider custom 需要 -BaseUrl' -ForegroundColor Red
  exit 1
}

$url = if ($BaseUrl) { $BaseUrl } else { $presets[$Provider].url }
$model = if ($Model) { $Model }
         elseif ($presets[$Provider].model) { $presets[$Provider].model }
         else { Read-Host "输入 $Provider 的模型名" }

Write-Host ''
Write-Host "== Claude Code 国产端点配置（$Provider）==" -ForegroundColor Cyan
Write-Host "端点：$url" -ForegroundColor DarkGray
Write-Host "模型：$model" -ForegroundColor DarkGray

$secure = Read-Host '粘贴 API Key（sk-...，输入已遮蔽）' -AsSecureString
$key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $key) { Write-Host '[取消] 未输入 Key，退出。' -ForegroundColor Yellow; exit 0 }

$env:ANTHROPIC_BASE_URL   = $url
$env:ANTHROPIC_AUTH_TOKEN = $key
$env:ANTHROPIC_MODEL      = $model
Write-Host '当前会话已生效。' -ForegroundColor Green

if ($Persist) {
  $profilePath = $PROFILE
  $block = @"
# >>> ai-bot-team Claude Code 端点（自动生成，可整块删除）>>>
`$env:ANTHROPIC_BASE_URL   = "$url"
`$env:ANTHROPIC_AUTH_TOKEN = "$key"
`$env:ANTHROPIC_MODEL      = "$model"
# <<< ai-bot-team >>>
"@
  $dir = Split-Path $profilePath -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $existing = if (Test-Path $profilePath) { Get-Content $profilePath -Raw } else { '' }
  $pattern = '(?s)# >>> ai-bot-team.*?<<< ai-bot-team >>>'
  if ($existing -match $pattern) {
    $existing = [regex]::Replace($existing, $pattern, { param($m) $block })
  } else {
    if ($existing -and -not $existing.EndsWith("`n")) { $existing += "`n" }
    $existing += $block
  }
  Set-Content -Path $profilePath -Value $existing -Encoding UTF8
  Write-Host "已写入 $profilePath（新开 PowerShell 窗口自动生效）。" -ForegroundColor Green
  Write-Host '注意：Key 以明文存在 $PROFILE 里，本机多用户环境请注意安全。' -ForegroundColor Yellow
} else {
  Write-Host '提示：本会话关闭后失效。加 -Persist 可写入 $PROFILE 永久生效。' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '验证：新开终端跑 claude，/status 应显示当前模型。' -ForegroundColor DarkGray
Write-Host 'CI 侧：仓库 Secrets 配 ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN，Variables 可选配 AGENT_MODEL。' -ForegroundColor DarkGray
