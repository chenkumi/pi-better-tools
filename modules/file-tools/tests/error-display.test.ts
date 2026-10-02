import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fileToolsExtension from "../extensions/file-tools.js";
import { FileToolError, formatFileToolErrorForDisplay, parseFileToolErrorText } from "../src/errors.js";

const wire = (value: unknown) => `[FILE_TOOL_ERROR]\n${JSON.stringify(value)}`;
const base = { status: "error", code: "TEXT_NOT_FOUND", message: "No match." };
const malformed: Array<{ name: string; text: string }> = [
  { name: "plain text", text: "plain failure" },
  { name: "broken JSON", text: "[FILE_TOOL_ERROR]\n{" },
  ...[null, [], 3, {}, { ...base, status: "success" }, { ...base, code: "FUTURE_CODE" }, { ...base, message: null }]
    .map((value, index) => ({ name: `required fields ${index}`, text: wire(value) })),
];
for (const field of ["path", "expectedHash", "actualHash", "rangePreview", "recovery", "causeCode"]) {
  for (const value of [null, 7, {}, []]) malformed.push({ name: `${field}=${JSON.stringify(value)}`, text: wire({ ...base, [field]: value }) });
}
for (const field of ["editIndex", "occurrences", "lineStart", "lineEnd"]) {
  for (const value of [null, "1", {}, [], -1, 1.5, 1e100]) malformed.push({ name: `${field}=${JSON.stringify(value)}`, text: wire({ ...base, [field]: value }) });
}
for (const value of [null, [], "1-2", { start: 0, end: 2 }, { start: 2, end: 1 }, { start: 1 }, { start: 1.5, end: 2 }, { start: 1, end: "2" }]) {
  malformed.push({ name: `lineRange=${JSON.stringify(value)}`, text: wire({ ...base, lineRange: value }) });
  malformed.push({ name: `candidate=${JSON.stringify(value)}`, text: wire({ ...base, candidateRanges: [value] }) });
}
for (const value of [null, "not an array", {}, 42]) malformed.push({ name: `candidateRanges=${JSON.stringify(value)}`, text: wire({ ...base, candidateRanges: value }) });
malformed.push(
  { name: "reversed line numbers", text: wire({ ...base, lineStart: 2, lineEnd: 1 }) },
  { name: "zero line number", text: wire({ ...base, lineStart: 0 }) },
  { name: "bad final candidate", text: wire({ ...base, candidateRanges: [{ start: 1, end: 2 }, null] }) },
);

interface Component { render(width: number): string[] }
interface Result { content: Array<{ type: "text"; text: string }>; details?: { appliedEdits?: number; changedCount?: number; diff?: string } }
type Renderer = (result: Result, options: object, theme: { fg(color: string, text: string): string }, context: { isError: boolean; expanded: boolean; lastComponent?: Component }) => Component;
function registeredRenderer(): Renderer {
  const tools: Array<Record<string, unknown>> = [];
  // The read tool subscribes to skill refreshes; renderer tests do not trigger the event.
  fileToolsExtension({
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
    on: () => () => {},
  } as never);
  const renderer = tools.find((tool) => tool.name === "edit")?.renderResult;
  assert.equal(typeof renderer, "function");
  return renderer as Renderer;
}
const theme = { fg: (_color: string, text: string) => text };
const renderText = (component: Component) => component.render(400).join("\n");

// Freeze all model-visible objects so accidental renderer mutations fail immediately.
function frozenResult(text: string, details?: Result["details"]): Result {
  const result: Result = { content: [{ type: "text", text }], ...(details ? { details } : {}) };
  Object.freeze(result.content[0]);
  Object.freeze(result.content);
  if (details) Object.freeze(details);
  return Object.freeze(result);
}

