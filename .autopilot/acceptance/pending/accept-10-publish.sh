#!/bin/bash
# 发布门：七个版本 tag 齐+origin 同步+main 包含 v0.20.0+工作树净
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
for t in v0.13.0 v0.14.0 v0.15.0 v0.16.0 v0.17.0 v0.18.0 v0.19.0 v0.20.0; do
  git rev-parse -q --verify "refs/tags/$t" >/dev/null || { echo "FAIL: 本地缺 $t"; exit 1; }
  git ls-remote --tags origin "refs/tags/$t" | grep -q "$t" || { echo "FAIL: origin 缺 $t"; exit 1; }
done
git fetch -q origin main
local_main=$(git rev-parse main)
remote_main=$(git rev-parse origin/main)
[ "$local_main" = "$remote_main" ] || { echo "FAIL: main 未同步 local=$local_main remote=$remote_main"; exit 1; }
git merge-base --is-ancestor v0.20.0 main || { echo "FAIL: main 不包含 v0.20.0"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "FAIL: 工作树不净"; exit 1; }
echo "OK publish: 8 tags on origin, main synced at $local_main"
