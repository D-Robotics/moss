#!/bin/bash
# 0.17 门：TUI PTY spec 真跑+smoke+tag 树含 tui 模块+SDK 快照零 diff
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
npm run test:filter -- --filter tui >/dev/null 2>&1 || { echo "FAIL: tui spec（含 Esc 中断/粘贴/resume 回放）"; exit 1; }
node scripts/smoke-moss-cli.mjs >/dev/null 2>&1 || { echo "FAIL: smoke（含 TUI/回退分支）"; exit 1; }
git rev-parse -q --verify 'refs/tags/v0.17.0' >/dev/null || { echo "FAIL: tag v0.17.0"; exit 1; }
git show v0.17.0:src/cli/tui/app.ts >/dev/null 2>&1 || { echo "FAIL: v0.17.0 无 src/cli/tui/app.ts"; exit 1; }
d=$(git diff v0.16.0 v0.17.0 -- test/sdk-contract.spec.mjs | wc -l | tr -d " ")
[ "$d" = "0" ] || { echo "FAIL: SDK 快照在 0.17 变更（diff $d 行）——TUI 不得动公共面"; exit 1; }
echo "OK v0.17 gate"
