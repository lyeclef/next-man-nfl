import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { projectDataset } from '../lib/model.mjs';
try {
  const args = process.argv.slice(2), flags = args.filter(a => a.startsWith('--'));
  if (flags.some(f => !['--learned', '--baseline'].includes(f)) || flags.length > 1) throw new Error('Use at most one of --learned or --baseline.');
  const [input, output] = args.filter(a => !a.startsWith('--'));
  if (!input) throw new Error('Usage: npm run project -- <scenario.json> [output.json]');
  const data = JSON.parse(await readFile(input, 'utf8'));
  const calibration = JSON.parse(await readFile(fileURLToPath(new URL('../data/calibration.json', import.meta.url)), 'utf8'));
  const injuryModel = JSON.parse(await readFile(fileURLToPath(new URL('../data/injury-model.json', import.meta.url)), 'utf8'));
  const impactMode = flags.includes('--learned') ? 'learned' : flags.includes('--baseline') ? 'baseline' : undefined;
  const validationPolicy = JSON.parse(await readFile(fileURLToPath(new URL('../data/validation-policy.json', import.meta.url)), 'utf8'));
  const result = { dataset: data.name, asOf: data.asOf, modelStatus: validationPolicy.status, rows: projectDataset(data, calibration, { injuryModel, impactMode, validationPolicy }) };
  if (output) { await writeFile(output, JSON.stringify(result, null, 2) + '\n'); console.log(`Wrote ${result.rows.length} projections.`); }
  else console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
