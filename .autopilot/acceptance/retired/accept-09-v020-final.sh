#!/bin/bash
# 0.20 门：Windows 证据或如实标注+性能预算+全榜复核+全命令遍历+tag
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
for f in .autopilot/evidence/boards/windows-pty.json .autopilot/evidence/boards/perf-budget.json .autopilot/evidence/boards/swe-v020.json .autopilot/evidence/boards/full-bench-v020.json; do
  [ -f "$f" ] || { echo "FAIL: 证据缺失 $f"; exit 1; }
done
node -e '
const fs=require("fs");
const w=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/windows-pty.json","utf8"));
if(!(w.cases>=3||w.documentedFallback===true)){console.error("FAIL: Windows 无 3 例证据且未如实标注");process.exit(1);}
const p=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/perf-budget.json","utf8"));
if(!(p.lines>=10000&&p.pass===true)){console.error("FAIL: 性能预算未过");process.exit(1);}
const fb=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/full-bench-v020.json","utf8"));
if(fb.easy!==100||Number(fb.hard)<93.9){console.error("FAIL: 内部 bench easy="+fb.easy+" hard="+fb.hard);process.exit(1);}
const v15=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/swe-v015.json","utf8"));
const v20=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/swe-v020.json","utf8"));
if(!(v20.resolvedPct>=v15.resolvedPct)){console.error("FAIL: SWE 低于 0.15 水平");process.exit(1);}
console.log("OK v0.20 windows="+(w.cases||"fallback")+" perf="+p.lines+" easy=100 hard="+fb.hard);'
npm run test:filter -- --filter command-surface >/dev/null 2>&1 || { echo "FAIL: 全命令遍历 spec"; exit 1; }
git rev-parse -q --verify 'refs/tags/v0.20.0' >/dev/null || { echo "FAIL: tag v0.20.0"; exit 1; }
echo "OK v0.20 gate"
