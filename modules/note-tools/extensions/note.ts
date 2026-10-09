import { mkdir, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const displayText = (value: unknown, max = 2000) => typeof value === "string"
  ? stripVTControlCharacters(value.slice(0, max * 4)).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, max) : "";

/** Generous UTF-8 byte cap for one note (a note is a document, not a data dump). */
export const MAX_NOTE_BYTES = 8 * 1024 * 1024;

const noteTypes = ["plan", "issue", "research", "report", "task"] as const;

export const noteTool = defineTool({
  name: "note",
  label: "Note",
  description:
    "Save a NEW Markdown document as plan, issue, research, report or task. Required for such documents: do NOT use write and do NOT choose a file name or folder. " +
    "The tool picks <cwd>/<type>/TYPE-YYYYMMDDTHHmmssSSSZ.md (UTC; no title suffix), never overwrites, and returns the path; send the complete document in one call. " +
    "Use it when asked to write down, record, save or log such a document, or when finished work deserves a record. Not for source code or existing files: to change a note afterwards use read/edit on the returned path.",
  promptSnippet: "Save a new plan/issue/research/report/task Markdown document; file name is auto-generated and the saved path is returned.",
  promptGuidelines: [
    "Create plan/issue/research/report/task documents with note { type, content }, not write.",
  ],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  parameters: Type.Object({
    type: StringEnum(noteTypes, { description: "Category and folder: plan = approach/design/roadmap; issue = bug/problem/risk; research = findings; report = results/summary/review; task = to-do." }),
    content: Type.String({ description: "The full Markdown document, including a title heading, written verbatim. Do not include a file name." }),
  }, { additionalProperties: false }),
  outputSchema: Type.Object({
    relativePath: Type.String(),
  }, { additionalProperties: false }),
  renderCall(args, theme) {
    const type = displayText(args?.type, 20) || "…";
    const title = displayText(args?.content, 300).split("\n").find(line => line.trim())?.replace(/^#+\s*/, "").slice(0, 100) || "";
    return new Text(`${theme.fg("toolTitle", theme.bold("note"))} ${theme.fg("accent", type)}${title ? ` · ${theme.fg("muted", title)}` : ""}`, 0, 0);
  },
  renderResult(result, { isPartial }, theme, context) {
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    if (context.isError) return new Text(theme.fg("error", `Note failed\n${displayText(text)}`), 0, 0);
    if (isPartial) return new Text(theme.fg("muted", "Saving note…"), 0, 0);
    const saved = result.details as Partial<{ relativePath: string }> | undefined;
    const path = displayText(saved?.relativePath);
    return new Text(theme.fg("success", path ? `Saved note: ${path}` : displayText(text) || "Note result unavailable"), 0, 0);
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    // Also protect direct/programmatic callers that bypass the host's schema validation.
    if (!noteTypes.includes(params.type) || typeof params.content !== "string" || /[\uD800-\uDFFF]/u.test(params.content)) {
      throw new Error("NOTE_INVALID_ARGUMENTS: Expected a supported type and well-formed Unicode string content.");
    }
    if (Buffer.byteLength(params.content, "utf8") > MAX_NOTE_BYTES) {
      throw new Error(`NOTE_TOO_LARGE: Content exceeds ${MAX_NOTE_BYTES} bytes; split it into several notes.`);
    }
    if (params.content.trim() === "") {
      throw new Error("NOTE_EMPTY: content is empty or whitespace only. Write the complete Markdown document (with a title heading) into content and call note again.");
    }
    signal?.throwIfAborted();
    const directory = resolve(ctx.cwd, params.type);
    await mkdir(directory, { recursive: true });
    // <cwd>/<type> may be a pre-existing symlink/junction; refuse to write outside the workspace.
    const [realCwd, realDirectory] = await Promise.all([realpath(ctx.cwd), realpath(directory)]);
    const inside = relative(realCwd, realDirectory);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`NOTE_DIRECTORY_ESCAPE: ${params.type}/ resolves outside the workspace; refusing to write.`);
    }
    const timestamp = Date.now();
    for (let attempt = 0; attempt < 1000; attempt++) {
      const stamp = new Date(timestamp + attempt).toISOString().replace(/[-:.]/g, "");
      const filename = `${params.type.toUpperCase()}-${stamp}.md`;
      const path = join(directory, filename);
      try {
        await withFileMutationQueue(path, async () => {
          signal?.throwIfAborted();
          // Exclusive creation is the cross-process no-overwrite guard. Do not cancel
          // mid-write: once started, finish writing and report the resulting path.
          const handle = await open(path, "wx", 0o644);
          try { await handle.writeFile(params.content, "utf8"); }
          catch (error) {
            // We created this file (wx), so a partial result from e.g. ENOSPC is ours to remove.
            await handle.close().catch(() => {});
            await rm(path, { force: true }).catch(() => {});
            throw error;
          }
          await handle.close();
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") continue;
        throw error;
      }
      const saved = { relativePath: `${params.type}/${filename}` };
      return {
        content: [{ type: "text", text: `Saved note: ${saved.relativePath} (relative to cwd; use read/edit on this path to change it)` }],
        details: saved,
        structuredContent: saved,
      };
    }
    throw new Error("NOTE_FILENAME_COLLISION: Could not allocate a new filename after 1000 attempts. Retry the call.");
  },
});

export default function noteExtension(pi: ExtensionAPI) {
  pi.registerTool(noteTool);
}
