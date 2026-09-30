#!/bin/bash
# SWE-bench 基线+确定性证据（实例数≥50、2 采样、重跑差异≤1）
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
for f in .autopilot/evidence/boards/swe-baseline.json .autopilot/evidence/boards/swe-determinism.json; do
  [ -f "$f" ] || { echo "FAIL: 证据缺失 $f"; exit 1; }
done
node -e '
const fs=require("fs");
const b=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/swe-baseline.json","utf8"));
if(!(b.instances>=50)) {console.error("FAIL: 子集 "+b.instances+" < 50");process.exit(1);}
if(!(b.samples>=2)){console.error("FAIL: samples "+b.samples+" < 2");process.exit(1);}
if(typeof b.resolvedPct!=="number"){console.error("FAIL: 无 resolvedPct");process.exit(1);}
if(!b.sha||!b.model){console.error("FAIL: 缺 sha/model 口径");process.exit(1);}
const d=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/swe-determinism.json","utf8"));
if(!(d.diffInstances<=1)){console.error("FAIL: 确定性 diff="+d.diffInstances+" > 1");process.exit(1);}
console.log("OK swe-baseline instances="+b.instances+" resolved="+b.resolvedPct+"% detDiff="+d.diffInstances);'
