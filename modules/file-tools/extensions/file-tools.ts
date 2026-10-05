import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, createWriteToolDefinition, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile, stat } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { FileToolError, classifyFsError, formatFileToolErrorForDisplay } from "../src/errors.js";
import { executeWithFailureLogging, loadFileToolsGlobalConfig, prepareWithFailureLogging } from "../src/debug-logging.js";
import {
  assertInputSize,
  assertRegularReadableFile,
  editTextFile,
  MAX_EDIT_OPERATIONS,
  MAX_REGEX_PATTERN_LENGTH,
  compactPatch,
  readTextBuffer,
  truncateFeedback,
  writeTextFile,
  SHA256_TOKEN_LENGTH,
  type EditResult,
  type RangeEdit,
} from "../src/file-operations.js";
import { resolveToolPath } from "../src/path-utils.js";
import { findUniqueSkillFallbackPath } from "../src/skill-paths.js";
import { hintMissingSubagentLog } from "../src/subagent-log-paths.js";

const HASH_PATTERN = `^(missing|[a-fA-F0-9]{${SHA256_TOKEN_LENGTH}}|[a-fA-F0-9]{64})$`;
const strictObject = { additionalProperties: false } as const;

// Spread metadata so older hosts without ToolAnnotations in their declarations
// still typecheck and can safely ignore these advisory (not permission) hints.
const readToolMetadata = { annotations: { readOnlyHint: true, openWorldHint: false } };
const mutationToolMetadata = {
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

const readSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "File path, relative to the current working directory or absolute." }),
    offset: Type.Optional(Type.Integer({ minimum: 1, description: "First absolute line to return (1-based)." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to return before output truncation." })),
  },
  strictObject,
);

const writeSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "File path, relative to the current working directory or absolute." }),
    content: Type.String({ description: "Complete UTF-8 file content. Empty string intentionally clears the file." }),
    expectedHash: Type.Optional(
      Type.String({
        pattern: HASH_PATTERN,
        description:
          "Optional concurrency guard: the 32-character SHA-256 version token from the latest read (legacy 64-character SHA-256 is also accepted), or 'missing' when creating a file that must not already exist. Omit only for an intentional unconditional write.",
      }),
    ),
  },
  strictObject,
);

const lineRangeSchema = Type.Object(
  {
    start: Type.Integer({ minimum: 1, description: "First line of the inclusive search window (1-based)." }),
    end: Type.Integer({ minimum: 1, description: "Last line of the inclusive search window (1-based); the match must fit inside it." }),
  },
  strictObject,
);

const editSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Existing file path, relative to the current working directory or absolute." }),
    expectedHash: Type.Optional(
      Type.String({
        pattern: `^([a-fA-F0-9]{${SHA256_TOKEN_LENGTH}}|[a-fA-F0-9]{64})$`,
        description: "Optional 32-character SHA-256 version token from the latest read (legacy 64-character SHA-256 is also accepted). The edit fails with STALE_FILE if the file changed.",
      }),
    ),
    edits: Type.Array(
      Type.Object(
        {
          oldText: Type.Optional(Type.String({ minLength: 1, description: "Exact literal text to match. Use exactly one of oldText or regex." })),
          regex: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REGEX_PATTERN_LENGTH, description: "JavaScript RegExp pattern; flags go in regexFlags. Use exactly one of oldText or regex." })),
          regexFlags: Type.Optional(
            Type.String({
              pattern: "^[imsu]*$",
              description: "RegExp flags i, m, s, u (each at most once, never g); only with regex.",
            }),
          ),
          newText: Type.String({ description: "Replacement text. Empty string deletes matches. With regex and replacementMode=template, $1 and $<name> insert captures." }),
          lineRange: Type.Optional(lineRangeSchema),
          replaceAll: Type.Optional(Type.Boolean({ default: false, description: "Replace every match in the selected scope; when false, exactly one match is required." })),
          replacementMode: Type.Optional(
            Type.Union([Type.Literal("literal"), Type.Literal("template")], {
              description: "literal by default; template enables regex replacement tokens such as $1 and $<name>.",
            }),
          ),
        },
        strictObject,
      ),
      {
        minItems: 1,
        maxItems: MAX_EDIT_OPERATIONS,
        description:
          "Atomic replacements matched against one original snapshot. Omit lineRange for whole-file search; use it only to disambiguate or limit replaceAll.",
      },
    ),
  },
  strictObject,
);

