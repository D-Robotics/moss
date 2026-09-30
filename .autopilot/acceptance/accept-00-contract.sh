#!/bin/bash
# 合同完整性（全程不变量）：pending 验收器 10 个可执行+先红记录完整+路线图在位+分支正确
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
n=$(find .autopilot/acceptance/pending -maxdepth 1 -name "*.sh" -perm +111 2>/dev/null | wc -l | tr -d " ")
[ "${n:-0}" -ge 1 ] || { echo "FAIL: pending 验收器 $n < 1（应至少留有未毕业验收器）"; exit 1; }
r=$(grep -c "RED-as-expected" .autopilot/evidence/sprint-000/verifier-red-check.log 2>/dev/null || true)
[ "${r:-0}" = "10" ] || { echo "FAIL: 先红自检记录 ${r:-0}/10"; exit 1; }
g=$(grep -c "UNEXPECTED-GREEN" .autopilot/evidence/sprint-000/verifier-red-check.log 2>/dev/null || true)
[ "${g:-0}" = "0" ] || { echo "FAIL: 先红自检出现 ${g:-0} 个意外绿"; exit 1; }
[ -f docs/superpowers/plans/2026-09-30-moss-v014-v020-roadmap.md ] || { echo "FAIL: 路线图缺失"; exit 1; }
b=$(git branch --show-current)
[ "$b" = "autopilot/v014-v020" ] || { echo "FAIL: 分支 $b 不是 autopilot/v014-v020"; exit 1; }
echo "OK contract integrity (pending=$n, red-check=10/10)"
