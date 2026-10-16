#!/usr/bin/env node
import { main } from './core.mjs';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`[setup] ${error instanceof Error ? error.message : 'Setup failed.'}`);
  process.exitCode = 1;
}
