#!/usr/bin/env bash
# One RoboProbe RSI iteration: evaluate, record, extract evidence, append ledger.
#
#   rsi_runner.sh --id <label> --task <task> --layouts <spec> --episodes <n> --planner <deepseek|moss>
#
# Writes   eval_result/.../_result.json           (benchmark truth, untouched)
#          docs/assets/roboprobe/<id>/*.jpg        (episode frames)
#          docs/research/roboprobe-rsi-ledger.tsv (one row per iteration)
# and refuses to invent a score: every number comes from the task's own
# _result.json. RoboDojo is the only scorer.
set -euo pipefail

id=""; task=general_pickup; layouts=0; episodes=1; planner=deepseek
while [ $# -gt 0 ]; do
  case "$1" in
    --id) id=$2; shift 2 ;;
    --task) task=$2; shift 2 ;;
    --layouts) layouts=$2; shift 2 ;;
    --episodes) episodes=$2; shift 2 ;;
    --planner) planner=$2; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
[ -n "$id" ] || { echo "--id is required (labels the ledger row and the frame dir)" >&2; exit 2; }

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ledger="$repo_dir/docs/research/roboprobe-rsi-ledger.tsv"
[ -f "$ledger" ] || printf 'iteration\tplanner\ttask\tlayouts\tepisodes\tsuccesses\tsr\tscore\twall_s\tframes\tnotes\n' > "$ledger"

export ROBODOJO_ROOT=${ROBODOJO_ROOT:-/root/RoboDojo}
export ROBODOJO_NUM_ENVS=${ROBODOJO_NUM_ENVS:-1}
export ROBODOJO_UNTILED_CAMERAS=${ROBODOJO_UNTILED_CAMERAS:-1}
export L3_INSPECT_PLANNER="$planner"
export L3_INSPECT_MAX_LLM_CALLS=${L3_INSPECT_MAX_LLM_CALLS:-170}
export L3_INSPECT_REASONING_EFFORT=${L3_INSPECT_REASONING_EFFORT:-max}
export PYTHONPATH="$ROBODOJO_ROOT/XPolicyLab:$ROBODOJO_ROOT:${PYTHONPATH:-}"

start=$(date +%s)
cd "$repo_dir"
xvfb-run -a -s "-screen 0 1920x1080x24" bash "$ROBODOJO_ROOT/scripts/robodojo.sh" eval \
  --policy-dir "$ROBODOJO_ROOT/XPolicyLab/policy/RoboDojo_Agent_L3_Inspect_EEF" \
  --ckpt sim --policy-env uv --env-cfg arx_x5 --action-type joint \
  --task "$task" --eval-num "$episodes" --seed 0 --policy-gpu 0 --env-gpu 0 --eval-env uv || true
wall=$(( $(date +%s) - start ))

result=$(find "$ROBODOJO_ROOT/eval_result/RoboDojo/$task" -name '_result.json' -newermt "-${wall}s" 2>/dev/null | head -1)
frames="$repo_dir/docs/assets/roboprobe/$id"
bash "$repo_dir/docs/bench/roboprobe/extract_frames.sh" \
  "$(dirname "${result:-/nonexistent}/x")" "$frames" >/dev/null 2>&1 || true

if [ -n "$result" ] && [ -f "$result" ]; then
  row=$(python3 - "$result" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
episodes = int(d.get("eval_time") or 0)
sr = float(d.get("success_rate") or 0.0)
successes = round(sr * episodes, 3)
print(f"{episodes}\t{successes}\t{sr:.4f}\t{float(d.get('score') or 0.0):.2f}")
PY
)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$planner" "$task" "$layouts" "$row" "$wall" "$frames" "" >> "$ledger"
  echo "ledger row: $id $(printf '%s' "$row") wall=${wall}s result=$result"
else
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$planner" "$task" "$layouts" "0" "0" "0" "0" "$wall" "$frames" "no _result.json — harness did not finish" >> "$ledger"
  echo "no _result.json for $id (wall=${wall}s); recorded as harness failure" >&2
  exit 1
fi
