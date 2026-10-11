#!/usr/bin/env bash
# Run the full ContextQuant eval on the API models, then print the summary.
#
#   eval/run-all.sh             run (or resume) everything
#   eval/run-all.sh --approve   same, and record that you've reviewed the eval code
#                               (needed the first time and after any change to it)
#   REPS=1 eval/run-all.sh      fewer repeats for a quick look
#
# Safe to stop (Ctrl-C) and re-run: finished answers are kept and skipped.
# Each model logs to .claude/hillclimb/<flow>/run.log. Keys come from .env.
set -uo pipefail

# Keep the Mac awake for the whole run (the work itself happens on Google's servers).
# Before the cd, so "$0" still resolves from the caller's directory.
if [[ -z "${CQ_AWAKE:-}" ]] && command -v caffeinate > /dev/null; then
  CQ_AWAKE=1 exec caffeinate -i "$0" "$@"
fi
cd "$(dirname "$0")/.."

APPROVE=()
[[ "${1:-}" == "--approve" ]] && APPROVE=(--approve-harness)
REPS="${REPS:-3}"

# flow | model | concurrency | variants
# Round 2 (counts in the notes + partial questions). Round-1 flows stay as they were.
# Gemma's free tier allows 16k input tokens/minute and full JSON is ~30k, so it skips baseline.
# Gemini 3.8 Flash runs through agy: the API key's free daily quota was ~20 requests.
MODELS=(
  "people-gemma4-r2|gemini:gemma-4-26b-a4b-it|2|v2 v1 v3"
  "people-gemini-flash-r2|agy:gemini-3.8-flash-low|2|v2 v1 v3 baseline"
)

run_model() {
  local flow=$1 model=$2 conc=$3 variants=$4 log=".claude/hillclimb/$1/run.log"
  mkdir -p ".claude/hillclimb/$flow"
  for v in $variants; do
    echo "== $(date '+%H:%M:%S') $flow $v" >> "$log"
    bun eval/run-eval.mjs --flow ".claude/hillclimb/$flow" --variant "$v" --model "$model" \
      --reps "$REPS" --concurrency "$conc" ${APPROVE[@]+"${APPROVE[@]}"} >> "$log" 2>&1
    case $? in
      0) ;;
      2) echo "$flow: runner refused to start (see $log). Re-run with --approve after reviewing the eval code."; return ;;
      *) echo "$flow $v: some questions failed (rate limit or daily quota?). Re-run later to retry just those." ;;
    esac
  done
  echo "$flow: finished ($(date '+%H:%M:%S'))"
}

echo "Running ${#MODELS[@]} models in parallel, $REPS repeats each. Logs: .claude/hillclimb/<flow>/run.log"
for m in "${MODELS[@]}"; do
  IFS='|' read -r flow model conc variants <<< "$m"
  run_model "$flow" "$model" "$conc" "$variants" &
done
wait

bun eval/summary.ts people-gemma4 people-gemma4-r2 people-gemini-flash people-gemini-flash-r2