type UnknownRecord = Record<string, unknown>;

interface ArgumentErrorContext {
  path?: string;
  editIndex?: number;
  lineRange?: { start: number; end: number };
}

function requireObject(value: unknown, tool: string, context: ArgumentErrorContext = {}): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FileToolError("INVALID_ARGUMENT", `${tool} input must be an object.`, {
      ...context,
      recovery: `Call ${tool} using its declared JSON object schema.`,
    });
  }
  return value as UnknownRecord;
}

function nullOptionalsAsUndefined(input: UnknownRecord, fields: readonly string[]): UnknownRecord {
  const normalized = { ...input };
  for (const field of fields) {
    if (normalized[field] === null) delete normalized[field];
  }
  return normalized;
}

function rejectUnknown(input: UnknownRecord, allowed: readonly string[], tool: string, context: ArgumentErrorContext = {}): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new FileToolError("INVALID_ARGUMENT", `${tool} contains unsupported field(s): ${unknown.join(", ")}.`, {
      ...context,
      recovery: `Use only the fields declared by the ${tool} schema.`,
    });
  }
}

function requirePath(value: unknown, tool: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FileToolError("INVALID_ARGUMENT", `${tool}.path must be a non-empty string.`, {
      recovery: "Provide a relative or absolute file path.",
    });
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string, context: ArgumentErrorContext = {}): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new FileToolError("INVALID_ARGUMENT", `${field} must be a positive integer.`, {
      ...context,
      recovery: `Provide ${field} as a 1-based positive integer.`,
    });
  }
  return value as number;
}

function validateHash(value: unknown, field: string, allowMissing: boolean, context: ArgumentErrorContext = {}): string | undefined {
  if (value === undefined) return undefined;
  const validHash = typeof value === "string" && new RegExp(`^(?:[a-fA-F0-9]{${SHA256_TOKEN_LENGTH}}|[a-fA-F0-9]{64})$`).test(value);
  if (!validHash && !(allowMissing && value === "missing")) {
    throw new FileToolError("INVALID_ARGUMENT", `${field} must be a ${SHA256_TOKEN_LENGTH}-character SHA-256 version token${allowMissing ? " or 'missing'" : ""}.`, {
      ...context,
      recovery: "Use the sha256 version token returned by the latest read operation.",
    });
  }
  return (value as string).toLowerCase();
}

export function prepareReadArguments(value: unknown) {
  const input = nullOptionalsAsUndefined(requireObject(value, "read"), ["offset", "limit"]);
  rejectUnknown(input, ["path", "offset", "limit"], "read");
  return {
    path: requirePath(input.path, "read"),
    offset: optionalPositiveInteger(input.offset, "read.offset"),
    limit: optionalPositiveInteger(input.limit, "read.limit"),
  };
}

export function prepareWriteArguments(value: unknown) {
  const input = nullOptionalsAsUndefined(requireObject(value, "write"), ["expectedHash"]);
  const path = requirePath(input.path, "write");
  rejectUnknown(input, ["path", "content", "expectedHash"], "write", { path });
  if (typeof input.content !== "string") {
    throw new FileToolError("INVALID_ARGUMENT", "write.content must be a string.", {
      path: typeof input.path === "string" ? input.path : undefined,
      recovery: "Provide the complete file content. Use an empty string only to intentionally clear the file.",
    });
  }
  return {
    path,
    content: input.content,
    expectedHash: validateHash(input.expectedHash, "write.expectedHash", true, { path }),
  };
}

