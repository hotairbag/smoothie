# Smoothie

Multi-model code review for AI coding agents. Query Codex, Gemini, Grok, DeepSeek and more in parallel — get one blended answer.

**[Website](https://smoothiecode.com)** · **[Docs](https://smoothiecode.com/docs)** · **[Leaderboard](https://smoothiecode.com/leaderboard)** · **[@smoothie_code](https://x.com/smoothie_code)**

## Install

```bash
npx smoothie-code
```

Works with **Claude Code**, **Gemini CLI**, **Codex CLI**, and **Cursor**.

## Features

- `/smoothie <problem>` — blend across all models, get one answer
- `/smoothie-pr` — multi-model PR review
- `/smoothie --deep` — full context mode with cost estimate
- **Auto-blend** — plans and PRs reviewed automatically before you approve
- **Leaderboard** — weekly token rankings at [smoothiecode.com/leaderboard](https://smoothiecode.com/leaderboard)
- **Stats & sharing** — `smoothie stats`, `smoothie share`

## Platform support

| Feature | Claude Code | Gemini CLI | Codex CLI | Cursor |
|---------|------------|-----------|-----------|--------|
| MCP server | ✓ | ✓ | ✓ (STDIO) | ✓ |
| Slash commands | ✓ | ✓ | — | — |
| Auto-blend hooks | ✓ | ✓ | ⚠ experimental | Rule-based |
| `/smoothie` | ✓ | ✓ | — | — |
| `smoothie blend` CLI | ✓ | ✓ | ✓ | ✓ |

## CLI

```bash
smoothie models              # pick models
smoothie auto on|off         # toggle auto-blend
smoothie blend "<prompt>"    # run a blend
smoothie blend --deep "..."  # deep blend with full context
smoothie stats               # usage stats
smoothie share               # share last report
smoothie leaderboard         # view rankings
smoothie help                # all commands
```

## How it works

```
Your IDE (Claude/Gemini/Cursor)
    |
    |-- /smoothie or auto-blend hook
    \-- MCP Server → smoothie_blend(prompt)
            |-- Queries all models in parallel
            |-- Returns responses to the judge AI
            \-- Judge gives you one blended answer
```

## Links

- [Documentation](https://smoothiecode.com/docs)
- [Leaderboard](https://smoothiecode.com/leaderboard)
- [npm](https://www.npmjs.com/package/smoothie-code)
- [OpenRouter Usage](https://openrouter.ai/apps?url=https%3A%2F%2Fsmoothiecode.com)
