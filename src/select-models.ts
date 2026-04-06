#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface, Interface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
}

interface ModelEntry {
  id: string;
  label: string;
}

interface Config {
  openrouter_models: ModelEntry[];
  auto_blend?: boolean;
}

const FALLBACK_MODELS: ModelEntry[] = [
  { id: 'google/gemini-2.5-pro-preview', label: 'Gemini 2.5 Pro Preview' },
  { id: 'x-ai/grok-3', label: 'Grok 3' },
  { id: 'deepseek/deepseek-r2', label: 'DeepSeek R2' },
];

function loadEnv(): void {
  try {
    const env = readFileSync(join(PROJECT_ROOT, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    }
  } catch {}
}

function formatLabel(model: OpenRouterModel): string {
  if (model.name) return model.name;
  const raw = model.id.includes('/') ? model.id.split('/').slice(1).join('/') : model.id;
  return raw.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function loadConfig(configPath: string): Config {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  } catch {
    return { openrouter_models: [] };
  }
}

function saveConfig(configPath: string, config: Config): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

async function fetchModels(apiKey: string): Promise<OpenRouterModel[] | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models?order=throughput', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = (await res.json()) as { data?: OpenRouterModel[] };
    return json.data || [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`\n  Could not fetch models (${message}). Using defaults.\n`);
    return null;
  }
}

function dedupeAndFilter(models: OpenRouterModel[]): OpenRouterModel[] {
  const filtered = models.filter((m) => (m.context_length || 0) >= 32000);
  const seen = new Set<string>();
  const deduped: OpenRouterModel[] = [];
  for (const m of filtered) {
    const provider = m.id.includes('/') ? m.id.split('/')[0] : m.id;
    if (seen.has(provider)) continue;
    seen.add(provider);
    deduped.push(m);
  }
  return deduped.slice(0, 8);
}

async function lookupModel(apiKey: string, modelId: string): Promise<ModelEntry | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models?order=throughput', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: OpenRouterModel[] };
    const found = json.data?.find((m) => m.id === modelId);
    if (found) return { id: found.id, label: formatLabel(found) };
    // If not found but looks like a valid ID, accept it anyway
    if (modelId.includes('/')) {
      return { id: modelId, label: formatLabel({ id: modelId }) };
    }
    return null;
  } catch {
    if (modelId.includes('/')) {
      return { id: modelId, label: formatLabel({ id: modelId }) };
    }
    return null;
  }
}

function promptQ(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => resolve(answer));
  });
}

// ── CLI: add <model_id> ─────────────────────────────────────────────
async function cmdAdd(apiKey: string, configPath: string, modelId: string): Promise<void> {
  const config = loadConfig(configPath);
  if (config.openrouter_models.some((m) => m.id === modelId)) {
    console.log(`  Already added: ${modelId}`);
    return;
  }
  const entry = await lookupModel(apiKey, modelId);
  if (!entry) {
    console.error(`  Could not find model: ${modelId}`);
    process.exit(1);
  }
  config.openrouter_models.push(entry);
  saveConfig(configPath, config);
  console.log(`  ✓ Added ${entry.label} (${entry.id})`);
}

// ── CLI: remove <model_id> ──────────────────────────────────────────
function cmdRemove(configPath: string, modelId: string): void {
  const config = loadConfig(configPath);
  const before = config.openrouter_models.length;
  config.openrouter_models = config.openrouter_models.filter((m) => m.id !== modelId);
  if (config.openrouter_models.length === before) {
    console.log(`  Not found: ${modelId}`);
    return;
  }
  saveConfig(configPath, config);
  console.log(`  ✓ Removed ${modelId}`);
}

// ── CLI: list ───────────────────────────────────────────────────────
function cmdList(configPath: string): void {
  const config = loadConfig(configPath);
  if (config.openrouter_models.length === 0) {
    console.log('  No models configured. Run: node dist/select-models.js');
    return;
  }
  console.log('  Current models:');
  for (const m of config.openrouter_models) {
    console.log(`    ${m.label} (${m.id})`);
  }
}