export function prepareEditArguments(value: unknown) {
  const original = requireObject(value, "edit");
  const input = nullOptionalsAsUndefined(original, ["expectedHash"]);

  if (typeof input.edits === "string") {
    try {
      input.edits = JSON.parse(input.edits);
    } catch {
      throw new FileToolError("INVALID_ARGUMENT", "edit.edits is a string but does not contain valid JSON.", {
        path: typeof input.path === "string" ? input.path : undefined,
        recovery: "Pass edits as a JSON array using the declared schema.",
      });
    }
  }
  if (typeof input.edits === "object" && input.edits !== null && !Array.isArray(input.edits)) {
    input.edits = [input.edits];
  }
  if ("oldText" in input || "regex" in input || "newText" in input || "lineRange" in input || "lineStart" in input || "lineEnd" in input) {
    throw new FileToolError("INVALID_ARGUMENT", "Top-level replacement fields are not supported by the edit contract.", {
      path: typeof input.path === "string" ? input.path : undefined,
      recovery: "Move matching, replacement, and lineRange fields into an edits array item.",
    });
  }

  const path = requirePath(input.path, "edit");
  rejectUnknown(input, ["path", "expectedHash", "edits"], "edit", { path });
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new FileToolError("INVALID_ARGUMENT", "edit.edits must contain at least one replacement.", {
      path,
      recovery: "Provide at least one edit with exactly one of oldText or regex plus newText.",
    });
  }
  if (input.edits.length > MAX_EDIT_OPERATIONS) {
    throw new FileToolError("INVALID_ARGUMENT", `edit.edits cannot contain more than ${MAX_EDIT_OPERATIONS} operations.`, {
      path,
      recovery: "Split the edit into smaller operations.",
    });
  }

  const edits: RangeEdit[] = input.edits.map((rawEdit, editIndex) => {
    const edit = nullOptionalsAsUndefined(
      requireObject(rawEdit, `edit.edits[${editIndex}]`, { path, editIndex }),
      ["oldText", "regex", "regexFlags", "lineRange", "replaceAll", "replacementMode"],
    );
    rejectUnknown(
      edit,
      ["oldText", "regex", "regexFlags", "newText", "lineRange", "replaceAll", "replacementMode"],
      `edit.edits[${editIndex}]`,
      { path, editIndex },
    );
    const hasOldText = typeof edit.oldText === "string";
    const hasRegex = typeof edit.regex === "string";
    if (hasOldText === hasRegex || (hasOldText && edit.oldText === "") || (hasRegex && edit.regex === "")) {
      throw new FileToolError("INVALID_ARGUMENT", `edit.edits[${editIndex}] requires exactly one non-empty oldText or regex.`, {
        path,
        editIndex,
        recovery: "Use oldText for exact matching or regex for pattern matching, but not both.",
      });
    }
    if (typeof edit.newText !== "string") {
      throw new FileToolError("INVALID_ARGUMENT", `edit.edits[${editIndex}].newText must be a string.`, {
        path,
        editIndex,
        recovery: "Provide replacement text; use an empty string only for deletion.",
      });
    }

    let lineRange: { start: number; end: number } | undefined;
    if (edit.lineRange !== undefined) {
      const range = requireObject(edit.lineRange, `edit.edits[${editIndex}].lineRange`, { path, editIndex });
      rejectUnknown(range, ["start", "end"], `edit.edits[${editIndex}].lineRange`, { path, editIndex });
      const start = optionalPositiveInteger(range.start, `edit.edits[${editIndex}].lineRange.start`, { path, editIndex });
      const end = optionalPositiveInteger(range.end, `edit.edits[${editIndex}].lineRange.end`, { path, editIndex });
      if (start === undefined || end === undefined || end < start) {
        throw new FileToolError("INVALID_ARGUMENT", `edit.edits[${editIndex}].lineRange must contain valid start and end values.`, {
          path,
          editIndex,
          recovery: "Use positive 1-based start/end values with end greater than or equal to start.",
        });
      }
      lineRange = { start, end };
    }

    if (edit.regexFlags !== undefined && (!hasRegex || typeof edit.regexFlags !== "string" || !/^[imsu]*$/.test(edit.regexFlags) || new Set(edit.regexFlags).size !== edit.regexFlags.length)) {
      throw new FileToolError("INVALID_REGEX", `edit.edits[${editIndex}].regexFlags is invalid.`, {
        path,
        editIndex,
        recovery: "Use each of i, m, s, and u at most once, and only with regex.",
      });
    }
    if (edit.replaceAll !== undefined && typeof edit.replaceAll !== "boolean") {
      throw new FileToolError("INVALID_ARGUMENT", `edit.edits[${editIndex}].replaceAll must be a boolean.`, { path, editIndex });
    }
    if (edit.replacementMode !== undefined && edit.replacementMode !== "literal" && edit.replacementMode !== "template") {
      throw new FileToolError("INVALID_ARGUMENT", `edit.edits[${editIndex}].replacementMode is invalid.`, { path, editIndex });
    }
    if (edit.replacementMode === "template" && !hasRegex) {
      throw new FileToolError("INVALID_ARGUMENT", `edit.edits[${editIndex}].replacementMode=template requires regex.`, {
        path,
        editIndex,
        recovery: "Use literal replacementMode for oldText edits.",
      });
    }
    if (hasRegex) {
      if ((edit.regex as string).length > MAX_REGEX_PATTERN_LENGTH) {
        throw new FileToolError("INVALID_REGEX", `edit.edits[${editIndex}].regex exceeds the pattern length limit.`, {
          path,
          editIndex,
          recovery: `Use a regex no longer than ${MAX_REGEX_PATTERN_LENGTH} UTF-16 code units.`,
        });
      }
      try {
        new RegExp(edit.regex as string, (edit.regexFlags as string | undefined) ?? "");
      } catch (error) {
        throw new FileToolError("INVALID_REGEX", `edit.edits[${editIndex}].regex is invalid: ${error instanceof Error ? error.message : String(error)}`, {
          path,
          editIndex,
          recovery: "Correct the ECMAScript regular expression and retry.",
        });
      }
    }

    return {
      ...(hasOldText ? { oldText: edit.oldText as string } : { regex: edit.regex as string }),
      ...(edit.regexFlags !== undefined ? { regexFlags: edit.regexFlags as string } : {}),
      newText: edit.newText,
      ...(lineRange ? { lineRange } : {}),
      replaceAll: edit.replaceAll === true,
      replacementMode: edit.replacementMode === "template" ? "template" : "literal",
    };
  });

  return {
    path,
    expectedHash: validateHash(input.expectedHash, "edit.expectedHash", false, { path }),
    edits,
  };
}

