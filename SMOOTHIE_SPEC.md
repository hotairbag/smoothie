# Smoothie — Multi-Model Review Plugin for Claude Code

## Overview

Smoothie is a Claude Code plugin that sends your current problem or plan to multiple AI models simultaneously, then has Claude act as judge to produce a single blended output.

**Mental model**: You throw ingredients into the blender. Each model blends their version. Claude tastes all of them and serves you the smoothie.

**Two model tracks:**
- **Codex** — Codex CLI, authenticated via ChatGPT account OAuth (no API key)
- **Everything else** — OpenRouter, single API key, models selected at install time from a live ranked list that stays current automatically

**Claude's role**: Judge. Raw model outputs are never shown. Claude absorbs everything and hands you one result.

**Progress display**: The MCP server streams live progress to the terminal as each model responds.

---

## Architecture

```
Claude Code
    │
    ├── /smoothie <context>          ← slash command
    ├── Stop Hook                    ← detects plan mode, prints smoothie prompt
    └── MCP Server: smoothie-mcp
            └── tool: smoothie_blend(prompt)
                    ├── Runs all model queries in parallel
                    ├── Streams live progress to stderr
                    └── Returns all responses to Claude as one payload
```

Only ONE tool is exposed to Claude — `smoothie_blend`. The MCP server owns all parallelism and progress display internally.

---

## File Structure

```
smoothie-mcp/
├── install.sh        # One-command installer
├── select-models.js  # Interactive model picker (run by installer + standalone)
├── index.js          # MCP server
├── plan-hook.sh      # Stop hook script
├── config.json       # Written by installer, user editable
├── package.json
└── .env              # Written by installer (gitignored)

.claude/
├── commands/
│   └── smoothie.md   # Written by installer
└── settings.json     # Updated by installer
```

---

## Part 1: Model Picker (`select-models.js`)

Called by `install.sh` after the OpenRouter key is entered. Also runnable standalone anytime to refresh the model list.

### What it does

1. Hits `GET https://openrouter.ai/api/v1/models?order=throughput` with the API key
2. Filters to models with `context_length >= 32000`
3. Deduplicates by provider — keeps highest-throughput variant per provider family
4. Takes top 15 results
5. Prints numbered list, user selects by typing numbers
6. Writes selection to `config.json`

### Display format

```
  Top models by usage right now:

  1.  google/gemini-2.5-pro-preview       Gemini 2.5 Pro Preview
  2.  x-ai/grok-3                         Grok 3
  3.  deepseek/deepseek-r2                DeepSeek R2
  4.  meta-llama/llama-4-maverick         Llama 4 Maverick
  5.  anthropic/claude-opus-4-5           Claude Opus 4.5
  6.  mistralai/mistral-large-2           Mistral Large 2
  7.  cohere/command-r-plus               Command R+
  8.  qwen/qwen-2.5-72b-instruct          Qwen 2.5 72B
  9.  amazon/nova-pro-v1                  Nova Pro
  10. microsoft/phi-4                     Phi-4

  Enter numbers to add (space-separated), or press Enter for defaults [1 2 3]:
```

### Implementation notes

- Use `readline` from Node stdlib — no extra packages
- If API call fails, fall back to 3 hardcoded defaults and warn user
- `label` in `config.json` = human-readable `name` from API response
- Strip provider prefix for display only (`google/gemini-2.5-pro` → `Gemini 2.5 Pro`)
- Accept two CLI args: `node select-models.js <api_key> <config_path>`
- When run standalone with no args, read key from `.env` and default config path

### `config.json` output

```json
{
  "openrouter_models": [
    { "id": "google/gemini-2.5-pro-preview", "label": "Gemini 2.5 Pro Preview" },
    { "id": "x-ai/grok-3", "label": "Grok 3" },
    { "id": "deepseek/deepseek-r2", "label": "DeepSeek R2" }
  ]
}
```

---

## Part 2: MCP Server (`index.js`)

### Tool: `smoothie_blend`

**Input:** `{ prompt: string }`

