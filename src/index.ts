import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const execFile = promisify(execFileCb);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenRouterModel {
  id: string;
  label: string;
}

interface Config {
  openrouter_models: OpenRouterModel[];
}

interface ModelResult {
  model: string;
  response: string;
  elapsed_s?: number;
  tokens?: { prompt: number; completion: number; total: number };
}

interface ModelEntry {
  fn: () => Promise<ModelResult>;
  label: string;
}

interface OpenRouterMessage {
  role: string;
  content: string;
}

interface OpenRouterChoice {
  message: OpenRouterMessage;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// ---------------------------------------------------------------------------
// .env loader (no dotenv dependency)
// ---------------------------------------------------------------------------
function loadEnv(): void {
  try {
    const env = readFileSync(join(PROJECT_ROOT, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    }
  } catch {
    // .env file not found or unreadable — that's fine
  }
}
loadEnv();

// ---------------------------------------------------------------------------
// Model query helpers
// ---------------------------------------------------------------------------

async function queryCodex(prompt: string): Promise<ModelResult> {
  try {
    const tmpFile = join(PROJECT_ROOT, `.codex-out-${Date.now()}.txt`);
    await execFile('codex', ['exec', '--full-auto', '-o', tmpFile, prompt], {
      timeout: 0,
    });
    let response: string;
    try {
      response = readFileSync(tmpFile, 'utf8').trim();
      const { unlinkSync } = await import('fs');
      unlinkSync(tmpFile);
    } catch {
      response = '';
    }
    const estimatedTokens = Math.ceil(prompt.length / 3) + Math.ceil(response.length / 3);
    return {
      model: 'Codex',
      response: response || '(empty response)',
      tokens: { prompt: Math.ceil(prompt.length / 3), completion: Math.ceil(response.length / 3), total: estimatedTokens },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { model: 'Codex', response: `Error: ${message}` };
  }
}

async function queryOpenRouter(
  prompt: string,
  modelId: string,
  modelLabel: string,
): Promise<ModelResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://smoothiecode.com',
        'X-Title': 'Smoothie',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { model: modelLabel, response: `Error: HTTP ${res.status} (${res.statusText})` };
    }

    const data = (await res.json()) as OpenRouterResponse;
    const text = data.choices?.[0]?.message?.content ?? 'No response content';
    const usage = data.usage;
    return {
      model: modelLabel,
      response: text,
      tokens: usage ? { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, total: usage.total_tokens || 0 } : undefined,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { model: modelLabel, response: `Error: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

function isCodexInstalled(): boolean {
  try {
    execFileSync('which', ['codex'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findContextFile(): string | null {
  for (const name of ['GEMINI.md', 'CLAUDE.md', 'AGENTS.md']) {
    try {
      const content = readFileSync(join(process.cwd(), name), 'utf8');
      if (content.trim()) return content;
    } catch {}
  }
  return null;
}

function buildDeepContext(prompt: string): string {
  const TOKEN_CAP = 16000;
  const CHAR_CAP = TOKEN_CAP * 4; // ~4 chars per token

  const parts: string[] = [`## Prompt\n${prompt}`];
  let totalLen = parts[0].length;

  // Context file
  const ctxFile = findContextFile();
  if (ctxFile && totalLen + ctxFile.length < CHAR_CAP) {
    parts.push(`## Context File\n${ctxFile}`);
    totalLen += ctxFile.length;
  }

  // Git diff (recent changes, capped at 100KB)
  try {
    const diff = execFileSync('git', ['diff', 'HEAD~3'], {
      encoding: 'utf8',
      maxBuffer: 100 * 1024,
      timeout: 10_000,
    });
    if (diff && totalLen + diff.length < CHAR_CAP) {
      parts.push(`## Recent Git Diff\n${diff}`);
      totalLen += diff.length;
    } else if (diff) {
      const truncated = diff.slice(0, CHAR_CAP - totalLen - 100);
      parts.push(`## Recent Git Diff (truncated)\n${truncated}`);
      totalLen += truncated.length;
    }
  } catch {}

  // Directory listing (git tracked files only - respects .gitignore)
  try {
    const files = execFileSync('git', ['ls-files'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    // Filter out sensitive files
    const SENSITIVE = ['.env', '.pem', '.key', 'secret', 'credential', 'token'];
    const filtered = files.split('\n').filter((f: string) =>
      f && !SENSITIVE.some(s => f.toLowerCase().includes(s))
    ).join('\n');
    if (filtered && totalLen + filtered.length < CHAR_CAP) {
      parts.push(`## Project Files\n${filtered}`);
    }
  } catch {}

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'smoothie', version: '1.0.0' });

server.tool(
  'smoothie_blend',
  {
    prompt: z.string().describe('The prompt to send to all models'),
    deep: z.boolean().optional().describe('Full context mode with project files and git diff'),
  },
  async ({ prompt, deep }) => {
    // Read config on every request so edits take effect immediately
    let config: Config;
    try {
      config = JSON.parse(
        readFileSync(join(PROJECT_ROOT, 'config.json'), 'utf8'),
      ) as Config;
    } catch {
      config = { openrouter_models: [] };
    }

    const finalPrompt = deep ? buildDeepContext(prompt) : prompt;

    // Build model array based on platform
    const platform = process.env.SMOOTHIE_PLATFORM || 'claude';
    const models: ModelEntry[] = [];

    // Add platform-specific models
    if (platform !== 'codex' && isCodexInstalled()) {
      models.push({ fn: () => queryCodex(finalPrompt), label: 'Codex' });
    }
    if (platform === 'codex' || platform === 'gemini') {
      // Add Claude via OpenRouter as a reviewer (not the judge)
      models.push({
        fn: () => queryOpenRouter(finalPrompt, 'anthropic/claude-sonnet-4', 'Claude Sonnet'),
        label: 'Claude Sonnet',
      });
    }

    // Add OpenRouter models from config
    for (const m of config.openrouter_models) {
      models.push({
        fn: () => queryOpenRouter(finalPrompt, m.id, m.label),
        label: m.label,
      });
    }

    // Print initial progress
    process.stderr.write('\n\u{1F9C3} Smoothie blending...\n\n');
    for (const { label } of models) {
      process.stderr.write(`  \u23F3 ${label.padEnd(26)} waiting...\n`);
    }
    process.stderr.write('\n');

    // Run all in parallel with progress tracking
    const startTimes: Record<string, number> = {};
    const promises = models.map(({ fn, label }) => {
      startTimes[label] = Date.now();
      return fn()
        .then((result: ModelResult) => {
          const elapsed = ((Date.now() - startTimes[label]) / 1000);
          process.stderr.write(
            `  \u2713  ${label.padEnd(26)} done (${elapsed.toFixed(1)}s)\n`,
          );
          return { ...result, elapsed_s: parseFloat(elapsed.toFixed(1)) };
        })
        .catch((err: unknown) => {
          const elapsed = ((Date.now() - startTimes[label]) / 1000);
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `  \u2717  ${label.padEnd(26)} failed (${elapsed.toFixed(1)}s)\n`,
          );
          return { model: label, response: `Error: ${message}`, elapsed_s: parseFloat(elapsed.toFixed(1)) } as ModelResult;
        });
    });

    const results: ModelResult[] = await Promise.all(promises);
    const judgeNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', cursor: 'Cursor' };
    const judgeName = judgeNames[platform] || 'the judge';
    process.stderr.write(`\n  \u25C6  All done. Handing to ${judgeName}...\n\n`);

    // Save for share command + append to history
    try {
      const { writeFileSync, appendFileSync } = await import('fs');
      writeFileSync(join(PROJECT_ROOT, '.last-blend.json'), JSON.stringify({ results }, null, 2));
      const entry = {
        ts: new Date().toISOString(),
        type: deep ? 'deep' : 'blend',
        models: results.map(r => ({ model: r.model, elapsed_s: r.elapsed_s, tokens: r.tokens, error: r.response.startsWith('Error:') })),
      };
      appendFileSync(join(PROJECT_ROOT, '.smoothie-history.jsonl'), JSON.stringify(entry) + '\n');
    } catch {}

    // Submit to leaderboard if opted in
    try {
      const cfg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'config.json'), 'utf8'));
      if (cfg.leaderboard && cfg.github) {
        const now = new Date();
        const jan1 = new Date(now.getFullYear(), 0, 1);
        const days = Math.floor((now.getTime() - jan1.getTime()) / 86400000);
        const weekNum = Math.ceil((days + jan1.getDay() + 1) / 7);
        const week = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        const totalTokens = results.reduce((s, r) => s + (r.tokens?.total || 0), 0);
        const blendId = `${cfg.github}-${Date.now()}`;

        await fetch('https://api.smoothiecode.com/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            github: cfg.github,
            blend_id: blendId,
            tokens: totalTokens,
            blends: 1,
            models: results.map(r => ({ model: r.model, tokens: r.tokens?.total || 0 })),
            week,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    } catch {}

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ results }, null, 2) }],
    };
  },
);

