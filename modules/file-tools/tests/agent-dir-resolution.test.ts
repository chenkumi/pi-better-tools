import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getFileToolsConfigPath } from "../src/debug-logging.js";

const saved = process.env.PI_CODING_AGENT_DIR;
afterEach(() => { if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; });

// The host expands `~` in PI_CODING_AGENT_DIR; file-tools must read the same settings.json the host does.
describe("file-tools settings path follows the host's agent directory", () => {
  it("expands a leading ~ in PI_CODING_AGENT_DIR exactly like getAgentDir()", () => {
    process.env.PI_CODING_AGENT_DIR = "~/tilde-agent";
    assert.equal(getFileToolsConfigPath(), join(getAgentDir(), "settings.json"));
    assert.ok(getFileToolsConfigPath().startsWith(homedir()), "the path is under the real home directory, not a literal ~ folder");
  });

  it("plain and default locations are unchanged", () => {
    process.env.PI_CODING_AGENT_DIR = join(homedir(), "plain-agent");
    assert.equal(getFileToolsConfigPath(), join(getAgentDir(), "settings.json"));
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(getFileToolsConfigPath(), join(getAgentDir(), "settings.json"));
  });
});
