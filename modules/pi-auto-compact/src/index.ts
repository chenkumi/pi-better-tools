import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerCheckpoint } from './checkpoint/hooks.ts';
import { progressCheckpointTool } from './checkpoint/tool.ts';
import { autoCompact } from './compact/hook.ts';
import { loadConfig } from './config.ts';
import { registerGuidance } from './guidance.ts';
import { sessionTools } from './session-read/tool.ts';
import { registerAutoCompactSettings } from './settings.ts';

/**
 * pi-auto-compact: deterministic compaction that never calls a model.
 *
 * Pi keeps ownership of when to compact and where to cut; this handler only replaces the summary of the entries before the
 * cut. Whenever it cannot (invalid settings, unknown context window, an unexpected failure) it returns nothing and Pi keeps its
 * own compaction, so a compaction is never lost. Also registers the deferred, read-only `session_grep` / `session_window` /
 * `session_read` tools that the summary's line references point at. Mount this entry OR Blackhole, not both: no coordination
 * between the two is implemented.
 */
export default function piAutoCompact(pi: ExtensionAPI) {
  for (const tool of sessionTools) pi.registerTool(tool);
  pi.registerTool(progressCheckpointTool);
  registerCheckpoint(pi);
  registerGuidance(pi);
  registerAutoCompactSettings(pi);
  let warned = false;
  const warn = (ctx: { hasUI: boolean; ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void } }, message: string) => {
    if (warned || !ctx.hasUI) return;
    warned = true;
    ctx.ui.notify(`pi-auto-compact: ${message}. Compaction is left to Pi.`, 'warning');
  };
  pi.on('session_before_compact', async (event, ctx) => {
    const loaded = loadConfig(getAgentDir());
    if (!loaded.ok) { warn(ctx, loaded.error); return undefined; }
    try { return await autoCompact(event, ctx, loaded.config); }
    catch (error) { warn(ctx, `compaction failed (${error instanceof Error ? error.message : String(error)})`); return undefined; }
  });
}
