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

# Generate share link (metadata only, no raw content)
SHARE_URL=""
SHARE_PARAMS=$(echo "$BLEND_RESULTS" | node -e "
  const fs=require('fs');
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try {
      const r=JSON.parse(d);
      const models=r.results.map(m=>m.model).join(',');
      const times=r.results.map(m=>m.elapsed_s||0).join(',');
      const tokens=r.results.map(m=>(m.tokens&&m.tokens.total)||0).join(',');
      const responded=r.results.filter(m=>!m.response.startsWith('Error:')&&m.response!=='No response content'&&m.response!=='(empty response)').length;
      let github='',judge='Claude Code';
      try{const c=JSON.parse(fs.readFileSync('$SCRIPT_DIR/config.json','utf8'));github=c.github||'';const p=process.env.SMOOTHIE_PLATFORM||'claude';judge={claude:'Claude Code',gemini:'Gemini CLI',codex:'Codex CLI',cursor:'Cursor'}[p]||'Claude Code';}catch{}
      let params='models='+encodeURIComponent(models)+'&times='+encodeURIComponent(times)+'&tokens='+encodeURIComponent(tokens)+'&type=pr&suggestions='+responded+'&judge='+encodeURIComponent(judge);
      if(github)params+='&user='+encodeURIComponent(github);
      console.log(params);
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
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Build the additionalContext string
CONTEXT="🧃 Smoothie PR review — multiple models reviewed this diff:

$BLEND_RESULTS

IMPORTANT — You must do TWO things:

1. FIRST, show a Smoothie report table. Use elapsed_s and tokens from each result:

🧃 Smoothie reviewed this PR (N models, Xs total):

| Model | Time | Tokens | Finding |
|-------|------|--------|---------|
| ModelName | 3.1s | 1,847 | one-line key finding |
(skip errored/empty models)
$([ -n "$SHARE_URL" ] && echo "
Share this report: $SHARE_URL")

2. THEN address any valid issues — fix the code or note them in the PR description."

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
