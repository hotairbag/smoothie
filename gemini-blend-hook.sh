#!/bin/bash
#
# gemini-blend-hook.sh — BeforeTool hook for exit_plan_mode (Gemini CLI)
#
# Same as auto-blend-hook.sh but adapted for Gemini CLI:
# - BeforeTool instead of PreToolUse
# - exit_plan_mode instead of ExitPlanMode
# - Reads plan from tool_input.plan_path instead of tailing transcript
#
# Caveat: only fires when the agent calls exit_plan_mode itself,
# not when user manually toggles via /plan or Shift+Tab.
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
    echo '{"hookSpecificOutput":{"hookEventName":"BeforeTool","permissionDecision":"allow"}}'
    exit 0
  fi
fi

# Try to read plan from tool_input.plan_path (Gemini provides this)
PLAN_PATH=$(echo "$INPUT" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get('tool_input', {}).get('plan_path', ''))
except:
  print('')
" 2>/dev/null)

PLAN_CONTEXT=""
if [ -n "$PLAN_PATH" ] && [ -f "$PLAN_PATH" ]; then
  PLAN_CONTEXT=$(cat "$PLAN_PATH" 2>/dev/null | head -c 16000)
fi

# Fallback: read from transcript if plan_path not available
if [ -z "$PLAN_CONTEXT" ]; then
  TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get('transcript_path', ''))
except:
  print('')
" 2>/dev/null)

  if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    PLAN_CONTEXT=$(tail -c 4000 "$TRANSCRIPT_PATH" 2>/dev/null)
  fi
fi

if [ -z "$PLAN_CONTEXT" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"BeforeTool","permissionDecision":"allow"}}'
  exit 0
fi

# Build the review prompt
REVIEW_PROMPT="You are reviewing a plan that Gemini CLI generated. Analyze it for:
- Missing steps or edge cases
- Better approaches or optimizations
- Potential bugs or issues
- Security concerns

Here is the plan:

$PLAN_CONTEXT

Provide concise, actionable feedback. Focus only on things that should change."

# Run the blend (progress shows on stderr, results on stdout)
BLEND_RESULTS=$(echo "$REVIEW_PROMPT" | node "$SCRIPT_DIR/dist/blend-cli.js" 2>/dev/stderr)

# Generate share link (metadata only, no raw content)
SHARE_URL=""
SHARE_PARAMS=$(echo "$BLEND_RESULTS" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try {
      const r=JSON.parse(d);
      const models=r.results.map(m=>m.model).join(',');
      const times=r.results.map(m=>m.elapsed_s||0).join(',');
      const tokens=r.results.map(m=>(m.tokens&&m.tokens.total)||0).join(',');
      console.log('models='+encodeURIComponent(models)+'&times='+encodeURIComponent(times)+'&tokens='+encodeURIComponent(tokens)+'&type=plan');
    } catch { console.log(''); }
  });
" 2>/dev/null)

if [ -n "$SHARE_PARAMS" ]; then
  SHARE_URL=$(curl -s --max-time 5 --connect-timeout 3 -X POST "https://api.smoothiecode.com/api/share" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"report\",\"data\":\"$SHARE_PARAMS\"}" 2>/dev/null | node -e "
      let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
        try{console.log(JSON.parse(d).url)}catch{console.log('')}
      });
    " 2>/dev/null) || true
fi

if [ -z "$BLEND_RESULTS" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"BeforeTool","permissionDecision":"allow"}}'
  exit 0
fi

# Build the additionalContext string
CONTEXT="🧃 Smoothie auto-blend results — multiple models reviewed this plan:

$BLEND_RESULTS

IMPORTANT — You must do TWO things:

1. FIRST, show a Smoothie report table. Use elapsed_s and tokens from each result:

🧃 Smoothie reviewed this plan (N models, Xs total):

| Model | Time | Tokens | Verdict | Feedback |
|-------|------|--------|---------|----------|
| ModelName | 3.1s | 1,847 | useful | one-line summary |
| ModelName | 8.2s | 2,104 | generic | one-line summary |
(skip errored/empty models. Verdict = useful, generic, or irrelevant)

2. THEN proceed with implementation as planned, incorporating valid Smoothie suggestions as you go. Do NOT stop to revise — start coding immediately.
$([ -n "$SHARE_URL" ] && echo "
Share: $SHARE_URL")"

# Return: allow exit_plan_mode but inject blend results
node -e "
  const ctx = $(echo "$CONTEXT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'BeforeTool',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Smoothie auto-blend completed',
      additionalContext: ctx
    }
  }));
"

exit 0
