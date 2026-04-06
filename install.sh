#!/bin/bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo -e "${CYAN}🧃 Smoothie installer${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 1. Check Node
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install from https://nodejs.org${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

# 2. Dependencies
echo "  Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --silent
npm run build
echo -e "${GREEN}✓ Dependencies installed${NC}"

# 3. Codex CLI
if ! command -v codex &>/dev/null; then
  echo -e "${YELLOW}  Installing Codex CLI...${NC}"
  npm install -g @openai/codex
  echo -e "${GREEN}✓ Codex CLI installed${NC}"
else
  echo -e "${GREEN}✓ Codex CLI found${NC}"
fi

# 4. Codex auth
echo ""
echo "  Codex authenticates via your ChatGPT account (browser OAuth)."
read -p "  Press Enter to log in → " _
codex auth login
echo -e "${GREEN}✓ Codex authenticated${NC}"

# 5. OpenRouter key
echo ""
echo "  OpenRouter = one API key for Gemini, Grok, DeepSeek + 200 more."
echo "  Sign up free: https://openrouter.ai/keys"
echo ""
read -p "  Paste your OpenRouter API key: " OPENROUTER_KEY

if [ -z "$OPENROUTER_KEY" ]; then
  echo -e "${YELLOW}  Skipped. Add later: echo 'OPENROUTER_API_KEY=...' > smoothie-mcp/.env${NC}"
  echo "OPENROUTER_API_KEY=" > "$SCRIPT_DIR/.env"
else
  echo "OPENROUTER_API_KEY=$OPENROUTER_KEY" > "$SCRIPT_DIR/.env"
  echo -e "${GREEN}✓ Key saved to .env${NC}"
fi

# 6. Pick models (live from OpenRouter)
echo ""
node "$SCRIPT_DIR/dist/select-models.js" "$OPENROUTER_KEY" "$SCRIPT_DIR/config.json"
echo -e "${GREEN}✓ Models saved to config.json${NC}"

# 7. Hook executable
chmod +x "$SCRIPT_DIR/plan-hook.sh"
echo -e "${GREEN}✓ Hook ready${NC}"

# 8. Find .claude dir
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
echo -e "${GREEN}✓ Claude config: $CLAUDE_DIR${NC}"

# 9. Write slash command
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
echo -e "${GREEN}✓ Slash command written${NC}"

# 10. Merge settings.json
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
  env: { OPENROUTER_API_KEY: "$OPENROUTER_KEY" }
};

s.hooks = s.hooks || {};
s.hooks.Stop = s.hooks.Stop || [];
const exists = s.hooks.Stop.some(h => h.hooks?.[0]?.command?.includes('plan-hook.sh'));
if (!exists) {
  s.hooks.Stop.push({ hooks: [{ type: "command", command: "bash $SCRIPT_DIR/plan-hook.sh" }] });
}

fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(s, null, 2));
NODEJS
echo -e "${GREEN}✓ settings.json updated${NC}"

# 11. Done
MODELS=$(node -e "
const d = JSON.parse(require('fs').readFileSync('$SCRIPT_DIR/config.json','utf8'));
console.log(['Codex', ...d.openrouter_models.map(m=>m.label)].join(' · '));
")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${CYAN}🧃 Smoothie is ready!${NC}"
echo ""
echo "  Blending: $MODELS"
echo ""
echo "  Restart Claude Code, then:"
echo "  /smoothie <your problem>"
echo ""
echo "  In plan mode: type 'smoothie' in option 5"
echo "  Refresh models anytime: node smoothie/dist/select-models.js"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