server.tool(
  'smoothie_estimate',
  {
    prompt: z.string().describe('The prompt to estimate costs for'),
    deep: z.boolean().optional().describe('Estimate for deep mode'),
  },
  async ({ prompt, deep }) => {
    let config: Config;
    try {
      config = JSON.parse(readFileSync(join(PROJECT_ROOT, 'config.json'), 'utf8')) as Config;
    } catch {
      config = { openrouter_models: [] };
    }

    const contextPayload = deep ? buildDeepContext(prompt) : prompt;
    const tokenCount = Math.ceil(contextPayload.length / 4);

    // Fetch pricing from OpenRouter
    let pricingMap: Record<string, number> = {};
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      });
      const data = (await res.json()) as { data?: Array<{ id: string; pricing?: { prompt?: string } }> };
      if (data.data) {
        for (const m of data.data) {
          pricingMap[m.id] = parseFloat(m.pricing?.prompt || '0');
        }
      }
    } catch {
      // Pricing unavailable — continue with zeros
    }

    const platform = process.env.SMOOTHIE_PLATFORM || 'claude';
    const rows: Array<{ label: string; tokens: number; cost: number; note?: string }> = [];

    if (platform === 'claude') {
      if (isCodexInstalled()) {
        rows.push({ label: 'Codex', tokens: tokenCount, cost: 0, note: 'free (subscription)' });
      }
    }
    if (platform === 'codex' || platform === 'gemini') {
      const price = pricingMap['anthropic/claude-sonnet-4'] || 0;
      rows.push({ label: 'Claude Sonnet', tokens: tokenCount, cost: tokenCount * price });
    }
    if (platform === 'gemini' && isCodexInstalled()) {
      rows.push({ label: 'Codex', tokens: tokenCount, cost: 0, note: 'free (subscription)' });
    }

    for (const model of config.openrouter_models) {
      const price = pricingMap[model.id] || 0;
      rows.push({
        label: model.label,
        tokens: tokenCount,
        cost: tokenCount * price,
        note: price === 0 && Object.keys(pricingMap).length === 0 ? 'pricing unavailable' : undefined,
      });
    }

    const totalCost = rows.reduce((sum, r) => sum + (r.cost || 0), 0);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ rows, totalCost, tokenCount, note: 'Token estimates are approximate (~4 chars/token)' }, null, 2),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
