import assert from "node:assert/strict";
import test from "node:test";
import { filterEnv, parseEnvPolicy } from "../src/env.ts";

const source = { PATH: "/bin", HOME: "/h", AWS_SECRET: "s", AWS_REGION: "r", EMPTY: undefined };
test("no policy keeps the whole environment (default unchanged)", () => {
	assert.deepEqual(filterEnv(source, undefined), { PATH: "/bin", HOME: "/h", AWS_SECRET: "s", AWS_REGION: "r" });
	assert.equal(parseEnvPolicy(undefined), undefined);
	assert.equal(parseEnvPolicy({ targets: {} }), undefined);
});
test("allow keeps only listed names, deny removes, prefix wildcard works", () => {
	assert.deepEqual(filterEnv(source, { allow: ["PATH", "AWS_*"] }, "linux"), { PATH: "/bin", AWS_SECRET: "s", AWS_REGION: "r" });
	assert.deepEqual(filterEnv(source, { deny: ["AWS_*"] }, "linux"), { PATH: "/bin", HOME: "/h" });
	assert.deepEqual(filterEnv(source, { allow: ["PATH", "AWS_*"], deny: ["AWS_SECRET"] }, "linux"), { PATH: "/bin", AWS_REGION: "r" });
	assert.deepEqual(filterEnv(source, { allow: [] }, "linux"), {});
});
test("names compare case-insensitively only on Windows", () => {
	assert.deepEqual(filterEnv({ Path: "x" }, { allow: ["PATH"] }, "win32"), { Path: "x" });
	assert.deepEqual(filterEnv({ Path: "x" }, { allow: ["PATH"] }, "linux"), {});
});
test("invalid policy fails closed with a clear error", () => {
	assert.throws(() => parseEnvPolicy({ env: { allow: "PATH" } }), /pi-pty-terminal\.env\.allow/);
	assert.throws(() => parseEnvPolicy({ env: { deny: ["A=B"] } }), /pi-pty-terminal\.env\.deny/);
	assert.throws(() => parseEnvPolicy({ env: { permit: [] } }), /Unsupported/);
	assert.throws(() => parseEnvPolicy({ env: [] }), /Invalid pi-pty-terminal\.env/);
	assert.deepEqual(parseEnvPolicy({ env: { allow: ["PATH"], deny: ["X*"] } }), { allow: ["PATH"], deny: ["X*"] });
});
