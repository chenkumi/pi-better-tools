// D22 probe: while Pi's own settings writer (FileSettingsStorage.withLock, the primitive used by SettingsManager) holds its global
// settings lock, run the REAL gpt-speed `/fast` command handler. The host callback is synchronous, so this is a deterministic
// deferred barrier (no sleeps of ours): if the two writers share a lock identity the module cannot write inside the critical section
// (it retries, then reports ELOCKED); if the identities are split it writes while the host holds its lock.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function probe({ root, hostAgentDir, moduleSettingsReadPath, cwd }) {
  process.env.PI_CODING_AGENT_DIR = hostAgentDir; // module getAgentDir() resolves to the same (lexical) agentDir as the host
  const { default: factory } = await import(pathToFileURL(join(root, 'modules/gpt-speed/extensions/gpt-speed.ts')).href);
  const { FileSettingsStorage } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js')).href);
  const commands = new Map();
  factory({ registerCommand: (name, def) => commands.set(name, def), on() {} });
  const warnings = [];
  const originalError = console.error; console.error = (...a) => { warnings.push(a.join(' ')); };
  const ctx = { hasUI: false, mode: 'print', cwd, model: undefined, isProjectTrusted: () => false, ui: {} };
  const storage = new FileSettingsStorage(cwd, hostAgentDir);
  let pending, modeWrittenWhileHostLocked;
  try {
    storage.withLock('global', current => {
      pending = commands.get('fast').handler('', ctx); // synchronous part runs persistMode while the host lock is held
      modeWrittenWhileHostLocked = JSON.parse(readFileSync(moduleSettingsReadPath, 'utf8'))['pi-gpt-speed']?.mode === 'fast';
      return current; // host writes back its (stale) snapshot unchanged
    });
    await pending;
  } finally { console.error = originalError; }
  return { modeWrittenWhileHostLocked, warnings };
}
export const describeFailure = r => `module wrote while host lock was held: ${r.modeWrittenWhileHostLocked}; warnings=${JSON.stringify(r.warnings)}`;
