import assert from "node:assert/strict";
import test from "node:test";
import { checkGitReadonly } from "../extensions/subagent/git-readonly.ts";

const HARDENED = "git --no-pager --no-optional-locks -c core.fsmonitor=false";

test("allows git diff, log and show and rewrites them with a hardened prefix", () => {
	assert.deepEqual(checkGitReadonly("git diff HEAD~1..HEAD -- src/a.ts"), { ok: true, command: `${HARDENED} diff --no-ext-diff --no-textconv HEAD~1..HEAD -- src/a.ts` });
	assert.deepEqual(checkGitReadonly("  git log --oneline -n 5 "), { ok: true, command: `${HARDENED} log --no-ext-diff --no-textconv --oneline -n 5` });
	assert.equal(checkGitReadonly("git show HEAD:README.md").ok, true);
});

test("rejects other git subcommands, other programs and global options", () => {
	for (const command of ["git status", "git commit -m x", "git -c core.pager=x diff", "git", "ls", "git.exe diff", "gitdiff", "", undefined, 3])
		assert.equal(checkGitReadonly(command).ok, false, String(command));
});

test("rejects shell syntax instead of parsing it", () => {
	for (const command of ["git diff; rm -rf x", "git diff && id", "git diff | cat", "git diff > out", "git diff `id`", "git diff $(id)", "git diff $HOME", "git diff 'a b'", 'git diff "a"', "git diff *.ts", "git diff a\nb", "git diff \\host\share", "git diff ~root", "git diff @{u}"])
		assert.equal(checkGitReadonly(command).ok, false, JSON.stringify(command));
});

test("rejects file-writing, program-running and out-of-repo options, including abbreviations", () => {
	for (const option of ["--output=x", "--output", "--out=x", "--o=x", "--ext-diff", "--ext", "--textconv", "--text", "--no-index", "--no", "--open-files-in-pager"])
		assert.equal(checkGitReadonly(`git diff ${option}`).ok, false, option);
	for (const option of ["--oneline", "--name-only", "--no-color", "--stat", "-p", "--"]) assert.equal(checkGitReadonly(`git log ${option}`).ok, true, option);
});
