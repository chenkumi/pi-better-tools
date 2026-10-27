// Test-only preload for the UNMODIFIED full verifier. Count successful readFile
// calls; do not replace the verifier, hashes, assertions or returned bytes.
import promises from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const original = promises.readFile;
const reads = [];
promises.readFile = async function (path, ...args) {
  const value = await original.call(this, path, ...args);
  const name = path instanceof URL ? fileURLToPath(path) : String(path);
  reads.push({ path: relative(process.cwd(), resolve(name)).replaceAll('\\', '/'), bytes: Buffer.byteLength(value) });
  return value;
};
syncBuiltinESMExports();
process.on('exit', () => {
  const content = reads.filter(row => row.path.startsWith('modules/workflow/'));
  writeFileSync(process.env.FILE_AUDIT_FULL_METRICS, JSON.stringify({
    reads, contentFiles: content.length, contentBytes: content.reduce((sum, row) => sum + row.bytes, 0),
    metadataBytes: reads.filter(row => row.path.startsWith('docs/')).reduce((sum, row) => sum + row.bytes, 0),
    totalBytes: reads.reduce((sum, row) => sum + row.bytes, 0),
  }));
});
