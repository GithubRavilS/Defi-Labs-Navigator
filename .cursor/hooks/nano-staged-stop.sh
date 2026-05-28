#!/usr/bin/env bash
# Project-local stop hook (same logic as ~/.cursor/hooks/nano-staged-stop.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GLOBAL="$HOME/.cursor/hooks/nano-staged-stop.sh"
if [ -x "$GLOBAL" ]; then
  exec "$GLOBAL"
fi
if [ -x "$ROOT/node_modules/.bin/nano-staged" ] && [ -f "$ROOT/.nano-staged.json" ]; then
  cd "$ROOT"
  ./node_modules/.bin/nano-staged --unstaged --quiet --bail && echo '{}' || {
    jq -n --arg msg "Fix lint/format (nano-staged failed). Run: npm run lint" '{followup_message: $msg}'
  }
  exit 0
fi
echo '{}'
