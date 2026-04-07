#!/usr/bin/env node

/**
 * blend-cli.ts — Standalone blend runner for hooks.
 *
 * Usage:
 *   node dist/blend-cli.js "Review this plan: ..."
 *   echo "plan text" | node dist/blend-cli.js
 *
 * Queries Codex + OpenRouter models in parallel, prints JSON results to stdout.
 * Progress goes to stderr so it doesn't interfere with hook JSON output.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { createInterface } from 'readline';

const execFile = promisify(execFileCb);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Config {
  openrouter_models: Array<{ id: string; label: string }>;
  auto_blend?: boolean;
}

interface ModelResult {
  model: string;
  response: string;
  elapsed_s?: number;
  tokens?: { prompt: number; completion: number; total: number };
}

interface OpenRouterResponse {
  choices?: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------
function loadEnv(): void {
  try {
    const env = readFileSync(join(PROJECT_ROOT, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    }
  } catch {
    // no .env
  }
}
loadEnv();

// ---------------------------------------------------------------------------
// Model queries (same as index.ts)
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
    return { model: 'Codex', response: response || '(empty response)' };
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
        'HTTP-Referer': 'https://hotairbag.github.io/smoothie',
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
// Read prompt from arg or stdin
// ---------------------------------------------------------------------------

async function getPrompt(): Promise<string> {
  if (process.argv[2]) return process.argv[2];

  // Read from stdin
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const deep = args.includes('--deep');
  const filteredArgs = args.filter(a => a !== '--deep');
  // Temporarily override argv for getPrompt
  process.argv = [process.argv[0], process.argv[1], ...filteredArgs];
  const prompt = await getPrompt();
  if (!prompt.trim()) {
    process.stderr.write('blend-cli: no prompt provided\n');
    process.exit(1);
  }

  let finalPrompt = prompt;
  if (deep) {
    // Read context file
    for (const name of ['GEMINI.md', 'CLAUDE.md', 'AGENTS.md']) {
      try {
        const content = readFileSync(join(process.cwd(), name), 'utf8');
        if (content.trim()) {
          finalPrompt = `## Context File\n${content}\n\n## Prompt\n${prompt}`;
          break;
        }
      } catch {
        // file not found, try next
      }
    }
    // Add git diff
    try {
      const { execFileSync } = await import('child_process');
      const diff = execFileSync('git', ['diff', 'HEAD~3'], { encoding: 'utf8', maxBuffer: 100 * 1024, timeout: 10000 });
      if (diff) finalPrompt += `\n\n## Recent Git Diff\n${diff.slice(0, 40000)}`;
    } catch {
      // no git diff available
    }
  }

  let config: Config;
  try {
    config = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'config.json'), 'utf8'),
    ) as Config;
  } catch {
    config = { openrouter_models: [] };
  }

  const models: Array<{ fn: () => Promise<ModelResult>; label: string }> = [
    { fn: () => queryCodex(finalPrompt), label: 'Codex' },
    ...config.openrouter_models.map((m) => ({
      fn: () => queryOpenRouter(finalPrompt, m.id, m.label),
      label: m.label,
    })),
  ];

  process.stderr.write('\n🧃 Smoothie blending...\n\n');
  for (const { label } of models) {
    process.stderr.write(`  ⏳ ${label.padEnd(26)} waiting...\n`);
  }
  process.stderr.write('\n');

  const startTimes: Record<string, number> = {};
  const promises = models.map(({ fn, label }) => {
    startTimes[label] = Date.now();
    return fn()
      .then((result: ModelResult) => {
        const elapsed = ((Date.now() - startTimes[label]) / 1000);
        process.stderr.write(`  ✓  ${label.padEnd(26)} done (${elapsed.toFixed(1)}s)\n`);
        return { ...result, elapsed_s: parseFloat(elapsed.toFixed(1)) };
      })
      .catch((err: unknown) => {
        const elapsed = ((Date.now() - startTimes[label]) / 1000);
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  ✗  ${label.padEnd(26)} failed (${elapsed.toFixed(1)}s)\n`);
        return { model: label, response: `Error: ${message}`, elapsed_s: parseFloat(elapsed.toFixed(1)) } as ModelResult;
      });
  });

  const results = await Promise.all(promises);
  process.stderr.write('\n  ◆  All done.\n\n');

  // Output JSON to stdout (for hook consumption)
  process.stdout.write(JSON.stringify({ results }, null, 2));

  // Save for share command
  try {
    writeFileSync(join(PROJECT_ROOT, '.last-blend.json'), JSON.stringify({ results }, null, 2));
  } catch {}

  const totalTime = Math.max(...results.map(r => r.elapsed_s || 0));
  const totalTokens = results.reduce((sum, r) => sum + (r.tokens?.total || 0), 0);
  const responded = results.filter(r => !r.response.startsWith('Error:')).length;
  process.stderr.write(`  ${responded}/${results.length} models · ${totalTime.toFixed(1)}s · ${totalTokens} tokens\n\n`);
}

main();
