#!/usr/bin/env bash
# One RSI batch: N episodes of ONE task in ONE simulator session, then record.
#
#   rsi_batch.sh --id <label> --task <task> --episodes <n> [--calls 60] [--keep-images 1]
#
# Uses --eval-num N with ROBODOJO_NUM_ENVS=1 (verified: N episodes run sequentially
# in a single process, one Isaac startup). Reads the official _result.json only;
# a run without one is recorded as a harness failure, never as a score.
set -euo pipefail

id=""; task=general_pickup; episodes=5; calls=60; keep_images=0
while [ $# -gt 0 ]; do
  case "$1" in
    --id) id=$2; shift 2 ;;
    --task) task=$2; shift 2 ;;
    --episodes) episodes=$2; shift 2 ;;
    --calls) calls=$2; shift 2 ;;
    --keep-images) keep_images=$2; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
[ -n "$id" ] || { echo "--id is required" >&2; exit 2; }

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ledger="$repo_dir/docs/research/roboprobe-rsi-ledger.tsv"
[ -f "$ledger" ] || printf 'iteration\tplanner\ttask\tlayouts\tepisodes\tsuccesses\tsr\tscore\twall_s\tframes\tnotes\n' > "$ledger"

export PATH=/usr/local/bin:/root/miniconda3/bin:/root/.local/bin:$PATH
export ROBODOJO_ROOT=${ROBODOJO_ROOT:-/root/RoboDojo}
export ROBODOJO_NUM_ENVS=1
export ROBODOJO_UNTILED_CAMERAS=0
export ROBODOJO_KIT_ARGS="--/crashreporter/enabled=false --/rtx/dataWindow/fitOutputToDataWindow=true --/rtx/dataWindowNDC/0=0 --/rtx/dataWindowNDC/1=0 --/rtx/dataWindowNDC/2=1 --/rtx/dataWindowNDC/3=1"
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json
export VK_DRIVER_FILES=/usr/share/vulkan/icd.d/nvidia_icd.json
export PYTHONPATH="$ROBODOJO_ROOT/XPolicyLab:$ROBODOJO_ROOT:${PYTHONPATH:-}"
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:?}"
export L3_INSPECT_PLANNER=deepseek
export L3_INSPECT_BASE_URL=https://api.deepseek.com/v1
export L3_INSPECT_API_KEY_ENV=DEEPSEEK_API_KEY
export L3_INSPECT_MODEL=deepseek-flash
export L3_INSPECT_REASONING_EFFORT=max
export L3_INSPECT_MAX_LLM_CALLS="$calls"
export L3_INSPECT_KEEP_ALL_IMAGES="$keep_images"
export L3_INSPECT_HARD_TIMEOUT_S=420
export L3_INSPECT_TRACE_DIR="/tmp/l3trace-$id"
export XLA_PYTHON_CLIENT_PREALLOCATE=false
unset DISPLAY

cd "$ROBODOJO_ROOT"
start=$(date +%s)
xvfb-run -a -s "-screen 0 1920x1080x24" bash scripts/robodojo.sh eval \
  --policy-dir XPolicyLab/policy/RoboDojo_Agent_L3_Inspect_EEF --ckpt sim \
  --policy-env uv --env-cfg arx_x5 --action-type joint --task "$task" \
  --eval-num "$episodes" --policy-gpu 0 --env-gpu 0 --eval-env uv || true
wall=$(( $(date +%s) - start ))

result=$(find "$ROBODOJO_ROOT/eval_result/RoboDojo/$task" -name '_result.json' -newermt "-$((wall + 60))s" 2>/dev/null | head -1)
frames="$repo_dir/docs/assets/roboprobe/$id"
if [ -n "$result" ] && [ -f "$result" ]; then
  dir=$(dirname "$result")
  bash "$repo_dir/docs/bench/roboprobe/extract_frames.sh" "$dir" "$frames" 1 3 5 >/dev/null 2>&1 || true
  row=$(python3 - "$result" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
det = d.get("details") or {}
wins = sum(1 for v in det.values() if v.get("success"))
eps = int(d.get("eval_time") or len(det) or 0)
print(f"{eps}\t{wins}\t{float(d.get('success_rate') or 0):.4f}\t{float(d.get('score') or 0):.2f}")
PY
)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" deepseek "$task" "$episodes" "$row" "$wall" "$frames" >> "$ledger"
  echo "batch $id: $(printf '%s' "$row") wall=${wall}s frames=$frames"
else
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" deepseek "$task" "$episodes" "0" "0" "0" "0" "$wall" "$frames" >> "$ledger"
  echo "batch $id: no _result.json (harness failure), wall=${wall}s" >&2
  exit 1
fi
