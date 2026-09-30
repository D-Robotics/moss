#!/bin/bash
# 0.19 门：会话/fork/子代理面板 spec+内部 bench 抽样+tag
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
for f in test/tui-sessions.spec.mjs test/tui-subagents.spec.mjs; do
  git show v0.19.0:"$f" >/dev/null 2>&1 || { echo "FAIL: v0.19.0 缺 $f"; exit 1; }
done
npm run test:filter -- --filter tui >/dev/null 2>&1 || { echo "FAIL: tui spec 全量"; exit 1; }
f=.autopilot/evidence/boards/bench-sample-v019.json
[ -f "$f" ] || { echo "FAIL: 证据缺失 $f"; exit 1; }
node -e '
const fs=require("fs");const b=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/bench-sample-v019.json","utf8"));
if(b.tasks<5||b.pass!==b.tasks){console.error("FAIL: 抽样 "+b.pass+"/"+b.tasks);process.exit(1);}
console.log("OK v0.19 sample "+b.pass+"/"+b.tasks);'
git rev-parse -q --verify 'refs/tags/v0.19.0' >/dev/null || { echo "FAIL: tag v0.19.0"; exit 1; }
echo "OK v0.19 gate"
