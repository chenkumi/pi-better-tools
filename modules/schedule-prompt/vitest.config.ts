import { configDefaults, defineConfig } from "vitest/config";

// `tests/` holds node:test real-host integration files (run with `node --test`); vitest owns only `test/`.
export default defineConfig({
  // Lock-contention waits default to 0 in unit tests so fail-closed assertions are immediate; lock-reliability tests set a real wait explicitly.
  test: { exclude: [...configDefaults.exclude, "tests/**"], env: { PI_SCHEDULE_PROMPT_LOCK_WAIT_MS: "0" } },
});