**Returns to Claude:**
```json
{
  "results": [
    { "model": "Codex", "response": "..." },
    { "model": "Gemini 2.5 Pro Preview", "response": "..." },
    { "model": "Grok 3", "response": "..." }
  ]
}
```

Errors are returned as strings in the response field — never thrown.

### Progress display via stderr

Print immediately when tool fires:
```
🧃 Smoothie blending...

  ⏳ Codex                    waiting...
  ⏳ Gemini 2.5 Pro Preview   waiting...
  ⏳ Grok 3                   waiting...
  ⏳ DeepSeek R2              waiting...
```

Print a line as each model completes:
```
  ✓  Gemini 2.5 Pro Preview   done (8.2s)
  ✓  Grok 3                   done (11.4s)
  ✗  DeepSeek R2              failed (timeout)
  ✓  Codex                    done (22.7s)

  ◆  All done. Handing to Claude...
```

Use `process.stderr.write()` not `console.error()`.

### Parallel execution pattern

```javascript
const models = [
  { fn: () => queryCodex(prompt), label: "Codex" },
  ...openrouterModels.map(m => ({
    fn: () => queryOpenRouter(prompt, m.id, m.label),
    label: m.label
  }))
];

const startTimes = {};
const promises = models.map(({ fn, label }) => {
  startTimes[label] = Date.now();
  return fn()
    .then(result => {
      const elapsed = ((Date.now() - startTimes[label]) / 1000).toFixed(1);
      process.stderr.write(`  ✓  ${label.padEnd(26)} done (${elapsed}s)\n`);
      return result;
    })
    .catch(err => {
      const elapsed = ((Date.now() - startTimes[label]) / 1000).toFixed(1);
      process.stderr.write(`  ✗  ${label.padEnd(26)} failed (${elapsed}s)\n`);
      return { model: label, response: `Error: ${err.message}` };
    });
});

const results = await Promise.all(promises);
process.stderr.write('\n  ◆  All done. Handing to Claude...\n\n');
```

### Internal query functions

**`queryCodex(prompt)`**
- Spawns: `codex --full-auto -q "<prompt>"`
- Timeout: 90s
- Returns `{ model: "Codex", response: string }`
- Never throws

**`queryOpenRouter(prompt, modelId, modelLabel)`**
- POST `https://openrouter.ai/api/v1/chat/completions`
- Headers: `Authorization: Bearer ${key}`, `HTTP-Referer: https://github.com/smoothie-mcp`, `X-Title: Smoothie`, `Content-Type: application/json`
- Timeout: 60s
- Returns `{ model: modelLabel, response: string }`
- Never throws

### `.env` loading (no dotenv package)

```javascript
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    const env = readFileSync(join(__dirname, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    }
  } catch {}
}
loadEnv();
```

---

## Part 3: Slash Command (`.claude/commands/smoothie.md`)

```markdown
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
```

---

## Part 4: Plan Mode Hook (`plan-hook.sh`)

```bash
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
```

---

## Part 5: Installer (`install.sh`)

```bash
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
node "$SCRIPT_DIR/select-models.js" "$OPENROUTER_KEY" "$SCRIPT_DIR/config.json"
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
  args: ["$SCRIPT_DIR/index.js"],
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
echo "  Refresh models anytime: node smoothie-mcp/select-models.js"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
```

---

## Installation

```bash
git clone https://github.com/your-username/smoothie-mcp
cd smoothie-mcp
bash install.sh
```

Restart Claude Code after install.

### Refresh models anytime

```bash
node smoothie-mcp/select-models.js
# Fetches current top models from OpenRouter, lets you repick
# No restart needed — config.json is read per request
```

---

## Failure Behavior

| Scenario | Behavior |
|---|---|
| Codex not installed / auth expired | ✗ in progress display, continues with OpenRouter models |
| OpenRouter model fails / times out | ✗ in progress display, continues with others |
| OpenRouter API unreachable at install | Falls back to 3 hardcoded defaults, warns user |
| All models fail | Claude judges with error context, tells user |
| Hook: not a plan response | Silent exit |
| Hook: stop_hook_active=true | Immediate exit, no infinite loop |
| settings.json has existing config | Installer merges safely, no overwrites |
