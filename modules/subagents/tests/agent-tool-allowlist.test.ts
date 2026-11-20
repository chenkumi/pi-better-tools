import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_AGENT_TOOLS, discoverAgents } from "../extensions/subagent/agents.ts";

const SQL = ["mysql", "mssql", "pgsql"].flatMap((db) => [`${db}_state`, `${db}_query`, `${db}_update`]);
const SQLITE = ["open", "close", "status", "query", "execute", "list_tables", "describe_table", "manual"].map((name) => `sqlite_${name}`);
const READ_ONLY = ["read", "grep", "find", "ls", "note"];

const bundled = (name: string) => {
	const home = mkdtempSync(join(tmpdir(), "pi-allowlist-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(home, "agent");
	try { return discoverAgents(join(home, "workspace"), "user").agents.find((agent) => agent.name === name && agent.source === "bundled")!; }
	finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(home, { recursive: true, force: true }); }
};

test("bundled agents carry exactly their tool allowlist", () => {
	assert.deepEqual(bundled("scout").tools, READ_ONLY);
	assert.deepEqual(bundled("planner").tools, READ_ONLY);
	assert.deepEqual(bundled("reviewer").tools, ["read", "grep", "find", "ls", "bash", "powershell", "note"]);
	assert.deepEqual(bundled("worker").tools, ["read", "write", "edit", "grep", "find", "ls", "bash", "powershell", "note", "tool_search", "web_fetch", "web_search", ...SQLITE, ...SQL]);
});

test("only reviewer has the git-only shell", () => {
	assert.equal(bundled("reviewer").shell, "git-readonly");
	for (const name of ["worker", "scout", "planner"]) assert.equal(bundled(name).shell, undefined, name);
});

test("an agent without tools gets the read-only default instead of the host's tool set", () => {
	assert.deepEqual([...DEFAULT_AGENT_TOOLS], READ_ONLY);
	const home = mkdtempSync(join(tmpdir(), "pi-allowlist-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(home, "agent");
	try {
		mkdirSync(join(home, "agent", "agents"), { recursive: true });
		writeFileSync(join(home, "agent", "agents", "bare.md"), "---\nname: bare\ndescription: no tools\n---\nBody.");
		writeFileSync(join(home, "agent", "agents", "empty.md"), "---\nname: empty\ndescription: empty tools\ntools: \"\"\n---\nBody.");
		const agents = discoverAgents(join(home, "workspace"), "user").agents;
		assert.deepEqual(agents.find((agent) => agent.name === "bare")?.tools, READ_ONLY);
		assert.deepEqual(agents.find((agent) => agent.name === "empty")?.tools, READ_ONLY);
	} finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(home, { recursive: true, force: true }); }
});
