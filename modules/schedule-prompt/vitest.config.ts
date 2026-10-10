import { configDefaults, defineConfig } from "vitest/config";

// `tests/` holds node:test real-host integration files (run with `node --test`); vitest owns only `test/`.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "tests/**"] },
});
