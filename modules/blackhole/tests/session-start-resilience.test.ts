/**
 * Regression: startup diagnostics cannot retain a deferred ctx after disposal.
 *
 * Pi-owned review replaces the former detached migration-notice import with a
 * synchronous public session_start/session_tree settings resolver. Its former
 * catch-terminated dynamic-import requirement is superseded: the deferred
 * window itself is removed, not merely hidden by a catch. Actual persisted
 * session/reload/modal precedence is covered by pi-owned-review-projection.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = () => readFileSync(resolve(ROOT, "index.ts"), "utf8");

function settingsResolver(): string {
  const src = source();
  const start = src.indexOf("const resolveSessionSettings =");
  expect(start, "public startup resolver must exist").toBeGreaterThan(-1);
  const end = src.indexOf('\n  pi.on("session_start"', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("session_start/session_tree synchronous settings resilience", () => {
  test("both public lifecycle hooks use the same immediate settings resolver", () => {
    const src = source();
    expect(src).toContain('pi.on("session_start", resolveSessionSettings)');
    expect(src).toContain('pi.on("session_tree", resolveSessionSettings)');
    const handler = settingsResolver();
    expect(handler).toContain("omRuntime.reloadConfig(ctx.cwd");
    expect(handler).toContain("settingsConfig.resolveHostSession");
    expect(handler).toContain("settingsConfig.notifyWarnings");
  });

  test("ctx access has no asynchronous continuation after the handler returns", () => {
    const handler = settingsResolver();
    expect(handler).not.toMatch(/\basync\b|\bawait\b|\bimport\s*\(|\.then\s*\(/);
    expect(handler).not.toMatch(/\bsetTimeout\b|\bsetInterval\b|\bqueueMicrotask\b|\bvoid\b/);
    expect(handler).toMatch(/const resolveSessionSettings\s*=\s*\([^)]*\)\s*=>\s*\{/);
    expect(handler).toContain("ctx.ui?.notify?.");
  });

  test("the old detached migration import is absent, not an unhandled rejection", () => {
    expect(source()).not.toMatch(/void\s+import\s*\(/);
    expect(source()).not.toContain('import("./src/changelog/migration-notice');
  });
});
