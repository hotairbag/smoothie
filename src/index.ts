import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFile as execFileCb } from 'child_process';
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
    const { stdout } = await execFile('codex', ['exec', prompt], {
      timeout: 90_000,
    });
    return { model: 'Codex', response: stdout };
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
        'HTTP-Referer': 'https://github.com/smoothie-mcp',
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

    const data = (await res.json()) as OpenRouterResponse;
    const text = data.choices?.[0]?.message?.content ?? 'No response content';
    return { model: modelLabel, response: text };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { model: modelLabel, response: `Error: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'smoothie', version: '1.0.0' });

server.tool(
  'smoothie_blend',
  { prompt: z.string().describe('The prompt to send to all models') },
  async ({ prompt }) => {
    // Read config on every request so edits take effect immediately
    let config: Config;
    try {
      config = JSON.parse(
        readFileSync(join(PROJECT_ROOT, 'config.json'), 'utf8'),
      ) as Config;
    } catch {
      config = { openrouter_models: [] };
    }

    // Build model array
    const models: ModelEntry[] = [
      { fn: () => queryCodex(prompt), label: 'Codex' },
      ...config.openrouter_models.map(
        (m: OpenRouterModel): ModelEntry => ({
          fn: () => queryOpenRouter(prompt, m.id, m.label),
          label: m.label,
        }),
      ),
    ];

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
          const elapsed = ((Date.now() - startTimes[label]) / 1000).toFixed(1);
          process.stderr.write(
            `  \u2713  ${label.padEnd(26)} done (${elapsed}s)\n`,
          );
          return result;
        })
        .catch((err: unknown) => {
          const elapsed = ((Date.now() - startTimes[label]) / 1000).toFixed(1);
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `  \u2717  ${label.padEnd(26)} failed (${elapsed}s)\n`,
          );
          return { model: label, response: `Error: ${message}` } as ModelResult;
        });
    });

    const results: ModelResult[] = await Promise.all(promises);
    process.stderr.write('\n  \u25C6  All done. Handing to Claude...\n\n');

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ results }, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
