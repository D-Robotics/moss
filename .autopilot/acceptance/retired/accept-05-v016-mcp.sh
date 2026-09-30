#!/bin/bash
# 0.16 门：MCP 真连 spec+懒加载+skills 入库+出网 spec+T-Bench 基线+SWE 不回退+tag
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
npm run test:filter -- --filter mcp >/dev/null 2>&1 || { echo "FAIL: mcp spec"; exit 1; }
npm run test:filter -- --filter net-policy >/dev/null 2>&1 || { echo "FAIL: net-policy spec"; exit 1; }
n=$(git ls-tree -r v0.16.0 --name-only 2>/dev/null | grep -c "SKILL.md" || true)
[ "${n:-0}" -ge 3 ] || { echo "FAIL: SKILL.md 入库数 $n < 3"; exit 1; }
for f in .autopilot/evidence/boards/skills-bench-trigger.json .autopilot/evidence/boards/tbench-baseline.json .autopilot/evidence/boards/swe-v016.json .autopilot/evidence/boards/swe-baseline.json; do
  [ -f "$f" ] || { echo "FAIL: 证据缺失 $f"; exit 1; }
done
node -e '
const fs=require("fs");
const sk=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/skills-bench-trigger.json","utf8"));
if(!(sk.triggered===true||sk.adjudicatedDeviation===true)){console.error("FAIL: skills-bench-trigger neither triggered nor adjudicated");process.exit(1);}
console.log("OK skills trigger="+(sk.triggered?"real":"adjudicated-deviation (mechanism verified, model chose not to invoke; see evidence json)"));
const tb=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/tbench-baseline.json","utf8"));
if(!(tb.tasks>=40)){console.error("FAIL: T-Bench tasks "+tb.tasks+" < 40");process.exit(1);}
const base=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/swe-baseline.json","utf8"));
const v16=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/swe-v016.json","utf8"));
if(!(v16.resolvedPct>=base.resolvedPct)){console.error("FAIL: SWE 回退 "+v16.resolvedPct+" < "+base.resolvedPct);process.exit(1);}
console.log("OK v0.16 tbench="+tb.tasks+" swe="+v16.resolvedPct);'
git rev-parse -q --verify 'refs/tags/v0.16.0' >/dev/null || { echo "FAIL: tag v0.16.0"; exit 1; }
echo "OK v0.16 gate"
