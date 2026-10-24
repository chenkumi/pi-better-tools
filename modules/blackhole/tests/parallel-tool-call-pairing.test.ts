// Parallel tool calls: one assistant message carries several bash calls and the results follow in a block run
// (call1, call2, result1, result2). Calls and results must be paired by toolCallId, never by tool name or position.
import { describe, expect, it } from "vitest";
import { extractCommits } from "../src/extract/commits.ts";
import { buildSections } from "../src/core/build-sections.ts";

const call = (id: string, command: string, sourceIndex: number) => ({ kind: "tool_call" as const, name: "bash", args: { command }, toolCallId: id, sourceIndex });
const result = (id: string, text: string, isError: boolean, sourceIndex: number) => ({ kind: "tool_result" as const, name: "bash", text, isError, toolCallId: id, sourceIndex });

describe("commit extraction pairs a commit with its own result", () => {
  it("two parallel commits keep their own hashes", () => {
    const commits = extractCommits([
      call("c1", "git commit -m alpha", 1), call("c2", "git commit -m beta", 1),
      result("c1", "[main 1111111] alpha", false, 2), result("c2", "[main 2222222] beta", false, 3),
    ] as never);
    expect(commits.find((c) => c.message === "alpha")?.hash).toBe("1111111");
    expect(commits.find((c) => c.message === "beta")?.hash).toBe("2222222");
  });

  it("a non-commit sibling that comes first does not shadow the real commit result", () => {
    const commits = extractCommits([
      call("d1", "ls src", 5), call("d2", "git commit -m gamma", 5),
      result("d1", "a.ts\nb.ts", false, 6), result("d2", "[main 3333333] gamma", false, 7),
    ] as never);
    expect(commits).toEqual([{ hash: "3333333", message: "gamma", sourceIndex: 5 }]);
  });

  it("a failed sibling's result is not taken for the commit's, and a failed commit is not recorded", () => {
    const commits = extractCommits([
      call("e1", "git commit -m delta", 8), call("e2", "false", 8),
      result("e1", "[main 4444444] delta", false, 9), result("e2", "boom", true, 10),
    ] as never);
    expect(commits.map((c) => c.hash)).toEqual(["4444444"]);
    expect(extractCommits([call("f1", "git commit -m eps", 1), result("f1", "nothing to commit", true, 2)] as never)).toEqual([]);
  });

  it("results without toolCallId (older sessions) still pair sequentially", () => {
    const legacyCall = { kind: "tool_call" as const, name: "bash", args: { command: "git commit -m zeta" }, sourceIndex: 1 };
    const legacyResult = { kind: "tool_result" as const, name: "bash", text: "[main 5555555] zeta", isError: false, sourceIndex: 2 };
    expect(extractCommits([legacyCall, legacyResult] as never)[0]?.hash).toBe("5555555");
  });
});

describe("outstanding context knows which command failed", () => {
  const blocks = [
    call("t1", "npm test", 1), call("t2", "git status", 1),
    result("t1", "1 failing test in tests/a.test.ts", true, 2), result("t2", "On branch main", false, 3),
  ];

  it("a failure is kept when a different parallel command succeeds afterwards", () => {
    expect(buildSections({ blocks } as never).outstandingContext).toEqual(["[bash] 1 failing test in tests/a.test.ts"]);
  });

  it("the same command succeeding later still clears the failure", () => {
    const fixed = [call("a", "npm test", 1), result("a", "1 failing test", true, 2), call("b", "npm test", 3), result("b", "all passed", false, 4)];
    expect(buildSections({ blocks: fixed } as never).outstandingContext).toEqual([]);
  });

  it("sequential order gives the same answer as the parallel one", () => {
    const sequential = [blocks[0], blocks[2], blocks[1], blocks[3]];
    expect(buildSections({ blocks: sequential } as never).outstandingContext).toEqual(["[bash] 1 failing test in tests/a.test.ts"]);
  });
});
