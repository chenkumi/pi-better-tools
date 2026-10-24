import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FileToolError } from "../src/errors.js";
import { normalizeToolPath, resolveToolPath } from "../src/path-utils.js";

// A malformed file:// URL used to escape as Node's raw URIError instead of the tool's structured INVALID_ARGUMENT error.
describe("malformed file URLs are structured argument errors", () => {
  for (const input of ["file:///tmp/%%/x.txt", "@file:///tmp/%zz/x.txt", "file:///tmp/%2f/x.txt"]) {
    it(`rejects ${input}`, () => {
      for (const call of [() => normalizeToolPath(input), () => resolveToolPath(input, process.cwd())]) {
        assert.throws(call, (error: unknown) => error instanceof FileToolError && error.payload.code === "INVALID_ARGUMENT" && !(error instanceof URIError));
      }
    });
  }

  it("keeps well-formed file URLs working", () => {
    assert.match(resolveToolPath(process.platform === "win32" ? "file:///c:/tmp/x.txt" : "file:///tmp/x.txt", process.cwd()), /x\.txt$/);
  });
});
