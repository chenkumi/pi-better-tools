import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changeMessage } from "../src/change-notice.js";
import { captureGitState, diffGitState, GitWatch, gitNotice } from "../src/git-state.js";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "file-audit-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "."); git("commit", "-q", "-m", "first");
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("nothing moved: no change, and the state holds no path or content", async () => {
  const r = repo();
  try {
    const a = await captureGitState(r.dir), b = await captureGitState(r.dir);
    assert.ok(a && b);
    assert.equal(diffGitState(a, b), undefined);
    assert.deepEqual(Object.keys(a).sort(), ["branch", "head", "tree"]);
    assert.equal(a.branch, "main");
  } finally { r.done(); }
});

test("branch, commit and working tree changes are told apart", async () => {
  const r = repo();
  try {
    const start = (await captureGitState(r.dir))!;
    writeFileSync(join(r.dir, "a.txt"), "SECRET CONTENT\n");
    const edited = (await captureGitState(r.dir))!;
    assert.deepEqual(diffGitState(start, edited), { tree: true });
    r.git("commit", "-q", "-am", "second");
    const committed = (await captureGitState(r.dir))!;
    const commit = diffGitState(edited, committed)!;
    assert.equal(commit.head?.from, start.head);
    assert.equal(commit.branch, undefined);
    assert.equal(commit.tree, true);
    r.git("checkout", "-q", "-b", "feature/x");
    const switched = (await captureGitState(r.dir))!;
    assert.deepEqual(diffGitState(committed, switched), { branch: { from: "main", to: "feature/x" } });
    r.git("checkout", "-q", "--detach");
    const detached = (await captureGitState(r.dir))!;
    assert.deepEqual(diffGitState(switched, detached), { branch: { from: "feature/x", to: undefined } });
    const text = gitNotice(diffGitState(switched, detached)!);
    assert.match(text, /branch feature\/x → \(detached\)/);
    assert.doesNotMatch(text, /SECRET/);
  } finally { r.done(); }
});

test("the notice is one short line naming only branch, short HEAD and the working tree", () => {
  const text = gitNotice({ branch: { from: "main", to: "dev" }, head: { from: "a".repeat(40), to: "b".repeat(40) }, tree: true });
  assert.equal(text, "Git state differs from your last reply: branch main → dev; HEAD aaaaaaa → bbbbbbb; working tree changed. Use git status or git diff for details.");
});

test("a watch reports a difference once, and stays silent outside a repository or without a baseline", async () => {
  const r = repo();
  try {
    const watch = new GitWatch();
    assert.equal(await watch.detect(r.dir), undefined, "no baseline yet");
    watch.mark(r.dir);
    assert.equal(await watch.detect(r.dir), undefined, "nothing moved");
    r.git("checkout", "-q", "-b", "other");
    assert.deepEqual(await watch.detect(r.dir), { branch: { from: "main", to: "other" } });
    assert.equal(await watch.detect(r.dir), undefined, "the same change is reported once");
    watch.mark(r.dir);
    watch.reset();
    r.git("checkout", "-q", "main");
    assert.equal(await watch.detect(r.dir), undefined, "reset forgets the baseline");
  } finally { r.done(); }
  const plain = mkdtempSync(join(tmpdir(), "file-audit-nogit-"));
  try {
    const watch = new GitWatch();
    watch.mark(plain);
    assert.equal(await watch.detect(plain), undefined);
    assert.equal(await captureGitState(join(plain, "missing")), undefined);
    const aborted = new AbortController(); aborted.abort();
    assert.equal(await captureGitState(plain, aborted.signal), undefined);
  } finally { try { rmSync(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows may still hold the directory for a killed git; the OS temp cleaner removes it */ } }
});

test("a git-only change makes the audit message; with file changes the line is added to the existing text", () => {
  const git = { branch: { from: "main", to: "dev" } };
  const only = changeMessage([], process.cwd(), git);
  assert.match(only.content, /^File Audit: Git state differs from your last reply: branch main → dev\./);
  assert.deepEqual(only.details, { changed: [], omitted: 0, git });
  const both = changeMessage([{ path: join(process.cwd(), "x.txt"), change: "modified" }], process.cwd(), git);
  assert.match(both.content, /re-read a file before editing it\.\n\{"changed":\[\{"path":"x\.txt","change":"modified"\}\]\}\nGit state differs/);
  assert.equal(changeMessage([{ path: join(process.cwd(), "x.txt"), change: "modified" }], process.cwd()).content.includes("Git state"), false);
});

test("files under .pi (Fork transcripts, schedules) do not change the working tree digest", async () => {
  const r = repo();
  try {
    const before = (await captureGitState(r.dir))!;
    mkdirSync(join(r.dir, ".pi", "forks", "job"), { recursive: true });
    writeFileSync(join(r.dir, ".pi", "forks", "job", "transcript.jsonl"), "{}\n");
    assert.equal(diffGitState(before, (await captureGitState(r.dir))!), undefined);
    writeFileSync(join(r.dir, "b.txt"), "new\n");
    assert.deepEqual(diffGitState(before, (await captureGitState(r.dir))!), { tree: true });
  } finally { r.done(); }
});

test("only Pi's own bookkeeping under .pi is left out; project files there still change the digest, also from a subdirectory", async () => {
  const r = repo();
  try {
    mkdirSync(join(r.dir, ".pi", "agent"), { recursive: true });
    mkdirSync(join(r.dir, "sub"));
    writeFileSync(join(r.dir, "sub", "keep.txt"), "x\n");
    const before = (await captureGitState(r.dir))!;
    writeFileSync(join(r.dir, ".pi", "schedule-prompts.json"), "{}\n");
    writeFileSync(join(r.dir, ".pi", "agent", "schedule-prompts-settings.json"), "{}\n");
    assert.equal(diffGitState(before, (await captureGitState(r.dir))!), undefined, "schedule files are bookkeeping");
    writeFileSync(join(r.dir, ".pi", "settings.json"), "{}\n");
    assert.deepEqual(diffGitState(before, (await captureGitState(r.dir))!), { tree: true }, "project settings under .pi count");
    const inSub = (await captureGitState(join(r.dir, "sub")))!;
    mkdirSync(join(r.dir, "sub", ".pi", "forks", "j"), { recursive: true });
    writeFileSync(join(r.dir, "sub", ".pi", "forks", "j", "t.jsonl"), "{}\n");
    assert.equal(diffGitState(inSub, (await captureGitState(join(r.dir, "sub")))!), undefined, "cwd-relative .pi/forks is excluded from a subdirectory");
  } finally { r.done(); }
});
