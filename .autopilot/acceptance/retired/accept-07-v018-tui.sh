#!/bin/bash
# 0.18 门：steer/queue/后台/审批/用量 spec 真跑+tag
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
for f in test/tui-steer.spec.mjs test/tui-queue.spec.mjs test/tui-usage.spec.mjs; do
  git show v0.18.0:"$f" >/dev/null 2>&1 || { echo "FAIL: v0.18.0 缺 $f"; exit 1; }
done
npm run test:filter -- --filter tui >/dev/null 2>&1 || { echo "FAIL: tui spec 全量"; exit 1; }
npm run test:filter -- --filter approval >/dev/null 2>&1 || { echo "FAIL: approval spec 回退"; exit 1; }
git rev-parse -q --verify 'refs/tags/v0.18.0' >/dev/null || { echo "FAIL: tag v0.18.0"; exit 1; }
echo "OK v0.18 gate"
