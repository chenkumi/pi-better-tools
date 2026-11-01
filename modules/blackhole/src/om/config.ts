/**
 * Observational memory config — thin re-export from unified-config.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/config.ts)
 * Modified: re-exports unified types instead of standalone config.
 */
import {
  loadUnifiedConfig,
  DEFAULTS as UNIFIED_DEFAULTS,
  type OmModelConfig,
  type UnifiedConfig,
} from "../core/unified-config.js";

export type ConfiguredModel = OmModelConfig;
export type Config = UnifiedConfig;

export { loadUnifiedConfig as loadConfig };

export const DEFAULTS: Config = UNIFIED_DEFAULTS;
