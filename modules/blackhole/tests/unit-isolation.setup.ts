import { afterEach, beforeEach, expect } from "vitest";
import { mayExerciseNormalDefaults } from "./fixtures/unit-isolation-policy.js";

// The production/real-host harness stays passive. Only these pure config loaders
// and SDK-mocked command tests may exercise normal defaults in an isolated home.
const initialPassive = process.env.PI_BLACKHOLE_PASSIVE;
function restorePassive() {
  if (initialPassive === undefined) delete process.env.PI_BLACKHOLE_PASSIVE;
  else process.env.PI_BLACKHOLE_PASSIVE = initialPassive;
}

beforeEach(() => {
  if (process.env.PI_BLACKHOLE_UNIT_ISOLATED !== "1") return;
  // Also reset before each case: file-level teardown may run after our hook.
  restorePassive();
  if (!mayExerciseNormalDefaults(expect.getState().testPath ?? "")) return;
  // No host session/worker is started by these contracts. Keep credentials and
  // HOME isolated; remove only the runner override, not config semantics.
  delete process.env.PI_BLACKHOLE_PASSIVE;
});

afterEach(() => {
  if (process.env.PI_BLACKHOLE_UNIT_ISOLATED !== "1") return;
  restorePassive();
});
