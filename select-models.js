#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FALLBACK_MODELS = [
  { id: "google/gemini-2.5-pro-preview", label: "Gemini 2.5 Pro Preview" },
  { id: "x-ai/grok-3", label: "Grok 3" },
  { id: "deepseek/deepseek-r2", label: "DeepSeek R2" }
];

function loadEnv() {
  try {
    const env = readFileSync(join(__dirname, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    }
  } catch {}
}

function formatLabel(model) {
  if (model.name) return model.name;
  // Strip provider prefix and title-case
  const raw = model.id.includes('/') ? model.id.split('/').slice(1).join('/') : model.id;
  return raw
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function fetchModels(apiKey) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models?order=throughput', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json();
    return json.data || [];
  } catch (err) {
    console.warn(`\n  Warning: Could not fetch models from OpenRouter (${err.message})`);
    console.warn('  Using fallback defaults.\n');
    return null;
  }
}

function dedupeAndFilter(models) {
  // Filter to context_length >= 32000
  const filtered = models.filter(m => (m.context_length || 0) >= 32000);

  // Deduplicate by provider family (first slash prefix).
  // Results are already ordered by throughput, so first encountered = highest throughput.
  const seen = new Set();
  const deduped = [];
  for (const m of filtered) {
    const provider = m.id.includes('/') ? m.id.split('/')[0] : m.id;
    if (seen.has(provider)) continue;
    seen.add(provider);
    deduped.push(m);
  }

  return deduped.slice(0, 15);
}

function printModelList(models) {
  console.log('\n  Top models by usage right now:\n');

  // Calculate column widths for alignment
  const maxIdLen = Math.max(...models.map(m => m.id.length));

  models.forEach((m, i) => {
    const num = String(i + 1).padStart(2, ' ');
    const id = m.id.padEnd(maxIdLen + 2, ' ');
    const label = m.label;
    console.log(`  ${num}.  ${id}${label}`);
  });

  console.log('');
}

function prompt(rl, question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer));
  });
}

async function main() {
  const apiKey = process.argv[2] || (loadEnv(), process.env.OPENROUTER_API_KEY);
  const configPath = process.argv[3] || join(__dirname, 'config.json');

  if (!apiKey) {
    console.error('  Error: No API key provided.');
    console.error('  Usage: node select-models.js <api_key> [config_path]');
    console.error('  Or set OPENROUTER_API_KEY in .env');
    process.exit(1);
  }

  let topModels;
  const rawModels = await fetchModels(apiKey);

  if (rawModels === null) {
    // API failed — use fallbacks directly
    topModels = FALLBACK_MODELS.map(m => ({ ...m }));
  } else {
    const deduped = dedupeAndFilter(rawModels);
    if (deduped.length === 0) {
      console.warn('  Warning: No suitable models found. Using fallback defaults.\n');
      topModels = FALLBACK_MODELS.map(m => ({ ...m }));
    } else {
      topModels = deduped.map(m => ({
        id: m.id,
        label: formatLabel(m)
      }));
    }
  }

  printModelList(topModels);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const defaultPicks = '1 2 3';
  const answer = await prompt(rl, `  Enter numbers to add (space-separated), or press Enter for defaults [${defaultPicks}]: `);
  rl.close();

  const input = answer.trim() || defaultPicks;
  const indices = input.split(/\s+/).map(Number).filter(n => n >= 1 && n <= topModels.length);

  if (indices.length === 0) {
    console.error('\n  No valid selections. Aborting.');
    process.exit(1);
  }

  const selected = indices.map(i => ({
    id: topModels[i - 1].id,
    label: topModels[i - 1].label
  }));

  const config = { openrouter_models: selected };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  console.log(`\n  Saved ${selected.length} model(s) to ${configPath}:`);
  for (const m of selected) {
    console.log(`    - ${m.id}  (${m.label})`);
  }
  console.log('');
}

main();