export function formatEditSuccessFeedback(result: EditResult): { content: string; truncated: boolean } {
  // Model-visible text is compact; the full diff, patch and changedRanges live in details.
  const compact = compactPatch(result.patch);
  const metadata = {
    sha256After: result.sha256After,
    edits: result.appliedEdits,
    ...(result.changedCount !== result.appliedEdits ? { replacements: result.changedCount } : {}),
    ...(compact.added > 0 ? { added: compact.added } : {}),
    ...(compact.removed > 0 ? { removed: compact.removed } : {}),
  };
  return truncateFeedback(`[FILE_EDIT_SUCCESS] ${JSON.stringify(metadata)}\n[DIFF]\n${compact.text}`);
}

export function formatEditCallPreview(value: unknown): { path: string; ranges: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { path: "...", ranges: "..." };
  }

  const input = value as UnknownRecord;
  const path = typeof input.path === "string" && input.path.length > 0 ? input.path : "...";
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return { path, ranges: "..." };
  }

  const ranges = input.edits.map((rawEdit) => {
    if (typeof rawEdit !== "object" || rawEdit === null || Array.isArray(rawEdit)) return "...";
    const edit = rawEdit as UnknownRecord;
    const mode = typeof edit.oldText === "string" ? "text" : typeof edit.regex === "string" ? "regex" : undefined;
    if (!mode) return "...";
    let scope = "file";
    if (edit.lineRange !== undefined) {
      if (typeof edit.lineRange !== "object" || edit.lineRange === null || Array.isArray(edit.lineRange)) return "...";
      const range = edit.lineRange as UnknownRecord;
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || (range.start as number) < 1 || (range.end as number) < (range.start as number)) {
        return "...";
      }
      scope = `${range.start}-${range.end}`;
    }
    const flags = mode === "regex" && typeof edit.regexFlags === "string" && edit.regexFlags.length > 0 ? `/${edit.regexFlags}` : "";
    return `${mode}:${scope}${flags}${edit.replaceAll === true ? "/all" : ""}`;
  });

  return { path, ranges: ranges.join(", ") };
}

