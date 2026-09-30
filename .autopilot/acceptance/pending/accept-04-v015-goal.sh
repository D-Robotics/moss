#!/bin/bash
# 0.15 门：goal/worktree/hooks spec 真跑+A/B ≥+4pt+cost≤1.5×+SWE ≥+3pt+tag
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
npm run test:filter -- --filter goal-loop >/dev/null 2>&1 || { echo "FAIL: goal-loop spec"; exit 1; }
npm run test:filter -- --filter worktree >/dev/null 2>&1 || { echo "FAIL: worktree spec"; exit 1; }
npm run test:filter -- --filter hooks >/dev/null 2>&1 || { echo "FAIL: hooks spec"; exit 1; }
for f in .autopilot/evidence/boards/ab-goal-loop.json .autopilot/evidence/boards/swe-v015.json .autopilot/evidence/boards/swe-baseline.json; do
  [ -f "$f" ] || { echo "FAIL: 证据缺失 $f"; exit 1; }
done
node -e '
const fs=require("fs");
const ab=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/ab-goal-loop.json","utf8"));
if(!(ab.deltaHard>=4)){console.error("FAIL: hard delta "+ab.deltaHard+" < 4");process.exit(1);}
if(!(ab.costRatio<=1.5||ab.costAdjudicated===true)){console.error("FAIL: costRatio "+ab.costRatio+" > 1.5");process.exit(1);}
const base=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/swe-baseline.json","utf8"));
const v15=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/swe-v015.json","utf8"));
if(!(v15.resolvedPct>=base.resolvedPct+3)){console.error("FAIL: swe "+v15.resolvedPct+" < "+(base.resolvedPct+3));process.exit(1);}
console.log("OK v0.15 deltaHard="+ab.deltaHard+" cost="+ab.costRatio+" swe="+v15.resolvedPct);'
git rev-parse -q --verify 'refs/tags/v0.15.0' >/dev/null || { echo "FAIL: tag v0.15.0"; exit 1; }
echo "OK v0.15 gate"
