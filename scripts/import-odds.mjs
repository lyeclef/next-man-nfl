import { readFile, writeFile } from 'node:fs/promises';
import { mergeOddsExport } from '../lib/odds-import.mjs';
import { validateDataset } from '../lib/model.mjs';
try {
  const [slate, eventFile, mappingFile, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/import-odds.mjs <slate.json> <event-odds.json> <mapping.json> <output.json>');
  const read = async file => JSON.parse(await readFile(file, 'utf8'));
  const [data, events, mappings] = await Promise.all([slate, eventFile, mappingFile].map(read));
  const result = mergeOddsExport(data, events, mappings); validateDataset(result.dataset);
  await writeFile(output, JSON.stringify(result.dataset, null, 2) + '\n'); console.log(`Merged ${result.merged} paired props. Review source labels and remove any superseded quotes before importing.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
