#!/bin/bash
# 0.14 门：幽灵子命令非零退出（真跑 dist）+死命令下架+input-queue 删除+tag+AGENTS.md
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
node dist/cli.js mcp </dev/null >/tmp/moss-mcp.out 2>/tmp/moss-mcp.err && { echo "FAIL: moss mcp 仍退出 0"; exit 1; } || rc=$?
grep -qiE "unknown|unsupported|not (supported|available)|未知|不支持" /tmp/moss-mcp.err || { echo "FAIL: moss mcp 无明确报错"; cat /tmp/moss-mcp.err; exit 1; }
for c in plugins migrate web agent update; do
  if node dist/cli.js "$c" </dev/null >/dev/null 2>&1; then echo "FAIL: moss $c 仍退出 0"; exit 1; fi
done
npm run test:filter -- --filter command-surface >/dev/null 2>&1 || { echo "FAIL: command-surface spec 未过"; exit 1; }
[ ! -f src/cli/input-queue.ts ] || { echo "FAIL: input-queue.ts 未删"; exit 1; }
git rev-parse -q --verify 'refs/tags/v0.14.0' >/dev/null || { echo "FAIL: tag v0.14.0"; exit 1; }
git show v0.14.0:AGENTS.md | grep -q "src/core/mcp/" || { echo "FAIL: AGENTS.md 未含解冻后的结构导航"; exit 1; }
echo "OK v0.14 gate"