function hasBmpHeader(buffer: Buffer): boolean {
  // Match Pi's structural BMP sniffing without reopening the path. Classification
  // and image delegation must use the same snapshot readBufferAtPath acquired.
  if (buffer.length < 26) return false;
  const declaredSize = buffer.readUInt32LE(2);
  const pixelOffset = buffer.readUInt32LE(10);
  const dibSize = buffer.readUInt32LE(14);
  if (declaredSize !== 0 && declaredSize < 26) return false;
  if (pixelOffset < 14 + dibSize) return false;
  if (declaredSize !== 0 && pixelOffset >= declaredSize) return false;
  if (dibSize === 12) {
    return buffer.readUInt16LE(22) === 1 && [1, 4, 8, 16, 24, 32].includes(buffer.readUInt16LE(24));
  }
  if (dibSize < 40 || dibSize > 124 || buffer.length < 30) return false;
  return buffer.readUInt16LE(26) === 1 && [1, 4, 8, 16, 24, 32].includes(buffer.readUInt16LE(28));
}

export function detectImageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d && hasBmpHeader(buffer)) return "image/bmp";
  return undefined;
}

async function readBufferAtPath(absolutePath: string, displayPath: string, signal?: AbortSignal): Promise<Buffer> {
  return withFileMutationQueue(absolutePath, async () => {
    try {
      const fileStat = await stat(absolutePath);
      assertRegularReadableFile(fileStat, displayPath);
      assertInputSize(fileStat.size, displayPath);
      const buffer = await readFile(absolutePath, { signal });
      assertInputSize(buffer.length, displayPath);
      return buffer;
    } catch (error) {
      throw classifyFsError(error, displayPath, "read");
    }
  });
}

