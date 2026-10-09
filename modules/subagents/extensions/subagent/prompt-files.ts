import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { IoGate } from './io-gate.ts';
export interface PromptFiles { dir: string; filePath: string; taskPath: string }

/** One owned operation: cancellation stops waiting, never deletes an in-flight
 * write. The late operation checks admission between steps and cleans its own
 * directory only after all started writes have settled. */
export function createPromptFiles(agentName: string, prompt: string, task: string, gate: IoGate, onLateCleanupError: (error: unknown) => void = () => {}, onOwnedCleanup: (settlement: Promise<void>) => void = () => {}): Promise<PromptFiles> {
  return gate.run(async () => {
    let files: PromptFiles | undefined;
    try {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-'));
      files = { dir, filePath: path.join(dir, `prompt-${agentName.replace(/[^\w.-]+/g, '_')}.md`), taskPath: path.join(dir, 'task.txt') };
      if (gate.stopped) throw new Error('Prompt creation cancelled before write');
      await withFileMutationQueue(files.filePath, () => {
        if (gate.stopped) throw new Error('Prompt creation cancelled before queued prompt write');
        return fs.promises.writeFile(files!.filePath, prompt, { encoding: 'utf8', mode: 0o600 });
      });
      if (gate.stopped) throw new Error('Prompt creation cancelled before task write');
      await withFileMutationQueue(files.taskPath, () => {
        if (gate.stopped) throw new Error('Prompt creation cancelled before queued task write');
        return fs.promises.writeFile(files!.taskPath, `Task: ${task}`, { encoding: 'utf8', mode: 0o600 });
      });
      if (gate.stopped) throw new Error('Prompt creation cancelled before spawn');
      return files;
    } catch (error) {
      // Detached cleanup is still serialized AFTER the write owner has settled.
      // Never delay returning the original fault on a second filesystem stall.
      if (files) {
        const cleanup = removePromptFiles(files).catch(onLateCleanupError);
        try { onOwnedCleanup(cleanup); } catch { /* observation cannot change ownership */ }
      }
      throw error;
    }
  }, 'prepare prompt/task files');
}
export function removePromptFiles(files: PromptFiles): Promise<void> {
  return withFileMutationQueue(files.filePath, () => withFileMutationQueue(files.taskPath, () => fs.promises.rm(files.dir, { recursive: true, force: true })));
}