// ── Interactive picker (default / install mode) ─────────────────────
async function cmdPick(apiKey: string, configPath: string): Promise<void> {
  let topModels: ModelEntry[];
  const rawModels = await fetchModels(apiKey);

  if (rawModels === null) {
    topModels = FALLBACK_MODELS.map((m) => ({ ...m }));
  } else {
    const deduped = dedupeAndFilter(rawModels);
    topModels =
      deduped.length > 0
        ? deduped.map((m) => ({ id: m.id, label: formatLabel(m) }))
        : FALLBACK_MODELS.map((m) => ({ ...m }));
  }

  // Default selection: first 3
  const selected = new Set([0, 1, 2]);

  // Print list with selection markers
  console.log('');
  for (let i = 0; i < topModels.length; i++) {
    const check = selected.has(i) ? '\x1b[32m✓\x1b[0m' : ' ';
    const num = String(i + 1).padStart(2, ' ');
    console.log(`  ${check} ${num}. ${topModels[i].label}`);
  }
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const answer = await promptQ(
    rl,
    '  Toggle numbers, paste model ID, or Enter to confirm: ',
  );
  rl.close();

  const input = answer.trim();

  // Collect any pasted model IDs (contain '/')
  const pastedIds: ModelEntry[] = [];
  const toggleNums: number[] = [];

  if (input) {
    for (const token of input.split(/\s+/)) {
      if (token.includes('/')) {
        // Looks like a model ID
        const entry = await lookupModel(apiKey, token);
        if (entry) {
          pastedIds.push(entry);
          console.log(`  ✓ Added ${entry.label}`);
        } else {
          console.log(`  ✗ Unknown: ${token}`);
        }
      } else {
        const n = parseInt(token, 10);
        if (n >= 1 && n <= topModels.length) toggleNums.push(n);
      }
    }
  }

  // If user typed numbers, use exactly those (not toggle, just select)
  let finalSelection: ModelEntry[];
  if (toggleNums.length > 0) {
    finalSelection = toggleNums.map((n) => topModels[n - 1]);
  } else if (pastedIds.length > 0) {
    // Keep defaults + add pasted
    finalSelection = [...selected].map((i) => topModels[i]);
  } else {
    // Enter with no input → use defaults
    finalSelection = [...selected].map((i) => topModels[i]);
  }

  // Merge pasted IDs
  for (const p of pastedIds) {
    if (!finalSelection.some((m) => m.id === p.id)) {
      finalSelection.push(p);
    }
  }

  // Preserve existing config fields (like auto_blend)
  const existing = loadConfig(configPath);
  existing.openrouter_models = finalSelection;
  saveConfig(configPath, existing);

  console.log(`  ✓ ${finalSelection.map((m) => m.label).join(', ')}`);
}

// ── Main ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  loadEnv();

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  const configPath =
    args.find((a) => a.endsWith('.json')) || join(PROJECT_ROOT, 'config.json');

  // Subcommands
  if (args[0] === 'add' && args[1]) {
    if (!apiKey) {
      console.error('  Set OPENROUTER_API_KEY in .env first');
      process.exit(1);
    }
    await cmdAdd(apiKey, configPath, args[1]);
    return;
  }

  if (args[0] === 'remove' && args[1]) {
    cmdRemove(configPath, args[1]);
    return;
  }

  if (args[0] === 'list') {
    cmdList(configPath);
    return;
  }

  // Interactive picker (default behavior / install mode)
  const key = args[0] && !args[0].endsWith('.json') ? args[0] : apiKey;
  if (!key) {
    console.error('  No API key. Usage: node dist/select-models.js <key>');
    console.error('  Or set OPENROUTER_API_KEY in .env');
    process.exit(1);
  }
  // If called with positional key, set it for fetching
  if (args[0] && !args[0].endsWith('.json') && args[0] !== 'add' && args[0] !== 'remove' && args[0] !== 'list') {
    process.env.OPENROUTER_API_KEY = args[0];
  }

  await cmdPick(key, configPath);
}

main();