export default function fileToolsExtension(pi: ExtensionAPI) {
  const debugLog = loadFileToolsGlobalConfig().debugLog ?? false;
  // Explicitly retain the host's call/ successful read presentation (including images).
  const builtinRead = createReadToolDefinition(process.cwd());
  const builtinWrite = createWriteToolDefinition(process.cwd());
  let loadedSkillPaths: string[] = [];
  pi.on("before_agent_start", (event) => {
    loadedSkillPaths = event.systemPromptOptions.skills.map((skill) => skill.filePath);
  });
  pi.registerTool({
    name: "read",
    ...readToolMetadata,
    label: "read (precise)",
    description:
      "Read a text file with absolute line-number metadata and a compact 32-character SHA-256 version token. Text output is limited to 2000 lines or 50KB. Images retain Pi's built-in attachment behavior.",
    promptSnippet: "Read file contents with absolute line numbers and a compact SHA-256 version token",
    promptGuidelines: [
      "Use read before edit to obtain the latest 32-character SHA-256 version token as expectedHash and the exact text. Omit lineRange when oldText is unique; use lineRange only to disambiguate or limit the search scope.",
      "When copying oldText from read output, omit the '<line>│' display prefix because it is metadata, not file content.",
      "To search file contents use shell rg, then read the relevant range with offset/limit.",
      "If read reports READ_CONTINUATION, continue with the supplied nextOffset before assuming the file was fully inspected.",
      "A missing live subagent transcript may include a same-directory final-path recovery hint. Retry that path explicitly; missing logs do not prove job completion.",
    ],
    parameters: readSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    prepareArguments: prepareWithFailureLogging(debugLog, "read", prepareReadArguments),
    renderCall: builtinRead.renderCall,
    renderResult(result, options, theme, context) {
      // The host renderer only consumes common content and optional truncation fields.
      const builtinResult = result as Parameters<NonNullable<typeof builtinRead.renderResult>>[0];
      if (!context.isError) return builtinRead.renderResult?.(builtinResult, options, theme, context) ?? new Text("", 0, 0);
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      return new Text(theme.fg("error", formatFileToolErrorForDisplay(text, options.expanded, "read")), 0, 0);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeWithFailureLogging(debugLog, "read", toolCallId, params, async () => {
        const absolutePath = resolveToolPath(params.path, ctx.cwd);
        let buffer: Buffer;
        let actualPath = absolutePath;
        let autoCorrected = false;
        try {
          buffer = await readBufferAtPath(absolutePath, params.path, signal);
        } catch (error) {
          const originalError = classifyFsError(error, params.path, "read");
          if (originalError.payload.code !== "FILE_NOT_FOUND") throw originalError;

          const fallbackPath = findUniqueSkillFallbackPath(absolutePath, loadedSkillPaths);
          if (!fallbackPath) throw await hintMissingSubagentLog(originalError, absolutePath);
          try {
            buffer = await readBufferAtPath(fallbackPath, fallbackPath, signal);
          } catch (fallbackError) {
            const classified = classifyFsError(fallbackError, fallbackPath, "read");
            throw new FileToolError(classified.payload.code, `The uniquely matched skill file could not be read after path correction. ${classified.payload.message}`, {
              path: fallbackPath,
              causeCode: classified.payload.causeCode,
              recovery: `Original requested path: ${params.path}. ${classified.payload.recovery ?? "Check the matched skill file and retry."}`,
            });
          }
          actualPath = fallbackPath;
          autoCorrected = true;
        }
        if (signal?.aborted) {
          throw new FileToolError("OPERATION_ABORTED", "The read operation was aborted.");
        }
        const imageMime = detectImageMime(buffer);
        if (imageMime) {
          const imageRead = createReadToolDefinition(ctx.cwd, {
            operations: {
              access: async () => undefined,
              readFile: async () => buffer,
              detectImageMimeType: async () => imageMime,
            },
          });
          return imageRead.execute(toolCallId, params, signal, onUpdate, ctx);
        }
        const result = readTextBuffer(buffer, autoCorrected ? actualPath : params.path, params.offset, params.limit);
        const correctionNotice = autoCorrected
          ? `[SKILL_PATH_AUTO_CORRECTED] ${JSON.stringify({ requestedPath: params.path, actualPath })}`
          : undefined;
        const headerEnd = result.text.indexOf("\n");
        const text = correctionNotice && headerEnd !== -1
          ? `${result.text.slice(0, headerEnd + 1)}${correctionNotice}\n${result.text.slice(headerEnd + 1)}`
          : result.text;
        return {
          content: [{ type: "text", text }],
          details: {
            ...result.details,
            ...(autoCorrected ? { pathAutoCorrected: true, requestedPath: params.path } : {}),
          },
        };
      });
    },
  });

  pi.registerTool({
    name: "write",
    ...mutationToolMetadata,
    label: "write (guarded)",
    description:
      "Create or completely overwrite a UTF-8 file. Supports a compact SHA-256 version token as an expectedHash concurrency guard and atomic replacement. Parent directories are created automatically.",
    promptSnippet: "Create or fully overwrite files with optional compact SHA-256 concurrency protection",
    promptGuidelines: [
      "Use write only for new files or intentional complete rewrites.",
      "When overwriting a file that was read, pass the 32-character SHA-256 version token from the latest read as write.expectedHash; use expectedHash='missing' when creating a path that must not already exist.",
    ],
    parameters: writeSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    prepareArguments: prepareWithFailureLogging(debugLog, "write", prepareWriteArguments),
    renderCall: builtinWrite.renderCall,
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      if (context.isError) return new Text(theme.fg("error", formatFileToolErrorForDisplay(text, expanded, "write")), 0, 0);
      if (isPartial) return new Text(theme.fg("muted", "Writing file…"), 0, 0);
      let summary = "File written", detail = "";
      // Prefer structured details; fall back to text parsing for hosts that drop
      // them (accepts both the compact single-line and the legacy multi-line payload).
      let payload = result.details as { bytes?: unknown; path?: unknown; sha256?: unknown } | undefined;
      if (!payload || typeof payload !== "object") {
        payload = undefined;
        try {
          const marker = text.indexOf("[FILE_WRITE_SUCCESS]");
          if (marker !== -1) payload = JSON.parse(text.slice(marker + "[FILE_WRITE_SUCCESS]".length).trim());
        } catch { /* missing success metadata still gets a compact result */ }
      }
      if (payload) {
        if (typeof payload.bytes === "number") summary += ` · ${payload.bytes} bytes`;
        if (typeof payload.path === "string") detail += `\nPath: ${payload.path}`;
        if (typeof payload.sha256 === "string") detail += `\nSHA-256: ${payload.sha256}`;
      }
      const clean = stripVTControlCharacters(summary + (expanded ? detail : "")).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
      return new Text(theme.fg("success", clean), 0, 0);
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return executeWithFailureLogging(debugLog, "write", toolCallId, params, async () => {
        const absolutePath = resolveToolPath(params.path, ctx.cwd);
        return withFileMutationQueue(absolutePath, async () => {
          const result = await writeTextFile(absolutePath, params.path, params.content, params.expectedHash, signal);
          return {
            content: [
              {
                type: "text",
                text: `[FILE_WRITE_SUCCESS] ${JSON.stringify({ sha256: result.sha256, bytes: result.bytes, ...(result.created ? { created: true } : {}) })}`,
              },
            ],
            details: { path: result.path, sha256: result.sha256, bytes: result.bytes, created: result.created },
          };
        });
      });
    },
  });

  pi.registerTool({
    name: "edit",
    ...mutationToolMetadata,
    label: "edit (precise)",
    description:
      "Edit one UTF-8 file with exact-text or regex replacements, validated against one snapshot and committed atomically with a model-visible diff.",
    promptSnippet: "Edit exact text or regex matches with optional line ranges and replace-all behavior",
    promptGuidelines: [
      "Prefer oldText without lineRange when the exact text is unique in the whole file; this remains stable when earlier lines move.",
      "Use lineRange as a 1-based inclusive initial search window, not a line replacement boundary. If oldText is not found there, a unique whole-file literal match is applied automatically; repeated whole-file matches remain an error. Regex edits do not use this fallback, and a regex lineRange window is matched as a standalone string (^, $, lookbehind and lookahead cannot see outside it).",
      "After AMBIGUOUS_MATCH or a ranged miss, use returned candidateRanges to choose a narrower lineRange or include more exact surrounding text.",
      "Use replaceAll=true only when every match in the selected scope should change. Otherwise the selected scope must contain exactly one match.",
      "Use JavaScript ECMAScript RegExp syntax for regex patterns, not Python/PCRE syntax. Pass flags separately via regexFlags: for multiline ^/$ use regexFlags='m' rather than a bare inline flag such as (?m). Only i, m, s, u are accepted, each at most once; never pass g. Use replaceAll=true when every match in the selected scope should change.",
      "Use replacementMode=template only with regex when capture substitution such as $1 is required; use literal for ordinary replacement text.",
      "Pass the 32-character SHA-256 version token from the latest read as edit.expectedHash whenever available so stale edits fail safely. You may reuse the sha256After returned by the previous edit as the next expectedHash.",
      "Each edits item needs exactly one non-empty oldText or regex plus newText. Whole-file matching is the default; omit lineRange unless disambiguating.",
      "All edits in one edit call refer to the original pre-edit snapshot and must target non-overlapping text.",
    ],
    parameters: editSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    prepareArguments: prepareWithFailureLogging(debugLog, "edit", prepareEditArguments),
    renderCall(args, theme, context) {
      const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const preview = formatEditCallPreview(args);
      component.setText(
        `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", preview.path)} ${theme.fg("dim", `[${preview.ranges}]`)}`,
      );
      return component;
    },
    renderResult(result, _options, theme, context) {
      const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (context.isError) {
        component.setText(theme.fg("error", formatFileToolErrorForDisplay(text, context.expanded)));
      } else {
        const details = result.details as { appliedEdits?: number; diff?: string } | undefined;
        const replacements = (details as { changedCount?: number } | undefined)?.changedCount;
        const summary = details?.appliedEdits
          ? `Applied ${details.appliedEdits} edit(s)${replacements === undefined ? "" : `, ${replacements} replacement(s)`}`
          : "Edit applied";
        component.setText(theme.fg("success", summary) + (context.expanded && details?.diff ? `\n${details.diff}` : ""));
      }
      return component;
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return executeWithFailureLogging(debugLog, "edit", toolCallId, params, async () => {
        const absolutePath = resolveToolPath(params.path, ctx.cwd);
        return withFileMutationQueue(absolutePath, async () => {
          const result = await editTextFile(absolutePath, params.path, params.edits, params.expectedHash, signal);
          const feedback = formatEditSuccessFeedback(result);
          const { added, removed } = compactPatch(result.patch);
          return {
            content: [{ type: "text", text: feedback.content }],
            details: {
              diff: result.diff,
              patch: result.patch,
              firstChangedLine: result.firstChangedLine,
              appliedEdits: result.appliedEdits,
              matchedCount: result.matchedCount,
              changedCount: result.changedCount,
              sha256Before: result.sha256Before,
              sha256After: result.sha256After,
              changedRanges: result.changedRanges,
              added,
              removed,
              feedbackTruncated: feedback.truncated,
            },
          };
        });
      });
    },
  });
}
