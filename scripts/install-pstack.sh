#!/usr/bin/env bash
# pstack 安装向导（Linux / macOS）
# 用法：
#   bash scripts/install-pstack.sh            # 官方 cursor/plugins 市场（默认）
#   bash scripts/install-pstack.sh --skills   # npx skills 社区镜像
#   bash scripts/install-pstack.sh --open     # open-pstack 社区移植
set -u

MODE="default"
[ "${1:-}" = "--skills" ] && MODE="skills"
[ "${1:-}" = "--open" ] && MODE="open"

echo ""
echo "== pstack 安装向导 =="
echo "pstack 是 Lauren Tan 的 Agent Skills 工程技能库（MIT），入口技能 poteto-mode。"

command -v claude >/dev/null 2>&1 || {
  echo "[警告] 未检测到 claude CLI。请先安装：npm install -g @anthropic-ai/claude-code"
}

if [ "$MODE" = "skills" ]; then
  echo ">> 方案 A：npx skills 社区镜像（backnotprop/pstack，逐技能安装）"
  command -v npx >/dev/null 2>&1 || { echo "[错误] 未检测到 npx，请先安装 Node.js >= 18"; exit 1; }
  exec npx -y skills add backnotprop/pstack
fi

if [ "$MODE" = "open" ]; then
  echo ">> 方案 B：open-pstack 社区移植（ericlitman/open-pstack）"
  command -v claude >/dev/null 2>&1 || { echo "[错误] 未检测到 claude CLI"; exit 1; }
  claude plugin marketplace add ericlitman/open-pstack
  claude plugin install pstack@open-pstack
  echo "完成。进入 Claude Code 后运行 /pstack:setup-pstack 选模型。"
  exit 0
fi

echo ">> 默认方案：官方 cursor/plugins 市场（Lauren 原版，Claude Code 适配版）"
if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add cursor/plugins
  claude plugin install pstack@cursor-plugins
  if [ $? -eq 0 ]; then
    echo "完成。进入 Claude Code 后运行 /pstack:setup-pstack 选择模型。"
    echo "日常用法：任何需要严谨工程的任务用 /pstack:poteto-mode 开头。"
    exit 0
  fi
  echo "[提示] 自动安装未成功，请在 Claude Code 交互界面手动执行："
  echo "  /plugin marketplace add cursor/plugins"
  echo "  /plugin install pstack@cursor-plugins"
fi

echo ""
echo ">> 替代方案："
echo "  npx skills add backnotprop/pstack"
echo "  claude plugin marketplace add ericlitman/open-pstack && claude plugin install pstack@open-pstack"
