#!/bin/bash
set -e

# Colors
G='\033[0;32m'    # green
Y='\033[1;33m'    # yellow
R='\033[0;31m'    # red
C='\033[0;36m'    # cyan
D='\033[0;90m'    # dim
B='\033[1m'       # bold
N='\033[0m'       # reset

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOTAL_STEPS=7
STEP=0

step() {
  STEP=$((STEP + 1))
  echo ""
  echo -e "  ${D}[$STEP/$TOTAL_STEPS]${N} ${B}$1${N}"
}

spin() {
  local pid=$1 msg=$2
  local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${D}${frames[$i]} $msg${N}  "
    i=$(( (i + 1) % ${#frames[@]} ))
    sleep 0.1
  done
  wait "$pid" 2>/dev/null
  printf "\r  ${G}✓${N} $msg                    \n"
}

clear
echo ""
echo -e "  ${C}${B}"
echo '   ____                   _   _     _'
echo '  / ___| _ __ ___   ___  ___ | |_| |__ (_) ___'
echo '  \___ \| `_ ` _ \ / _ \ / _ \| __| `_ \| |/ _ \'
echo '   ___) | | | | | | (_) | (_) | |_| | | | |  __/'
echo '  |____/|_| |_| |_|\___/ \___/ \__|_| |_|_|\___|'
echo -e "${N}"
echo -e "  ${D}multi-model review for Claude Code${N}"
echo ""
echo -e "  ${D}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"

# ─── Step 1: Dependencies ────────────────────────────────────────────
step "Installing dependencies"

if ! command -v node &>/dev/null; then
  echo -e "  ${R}✗ Node.js not found. Install from https://nodejs.org${N}"
  exit 1
fi
echo -e "  ${G}✓${N} Node $(node --version)"

cd "$SCRIPT_DIR"
npm install --silent 2>/dev/null &
spin $! "npm install"

npm run build 2>&1 >/dev/null &
spin $! "Compiling TypeScript"

npm link --silent 2>/dev/null &
spin $! "Linking smoothie CLI"

# ─── Step 2: Detect platform ─────────────────────────────────────────
step "Detecting platform"

HAS_CLAUDE=$(command -v claude &>/dev/null && echo "yes" || echo "no")
HAS_CODEX=$(command -v codex &>/dev/null && echo "yes" || echo "no")
HAS_GEMINI=$(command -v gemini &>/dev/null && echo "yes" || echo "no")

DETECTED=()
[ "$HAS_CLAUDE" = "yes" ] && DETECTED+=("claude:Claude Code")
[ "$HAS_CODEX"  = "yes" ] && DETECTED+=("codex:Codex CLI")
[ "$HAS_GEMINI" = "yes" ] && DETECTED+=("gemini:Gemini CLI")

if [ ${#DETECTED[@]} -eq 0 ]; then
  echo -e "  ${Y}No AI CLI detected. Defaulting to Claude Code.${N}"
  PLATFORM="claude"
elif [ ${#DETECTED[@]} -eq 1 ]; then
  PLATFORM="${DETECTED[0]%%:*}"
  echo -e "  ${G}✓${N} ${DETECTED[0]##*:}"
else
  echo ""
  i=1
  for entry in "${DETECTED[@]}"; do
    echo -e "  ${B}$i.${N} ${entry##*:}"
    i=$((i+1))
  done
  echo ""
  read -p "  Install for which platform? [1]: " CHOICE
  CHOICE=${CHOICE:-1}
  PLATFORM="${DETECTED[$((CHOICE-1))]%%:*}"
  echo -e "  ${G}✓${N} ${PLATFORM}"
fi

# ─── Step 3: Codex CLI (optional, not shown for codex platform) ──────
if [ "$PLATFORM" != "codex" ]; then
  step "Setting up Codex ${D}(optional)${N}"

  echo ""
  echo -e "  ${D}Codex adds OpenAI's coding model to the blend.${N}"
  echo -e "  ${D}Requires a ChatGPT account. Skip if you only want OpenRouter.${N}"
  echo ""
  read -p "  Set up Codex? [Y/n]: " SETUP_CODEX

  if [[ "$SETUP_CODEX" =~ ^[Nn]$ ]]; then
    echo -e "  ${D}Skipped — blend will use OpenRouter models only${N}"
  else
    if ! command -v codex &>/dev/null; then
      npm install -g @openai/codex 2>/dev/null &
      spin $! "Installing Codex CLI"
    else
      echo -e "  ${G}✓${N} Codex CLI found"
    fi

    if codex auth status 2>/dev/null | grep -q "Logged in"; then
      echo -e "  ${G}✓${N} Already authenticated"
    else
      echo ""
      echo -e "  ${D}Opens browser → sign in with ChatGPT account${N}"
      read -p "  Press Enter when ready → " _
      codex auth login >/dev/null 2>&1
      echo -e "  ${G}✓${N} Codex authenticated"
    fi
  fi
fi

# ─── Step 4: OpenRouter ──────────────────────────────────────────────
step "Connecting OpenRouter"

echo ""
echo -e "  ${D}One API key for Gemini, Grok, DeepSeek + 200 more${N}"
echo -e "  ${D}Get yours free →${N} ${C}https://openrouter.ai/keys${N}"
echo ""
read -s -p "  API key (hidden): " OPENROUTER_KEY
echo ""

if [ -z "$OPENROUTER_KEY" ]; then
  echo -e "  ${Y}Skipped${N} ${D}— add later to .env${N}"
  echo "OPENROUTER_API_KEY=" > "$SCRIPT_DIR/.env"
else
  echo "OPENROUTER_API_KEY=$OPENROUTER_KEY" > "$SCRIPT_DIR/.env"
  echo -e "  ${G}✓${N} Key saved"
fi
echo "SMOOTHIE_PLATFORM=$PLATFORM" >> "$SCRIPT_DIR/.env"

# ─── Step 5: Pick models ─────────────────────────────────────────────
step "Choosing models"

echo ""
node "$SCRIPT_DIR/dist/select-models.js" "$OPENROUTER_KEY" "$SCRIPT_DIR/config.json"

# ─── Step 6: Auto-blend ──────────────────────────────────────────────
step "Configuring hooks"

chmod +x "$SCRIPT_DIR/plan-hook.sh" "$SCRIPT_DIR/auto-blend-hook.sh" "$SCRIPT_DIR/pr-blend-hook.sh"

echo ""
echo -e "  ${B}Auto-blend${N} reviews every plan with all models before"
echo -e "  you approve. Adds 30-90s per plan."
echo ""
read -p "  Enable auto-blend? [y/N]: " AUTO_BLEND
if [[ "$AUTO_BLEND" =~ ^[Yy]$ ]]; then
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$SCRIPT_DIR/config.json','utf8'));
    c.auto_blend = true;
    fs.writeFileSync('$SCRIPT_DIR/config.json', JSON.stringify(c, null, 2));
  "
  echo -e "  ${G}✓${N} Auto-blend on"
else
  echo -e "  ${D}Skipped — toggle in config.json anytime${N}"
fi

# ─── Step 7: Wire up ─────────────────────────────────────────────────
step "Wiring up"

if [ "$PLATFORM" = "claude" ]; then
  # Find .claude dir
  CLAUDE_DIR=""
  SEARCH_DIR="$PWD"
  while [ "$SEARCH_DIR" != "/" ]; do
    if [ -d "$SEARCH_DIR/.claude" ]; then
      CLAUDE_DIR="$SEARCH_DIR/.claude"
      break
    fi
    SEARCH_DIR="$(dirname "$SEARCH_DIR")"
  done
  if [ -z "$CLAUDE_DIR" ]; then
    CLAUDE_DIR="$HOME/.claude"
    mkdir -p "$CLAUDE_DIR"
  fi

  # Slash command
  mkdir -p "$CLAUDE_DIR/commands"
  cat > "$CLAUDE_DIR/commands/smoothie.md" << 'EOF'
You are running Smoothie — a multi-model review session.

The user has provided this context/problem:
$ARGUMENTS

**Step 1 — Blend**
Call `smoothie_blend` with the user's prompt. The MCP server queries all
models in parallel and shows live progress in the terminal. Wait for it to return.

**Step 2 — Judge and respond**
You now have responses from all models. You are the final decision-maker.
Do NOT show the user raw model outputs.

- If reviewing a **problem**: respond with the answer or fix. Mention in one
  sentence if there was a meaningful conflict worth flagging.
- If reviewing a **plan**: respond with a revised plan with improvements already
  incorporated. End with a "What changed" section (2–3 bullets).

Use your full codebase context to filter out irrelevant suggestions. Be decisive.
EOF
  echo -e "  ${G}✓${N} Slash command /smoothie"

  cat > "$CLAUDE_DIR/commands/smoothie-pr.md" << 'EOF'
You are running Smoothie PR Review — a multi-model code review.

$ARGUMENTS

**Step 1 — Get the diff**
Run `git diff main...HEAD` to get the full branch diff.

**Step 2 — Blend**
Call `smoothie_blend` with a prompt asking models to review the diff for:
- Bugs, logic errors, edge cases
- Security vulnerabilities
- Performance issues
- Code style / best practices

**Step 3 — Respond**
Summarize the review. List concrete issues found (if any) with file:line references.
If everything looks good, say so briefly. Be direct.
EOF
  echo -e "  ${G}✓${N} Slash command /smoothie-pr"

  # Merge settings.json
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  EXISTING="{}"
  [ -f "$SETTINGS_FILE" ] && EXISTING=$(cat "$SETTINGS_FILE")

  node - << NODEJS
const fs = require('fs');
let s;
try { s = JSON.parse(\`$EXISTING\`); } catch(e) { s = {}; }

s.mcpServers = s.mcpServers || {};
s.mcpServers.smoothie = {
  command: "node",
  args: ["$SCRIPT_DIR/dist/index.js"],
  env: { OPENROUTER_API_KEY: "$OPENROUTER_KEY", SMOOTHIE_PLATFORM: "$PLATFORM" }
};

s.hooks = s.hooks || {};

s.hooks.PreToolUse = s.hooks.PreToolUse || [];
const preExists = s.hooks.PreToolUse.some(h => h.matcher === 'ExitPlanMode');
if (!preExists) {
  s.hooks.PreToolUse.push({
    matcher: "ExitPlanMode",
    hooks: [{
      type: "command",
      command: "bash $SCRIPT_DIR/auto-blend-hook.sh",
      timeout: 120
    }]
  });
}

// Add PR review hook for Bash commands
const bashHookExists = s.hooks.PreToolUse.some(h => h.matcher === 'Bash' && h.hooks?.[0]?.command?.includes('pr-blend-hook'));
if (!bashHookExists) {
  s.hooks.PreToolUse.push({
    matcher: "Bash",
    hooks: [{
      type: "command",
      command: "bash $SCRIPT_DIR/pr-blend-hook.sh",
      timeout: 120
    }]
  });
}

s.hooks.Stop = s.hooks.Stop || [];
const stopExists = s.hooks.Stop.some(h => h.hooks?.[0]?.command?.includes('plan-hook.sh'));
if (!stopExists) {
  s.hooks.Stop.push({ hooks: [{ type: "command", command: "bash $SCRIPT_DIR/plan-hook.sh" }] });
}

fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(s, null, 2));
NODEJS
  echo -e "  ${G}✓${N} MCP server registered"
  echo -e "  ${G}✓${N} Hooks configured"
fi

if [ "$PLATFORM" = "gemini" ]; then
  mkdir -p "$HOME/.gemini/commands"

  # Gemini MCP server
  GEMINI_SETTINGS="$HOME/.gemini/settings.json"
  GEMINI_EXISTING="{}"
  [ -f "$GEMINI_SETTINGS" ] && GEMINI_EXISTING=$(cat "$GEMINI_SETTINGS")

  node -e "
    const fs = require('fs');
    let s;
    try { s = JSON.parse(\`$GEMINI_EXISTING\`); } catch(e) { s = {}; }
    s.mcpServers = s.mcpServers || {};
    s.mcpServers.smoothie = {
      command: 'node',
      args: ['$SCRIPT_DIR/dist/index.js'],
      env: { OPENROUTER_API_KEY: '$OPENROUTER_KEY', SMOOTHIE_PLATFORM: 'gemini' }
    };
    fs.writeFileSync('$GEMINI_SETTINGS', JSON.stringify(s, null, 2));
  "
  echo -e "  ${G}✓${N} Gemini MCP server registered"

  # Gemini slash commands (.toml)
  cat > "$HOME/.gemini/commands/smoothie.toml" << 'TOML'
description = "Blend this problem across multiple AI models. Gemini judges."

prompt = """
You are running Smoothie — a multi-model review session.

{{args}}

Step 1 — Call smoothie_blend with the problem text. Wait for results.

Step 2 — You have responses from all models. Do NOT show raw outputs.
- If reviewing a problem: give the answer. Mention conflicts in one sentence.
- If reviewing a plan: return a revised plan. End with "What changed" bullets.

Be decisive. Use your full codebase context.
"""
TOML
  echo -e "  ${G}✓${N} Slash command /smoothie (Gemini)"

  cat > "$HOME/.gemini/commands/smoothie-pr.toml" << 'TOML'
description = "Multi-model PR review before creating a pull request."

prompt = """
You are running Smoothie PR Review.

{{args}}

Step 1 — Run git diff main...HEAD to get the branch diff.
Step 2 — Call smoothie_blend asking models to review the diff for bugs, security, performance.
Step 3 — Summarize findings with file:line references. Be direct.
"""
TOML
  echo -e "  ${G}✓${N} Slash command /smoothie-pr (Gemini)"
fi

# ─── Done ─────────────────────────────────────────────────────────────
MODELS=$(node -e "
const d = JSON.parse(require('fs').readFileSync('$SCRIPT_DIR/config.json','utf8'));
console.log(['Codex', ...d.openrouter_models.map(m=>m.label)].join(' · '));
")

echo ""
echo -e "  ${D}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo ""
echo -e "  ${G}${B}Done!${N} Restart Claude Code, then:"
echo ""
echo -e "  ${C}/smoothie${N} ${D}<your problem>${N}    blend in Claude Code"
if [[ "$AUTO_BLEND" =~ ^[Yy]$ ]]; then
echo -e "  ${C}auto-blend${N}                  ${G}on${N} for all plans"
fi
echo -e "  ${C}smoothie models${N}             manage models"
echo ""
echo -e "  ${D}$MODELS${N}"
echo ""
