#!/bin/sh
# ---------------------------------------------------------------------------
# dsh-subagent-clean —— macOS / Linux 包装脚本
# 需要 Node.js >= 22（内置 zlib 的 zstd）。找不到时可用 DSH_NODE 指定 node。
# 用法: ./clean.sh list | dismiss --session <id> [--apply] | purge ... | orphans | restore ...
# ---------------------------------------------------------------------------
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

find_node() {
  if [ -n "$DSH_NODE" ] && [ -x "$DSH_NODE" ]; then printf '%s\n' "$DSH_NODE"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for c in "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
           /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node /snap/bin/node; do
    if [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}

NODE=$(find_node)
if [ -z "$NODE" ]; then
  echo "[clean] 找不到 Node.js（需要 >= 22）。请安装 Node，或设 DSH_NODE 指向 node。" >&2
  exit 1
fi
exec "$NODE" "$DIR/clean.mjs" "$@"
