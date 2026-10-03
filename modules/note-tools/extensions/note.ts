import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const displayText = (value: unknown, max = 2000) => typeof value === "string"
  ? stripVTControlCharacters(value.slice(0, max * 4)).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, max) : "";

const noteTypes = ["plan", "issue", "research", "report", "task"] as const;

export const noteTool = defineTool({
  name: "note",
  label: "Note",
  description:
    "Save a NEW Markdown document (plan, issue, research, report or task) to the project. This is the required way to create such documents: do NOT use write for them and do NOT invent a file name or folder. " +
    "Pass only `type` and the full `content`; the tool picks the folder (<cwd>/<type>/) and file name (TYPE-YYYYMMDDTHHmmssSSSZ.md, UTC), never overwrites anything, and returns the saved path. " +
    "Use it whenever the user asks to write down, record, save, document, file or log a plan, an issue/bug/problem, research/investigation findings, a report/summary/review, or a task/to-do, or when you finish work that deserves such a record. " +
    "Type guide: plan = proposed approach, design or roadmap; issue = bug, problem or risk found; research = investigation notes or findings; report = results, summary or review of completed work; task = actionable work item or to-do. " +
    "Not for source code, config, or existing files: to read or modify a note afterwards, use read/edit with the returned path.",
  promptSnippet: "Save a new plan/issue/research/report/task Markdown document; file name is auto-generated and the saved path is returned.",
  promptGuidelines: [
    "When creating a plan, issue, research, report or task document, call note with { type, content } instead of write; never choose its file name or location yourself.",
    "Put the complete document in content in one call; note only creates new files. Use the returned path with read/edit for any later changes.",
  ],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  parameters: Type.Object({
    type: StringEnum(noteTypes, { description: "Document category, which also selects the folder: plan (approach/design), issue (bug/problem/risk), research (findings), report (results/summary), task (to-do)." }),
    content: Type.String({ description: "The full Markdown document, including a title heading, written verbatim. Do not include a file name." }),
  }, { additionalProperties: false }),
  outputSchema: Type.Object({
    type: StringEnum(noteTypes),
    path: Type.String(),
    relativePath: Type.String(),
  }, { additionalProperties: false }),
  renderCall(args, theme) {
    const type = displayText(args?.type, 20) || "…";
    const title = displayText(args?.content, 300).split("\n").find(line => line.trim())?.replace(/^#+\s*/, "").slice(0, 100) || "";
    return new Text(`${theme.fg("toolTitle", theme.bold("note"))} ${theme.fg("accent", type)}${title ? ` · ${theme.fg("muted", title)}` : ""}`, 0, 0);
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    if (context.isError) return new Text(theme.fg("error", `Note failed\n${displayText(text)}`), 0, 0);
    if (isPartial) return new Text(theme.fg("muted", "Saving note…"), 0, 0);
    const saved = result.details as Partial<{ type: string; path: string; relativePath: string }> | undefined;
    const path = displayText(saved?.relativePath);
    return new Text(theme.fg("success", path ? `Saved ${displayText(saved?.type, 20)}: ${path}` : displayText(text) || "Note result unavailable") +
      (expanded && saved?.path ? `\n${theme.fg("muted", `Absolute path: ${displayText(saved.path)}`)}` : ""), 0, 0);
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    // Also protect direct/programmatic callers that bypass the host's schema validation.
    if (!noteTypes.includes(params.type) || typeof params.content !== "string" || /[\uD800-\uDFFF]/u.test(params.content)) {
      throw new Error("NOTE_INVALID_ARGUMENTS: Expected a supported type and well-formed Unicode string content.");
    }
    signal?.throwIfAborted();
    const directory = resolve(ctx.cwd, params.type);
    await mkdir(directory, { recursive: true });
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
          await writeFile(path, params.content, { encoding: "utf8", flag: "wx" });
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") continue;
        throw error;
      }
      const saved = { type: params.type, path, relativePath: `${params.type}/${filename}` };
      return {
        content: [{ type: "text", text: `Saved note: ${saved.relativePath}\nAbsolute path: ${saved.path}` }],
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
