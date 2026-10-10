// Test-only extension: cancels the run from agent_before_settle (host-level cancel without a process signal)
// and records the final agent_settled.aborted value next to the request log.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  let done = false;
  pi.on('agent_before_settle', (_event, ctx) => { if (done) return; done = true; ctx.abort(); });
  pi.on('agent_settled', (event) => { writeFileSync(join(dirname(process.env.REPRO_LOG!), 'settled.json'), JSON.stringify({ aborted: (event as any).aborted })); });
}
