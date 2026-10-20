import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
// Fails at the first unsuccessful stage; never turns a failed refresh into fabricated data.
for(const script of ['refresh-real-data','evaluate-forward','build'])execFileSync(process.execPath,[`scripts/${script}.mjs`],{cwd:root,stdio:'inherit'});
console.log('Source snapshot, prospective grading and local build updated. Publish separately to update the hosted site.');
