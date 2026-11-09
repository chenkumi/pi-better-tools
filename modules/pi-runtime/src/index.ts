import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerCrossToolGuidance } from './cross-tool-guidance.ts';
import { registerDeferredTools } from './deferred-tools.ts';

/** Shared infrastructure: deferred-tool discovery and cross-module prompt rules. The settings panel layer is imported directly by modules. */
export default function runtime(pi: ExtensionAPI) {
  registerDeferredTools(pi);
  registerCrossToolGuidance(pi);
}
