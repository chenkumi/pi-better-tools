import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from './config.ts';

/**
 * pi-auto-compact: deterministic compaction that never calls a model.
 *
 * M1 skeleton: the hook is registered and the configuration is validated, but no summary is produced yet, so the handler
 * returns nothing and Pi keeps its own compaction. Mount this entry OR Blackhole, not both: no coordination between the two
 * is implemented.
 */
export default function piAutoCompact(pi: ExtensionAPI) {
  let warned = false;
  pi.on('session_before_compact', (_event, ctx) => {
    const loaded = loadConfig(getAgentDir());
    if (!loaded.ok && !warned && ctx.hasUI) { warned = true; ctx.ui.notify(`pi-auto-compact: ${loaded.error}. Compaction is left to Pi.`, 'warning'); }
    return undefined;
  });
}
