import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { consumeManagedChildGuard } from '../../../shared/src/background/index.ts';
import { CONFIG_PATH, loadConfig } from './config.ts';
import { registerImageGenerationSettings } from './settings.ts';
import { createImageTool, type ImageToolDeps } from './tool.ts';

/**
 * Image Generation: one deferred `image_generate` tool and `/settings:image-generation`. The configuration file is read on
 * every call, so a saved change applies at once. A Subagent child does not get the tool (a paid external request is not
 * something a worker should start on its own); a Fork child may, but it has no UI to confirm in (see the README).
 */
export default function imageGeneration(pi: ExtensionAPI, seam: Partial<ImageToolDeps> & { configPath?: string } = {}) {
  if (consumeManagedChildGuard()) return;
  const path = seam.configPath ?? CONFIG_PATH;
  registerImageGenerationSettings(pi, seam.key ? { key: seam.key } : {}, path);
  // The switch is read once here so a disabled setup does not even list the deferred tool; execute checks it again.
  let enabled = true;
  try { enabled = loadConfig(path).enabled; } catch { /* a broken file is reported by the tool when it runs */ }
  if (!enabled) return;
  pi.registerTool(createImageTool({ readConfig: () => loadConfig(path), ...seam }));
}
