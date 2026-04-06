#!/bin/bash
#
# pr-blend-hook.sh — PreToolUse hook for Bash commands
#
# Intercepts `gh pr create` commands, runs Smoothie blend on the
# branch diff, and injects review results so Claude can revise
# the PR description before creating it.
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read hook input from stdin
INPUT=$(cat)

# Check if auto-blend is enabled in config
AUTO_ENABLED=$(node -e "
  try {
    const c = JSON.parse(require('fs').readFileSync('$SCRIPT_DIR/config.json','utf8'));
    console.log(c.auto_blend === true ? 'true' : 'false');
  } catch(e) { console.log('false'); }
" 2>/dev/null)

if [ "$AUTO_ENABLED" != "true" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Check if this is a gh pr create command
COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get('tool_input', {}).get('command', ''))
except:
  print('')
" 2>/dev/null)

if ! echo "$COMMAND" | grep -q "gh pr create"; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Extract cwd from hook input
CWD=$(echo "$INPUT" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get('cwd', ''))
except:
  print('')
" 2>/dev/null)

# Get the diff
DIFF=$(cd "$CWD" 2>/dev/null && git diff main...HEAD 2>/dev/null | head -c 4000)

if [ -z "$DIFF" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Build review prompt and run blend
REVIEW_PROMPT="Review this PR diff for bugs, security issues, and improvements:

$DIFF

Provide concise, actionable feedback."

BLEND_RESULTS=$(echo "$REVIEW_PROMPT" | node "$SCRIPT_DIR/dist/blend-cli.js" 2>/dev/stderr)

if [ -z "$BLEND_RESULTS" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Build the additionalContext string
CONTEXT="Smoothie PR review — multiple models reviewed this diff:

$BLEND_RESULTS

Consider this feedback. If there are valid issues, revise the PR description to note them or fix the code before creating the PR."

# Return: allow Bash but inject blend results
node -e "
  const ctx = $(echo "$CONTEXT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Smoothie PR review completed',
      additionalContext: ctx
    }
  }));
"

exit 0
