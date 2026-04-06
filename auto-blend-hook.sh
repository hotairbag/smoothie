#!/bin/bash
#
# auto-blend-hook.sh — PreToolUse hook for ExitPlanMode
#
# Intercepts plan approval, runs Smoothie blend on the plan,
# and injects results back so Claude revises before you see it.
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read hook input from stdin
INPUT=$(cat)

# Check if auto-blend is enabled in config
if [ -f "$SCRIPT_DIR/config.json" ]; then
  AUTO_ENABLED=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('$SCRIPT_DIR/config.json','utf8'));
      console.log(c.auto_blend === true ? 'true' : 'false');
    } catch(e) { console.log('false'); }
  " 2>/dev/null)

  if [ "$AUTO_ENABLED" != "true" ]; then
    # Auto-blend disabled — allow ExitPlanMode without intervention
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
    exit 0
  fi
fi

# Extract transcript path
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get('transcript_path', ''))
except:
  print('')
" 2>/dev/null)

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Extract the plan from the last ~4000 chars of the transcript
PLAN_CONTEXT=$(tail -c 4000 "$TRANSCRIPT_PATH" 2>/dev/null)

if [ -z "$PLAN_CONTEXT" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Build the review prompt
REVIEW_PROMPT="You are reviewing a plan that Claude Code generated. Analyze it for:
- Missing steps or edge cases
- Better approaches or optimizations
- Potential bugs or issues
- Security concerns

Here is the plan context (from the conversation transcript):

$PLAN_CONTEXT

Provide concise, actionable feedback. Focus only on things that should change."

# Run the blend (progress shows on stderr, results on stdout)
BLEND_RESULTS=$(echo "$REVIEW_PROMPT" | node "$SCRIPT_DIR/dist/blend-cli.js" 2>/dev/stderr)

if [ -z "$BLEND_RESULTS" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Build the additionalContext string
CONTEXT="🧃 Smoothie auto-blend results — multiple models reviewed this plan:

$BLEND_RESULTS

Revise the plan above based on this feedback. Incorporate valid suggestions, discard irrelevant ones. Present the improved plan to the user."

# Return: allow ExitPlanMode but inject blend results
node -e "
  const ctx = $(echo "$CONTEXT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Smoothie auto-blend completed',
      additionalContext: ctx
    }
  }));
"

exit 0
