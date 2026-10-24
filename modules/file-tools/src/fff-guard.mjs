// Agent-facing guards around the third-party @ff-labs/pi-fff tools (grep/find/multi_grep).
// Upstream is not modified: fff-override.mjs hands pi-fff a registerTool view that passes every
// definition through guardFffTool(), which only wraps `execute`.
//   1. Cursor ledger: cursors FFF issued (parsed from its own result text) are remembered; a cursor
//      the ledger never saw is rejected instead of FFF's silent restart from page 1.
//   2. Known upstream errors are rewritten with cause and fix.
// Plain .mjs on purpose (see fff-override.mjs): no type imports from the third-party TS sources.

const LEDGER_LIMIT = 1000; // upstream keeps 200 per cache; a larger ledger can only under-reject, never false-reject.
const CURSOR_PATTERN = /cursor="([^"]+)"/g;

// grep and multi_grep share one upstream cursor cache; find has its own.
export function cursorFamily(toolName) {
  if (/grep$/i.test(toolName)) return "grep";
  if (/find$/i.test(toolName)) return "find";
  return undefined;
}

export function createCursorLedger() {
  const families = new Map();
  const setFor = (family) => {
    let set = families.get(family);
    if (!set) families.set(family, (set = new Set()));
    return set;
  };
  return {
    record(family, id) {
      const set = setFor(family);
      set.add(id);
      if (set.size > LEDGER_LIMIT) set.delete(set.values().next().value);
    },
    has: (family, id) => setFor(family).has(id),
  };
}

// Same lifetime as upstream's module-level cursor caches (both live in this process's module graph).
const defaultLedger = createCursorLedger();

function resultText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");
}

export function unknownCursorMessage(toolName, cursor) {
  return (
    `${toolName}: parameter "cursor" ${JSON.stringify(cursor)} is unknown or expired ` +
    `(cursors are only valid for the session that issued them, are limited in number, and cannot be invented). ` +
    `Omit cursor to restart the search from page 1, or copy the cursor value exactly from the last result's "[... cursor=...]" notice.`
  );
}

export function rewriteFffError(toolName, message) {
  if (/FFF picker factory is not initialized/.test(message) || /FFF auxiliary finder pool is not initialized/.test(message)) {
    return (
      `${toolName}: the FFF search index is not available (${message}). ` +
      `Cause: the index has not finished starting, failed to start, or was shut down by a reload. ` +
      `Fix: wait a few seconds and retry once; if it fails again, use read/ls (or shell rg) instead and ` +
      `ask the user to check that the FFF search integration runs in override mode (/fff-mode) and that /fff-health reports an initialized picker.`
    );
  }
  const pathMatch = /^Path constraint must be relative to the workspace: (.*)$/s.exec(message);
  if (pathMatch) {
    return (
      `${toolName}: parameter "path" must be relative to the workspace (got ${JSON.stringify(pathMatch[1].trim())}). ` +
      `Fix: pass a workspace-relative file or directory such as "src" or "src/index.ts"; for locations outside the workspace use read/ls instead.`
    );
  }
  if (/^patterns array must have at least 1 element/.test(message)) {
    return `${toolName}: parameter "patterns" must be a non-empty array of literal strings, e.g. patterns: ["fooBar", "foo_bar"].`;
  }
  return undefined;
}

export function guardFffTool(tool, ledger = defaultLedger) {
  const family = cursorFamily(String(tool?.name ?? ""));
  if (!family || typeof tool.execute !== "function") return tool;
  const execute = tool.execute;
  return {
    ...tool,
    async execute(toolCallId, params, ...rest) {
      const cursor = params?.cursor;
      if (typeof cursor === "string" && cursor !== "" && !ledger.has(family, cursor)) {
        throw new Error(unknownCursorMessage(tool.name, cursor));
      }
      let result;
      try {
        result = await execute.call(this, toolCallId, params, ...rest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const rewritten = rewriteFffError(tool.name, message);
        if (!rewritten) throw error;
        const next = new Error(rewritten, { cause: error });
        throw next;
      }
      for (const match of resultText(result).matchAll(CURSOR_PATTERN)) ledger.record(family, match[1]);
      return result;
    },
  };
}