describe("BUG-007 error payload validation", () => {
  for (const example of malformed) {
    it(`falls back to raw text for ${example.name}`, () => {
      assert.equal(parseFileToolErrorText(example.text), undefined);
      for (const expanded of [false, true]) assert.equal(formatFileToolErrorForDisplay(example.text, expanded), example.text);
    });
  }

  it("accepts and copies every validated optional field, including zero editIndex and occurrences", () => {
    const payload = { ...base, path: "a.ts", editIndex: 0, occurrences: 0, lineStart: 2, lineEnd: 3,
      lineRange: { start: 2, end: 3 }, expectedHash: "", actualHash: "hash", causeCode: "EIO",
      candidateRanges: [{ start: 1, end: 1 }, { start: 8, end: 10 }], rangePreview: "2│old\r\n3│next", recovery: "Read again." };
    assert.deepEqual(parseFileToolErrorText(wire(payload)), payload);
    const extended = { ...payload, future: { anything: null } };
    assert.deepEqual(parseFileToolErrorText(wire(extended)), payload);
    assert.deepEqual(parseFileToolErrorText(`prefix\n${wire(payload)}\n`), payload);
    const expanded = formatFileToolErrorForDisplay(wire(payload), true);
    assert.match(expanded, /Edit: edits\[0\]/);
    assert.match(expanded, /Line range: 2–3/);
    assert.match(expanded, /Candidates: 1, 8–10/);
    assert.match(expanded, /Preview:\n2│old\n3│next/);
    assert.match(expanded, /Recovery: Read again\./);
    assert.doesNotMatch(formatFileToolErrorForDisplay(wire(payload), false), /Path:|Candidates:|Preview:|Recovery:/);
    assert.ok(parseFileToolErrorText(wire({ ...base, candidateRanges: [] })));
    assert.ok(parseFileToolErrorText(wire({ ...base, lineStart: 1 })));
    assert.match(formatFileToolErrorForDisplay(wire({ ...base, lineStart: 1, lineEnd: 1 }), true), /Line range: 1/);
  });

  it("the registered renderer tolerates every malformed payload in both modes without changing model content", () => {
    const render = registeredRenderer();
    let lastComponent: Component | undefined;
    for (const example of malformed) {
      const result = frozenResult(example.text);
      const before = JSON.stringify(result);
      for (const expanded of [false, true, false]) {
        const component = render(result, {}, theme, { isError: true, expanded, lastComponent });
        if (lastComponent) assert.equal(component, lastComponent);
        assert.ok(renderText(component).length > 0);
        assert.doesNotMatch(renderText(component), /✗ Edit failed/);
        assert.equal(JSON.stringify(result), before);
        lastComponent = component;
      }
    }
  });

  it("reuses the real component across collapsed/expanded errors and successful diffs without stale details", () => {
    const render = registeredRenderer();
    const result = frozenResult(new FileToolError("INVALID_REGEX", "regexFlags is invalid.", {
      editIndex: 0, path: "sample.ts", candidateRanges: [{ start: 3, end: 4 }], recovery: "Use i/m/s/u.",
    }).message);
    const before = JSON.stringify(result);
    const component = render(result, {}, theme, { isError: true, expanded: false });
    assert.match(renderText(component), /Hint: regexFlags accepts only/);
    assert.doesNotMatch(renderText(component), /Candidates:|Path:/);
    assert.equal(render(result, {}, theme, { isError: true, expanded: true, lastComponent: component }), component);
    assert.match(renderText(component), /Candidates: 3–4/);
    assert.match(renderText(component), /Edit: edits\[0\]/);
    render(result, {}, theme, { isError: true, expanded: false, lastComponent: component });
    assert.doesNotMatch(renderText(component), /Candidates:|Path:/);
    assert.equal(JSON.stringify(result), before);

    const success = frozenResult("[FILE_EDIT_SUCCESS] original model feedback", { appliedEdits: 2, changedCount: 3, diff: "-1 old\n+1 new" });
    const originalSuccess = JSON.stringify(success);
    render(success, {}, theme, { isError: false, expanded: true, lastComponent: component });
    assert.match(renderText(component), /Applied 2 edit\(s\), 3 replacement\(s\)/);
    assert.match(renderText(component), /\+1 new/);
    assert.doesNotMatch(renderText(component), /Edit failed|Candidates:/);
    render(success, {}, theme, { isError: false, expanded: false, lastComponent: component });
    assert.doesNotMatch(renderText(component), /\+1 new/);
    assert.equal(JSON.stringify(success), originalSuccess);
  });
});
