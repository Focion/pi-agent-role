#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# pi-agent-role examples 一键启动（放在 examples/ 下，从仓库根调用）。
#
# 把启动前置步骤打包：
#   1. Node 版本守卫（≥ 24，本库 engines；且 native type-strip 需 ≥ 22.6）
#   2. 构建 dist（examples 经包自引用 import "@pi/agent-role" → dist）
#   3. 前台跑 node examples/src/main.ts <场景> [flags]（Ctrl+C 直接终止）
#
# 用法：
#   bash examples/start.sh                    # 打印场景菜单
#   bash examples/start.sh chat               # 交互群聊（真实模型，需 demo.config.json）
#   bash examples/start.sh chat --fake        # 无 LLM 冒烟
#   bash examples/start.sh --build scenes     # 强制重建 dist 后跑 scenes
#   bash examples/start.sh agents --personas intj,enfp
#
# 凭据：优先 examples/demo.config.json，缺省回退 ../pi-agent-mesh/examples/demo.config.json。
#   `cp examples/demo.config.example.json examples/demo.config.json` 后按需填模型与凭据。
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD=1; shift ;;
    -h|--help) sed -n '3,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) break ;;
  esac
done

# ── 0. Node 版本守卫 ────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "[examples] 未找到 node，本库要求 Node ≥ 24" >&2
  exit 1
fi
NODE_MAJOR="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
if (( NODE_MAJOR < 22 )); then
  echo "[examples] Node 版本过低（当前 $(node --version)），需 ≥ 22.6 跑 native TS，≥ 24 才是本库 engines" >&2
  exit 1
fi

# ── 1. 构建 dist（examples 自引用 "@pi/agent-role" → dist）──────────────────
if [[ "$BUILD" == 1 || ! -f dist/index.js || ! -f dist/index.d.ts ]]; then
  echo "[examples] 构建 dist（npm run build）…"
  npm run build
else
  echo "[examples] dist 已存在，跳过构建（--build 可强制重建）"
fi

# ── 2. 前台启动 ─────────────────────────────────────────────────────────────
exec node examples/src/main.ts "$@"