#!/bin/bash
# v0.13.0 发布收口：tag+版本+P4 证据+三臂裁决
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git rev-parse -q --verify 'refs/tags/v0.13.0' >/dev/null || { echo "FAIL: tag v0.13.0 缺失"; exit 1; }
git show v0.13.0:package.json | grep -q '"version": "0.13.0"' || { echo "FAIL: v0.13.0 的 package.json 版本不对"; exit 1; }
for f in .autopilot/evidence/boards/p4-full-bench.json .autopilot/evidence/boards/ab-model-routing.json; do
  [ -f "$f" ] || { echo "FAIL: 证据缺失 $f"; exit 1; }
done
node -e '
const fs=require("fs");
const p4=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/p4-full-bench.json","utf8"));
if(p4.easy!==100||Number(p4.hard)<93.9){console.error("FAIL: P4 bench 未达标 easy="+p4.easy+" hard="+p4.hard);process.exit(1);}
const ab=JSON.parse(fs.readFileSync(".autopilot/evidence/boards/ab-model-routing.json","utf8"));
for(const k of ["cheap","balanced","routing"]) if(!(k in ab)){console.error("FAIL: 三臂缺 "+k);process.exit(1);}
if(typeof ab.verdict!=="string"||!ab.verdict){console.error("FAIL: 缺路由裁决");process.exit(1);}
console.log("OK v0.13.0 release evidence easy=100 hard="+p4.hard+" verdict="+ab.verdict);'
