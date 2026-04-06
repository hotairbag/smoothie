# Smoothie

Multi-model review plugin for Claude Code. Sends your problem or plan to multiple AI models simultaneously, then Claude judges all responses and serves you one blended result.

**Two model tracks:**
- **Codex** — Codex CLI, authenticated via ChatGPT account OAuth
- **OpenRouter** — single API key, models selected at install time from a live ranked list

## Install

```bash
git clone https://github.com/hotairbag/smoothie && cd smoothie && bash install.sh
```

The installer walks you through everything: dependencies, Codex auth, OpenRouter key, and model selection.

Restart Claude Code after install.

## Usage

### Slash command
```
/smoothie <your problem or question>
```

### Plan mode
When Claude presents a plan, you'll see a prompt to type `smoothie` in option 5 to blend the plan before approving.

### Refresh models
```bash
node select-models.js
```
Fetches current top models from OpenRouter and lets you repick. No restart needed.

## How it works

```
Claude Code
    |
    |-- /smoothie <context>           <- slash command
    |-- Stop Hook                     <- detects plan mode
    \-- MCP Server
            \-- smoothie_blend(prompt)
                    |-- Queries all models in parallel
                    |-- Streams live progress to terminal
                    \-- Returns all responses to Claude
```

Claude acts as judge. Raw model outputs are never shown. Claude absorbs everything and hands you one result.

## File overview

| File | Purpose |
|---|---|
| `index.js` | MCP server exposing `smoothie_blend` tool |
| `select-models.js` | Interactive model picker (OpenRouter API) |
| `install.sh` | One-command installer |
| `plan-hook.sh` | Stop hook for plan mode detection |
| `config.json` | Model selection (written by installer) |
| `.env` | API keys (gitignored) |
