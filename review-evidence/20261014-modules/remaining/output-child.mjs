import fs from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
setTimeout(() => { console.error('Progress: fixture safety deadline reached'); watcher.close(); process.exit(2); }, 20000);
fs.writeFileSync(join(root, 'owned-child.pid'), String(process.pid));
const watcher = fs.watch(root, (_event, name) => {
  if (name === 'finish.signal' && fs.existsSync(join(root, 'finish.signal'))) { watcher.close(); process.exit(0); }
});
process.stdout.write('X'.repeat(48 * 1024));
