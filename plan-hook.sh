#!/bin/bash

INPUT=$(cat)

STOP_ACTIVE=$(echo "$INPUT" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get('stop_hook_active', False))
except:
  print(False)
" 2>/dev/null)

if [ "$STOP_ACTIVE" = "True" ]; then
  exit 0
fi

TRANSCRIPT=$(echo "$INPUT" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get('transcript_path', ''))
except:
  print('')
" 2>/dev/null)

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

IS_PLAN=$(tail -c 3000 "$TRANSCRIPT" | grep -c "Would you like to proceed\|## Plan\|### Plan\|Here's my plan\|Here is my plan\|Steps to\|Step 1\b\|step 1\b" 2>/dev/null || true)

if [ "$IS_PLAN" -gt 0 ]; then
  echo ""
  echo "🧃 Smoothie: type 'smoothie' in option 5 to blend this plan before approving."
fi

exit 0
