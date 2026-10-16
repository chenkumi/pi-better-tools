import type { Engine } from "../types.js";
import { SqlConnectorError } from "../types.js";

/**
 * Removes content that must not affect statement classification while retaining
 * whitespace and punctuation boundaries. This is intentionally fail-closed,
 * not a full SQL parser.
 */
function codeOnly(sql: string): string {
  let result = "";
  let index = 0;
  let state: "code" | "single" | "double" | "bracket" | "line-comment" | "block-comment" = "code";

  while (index < sql.length) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (state === "code") {
      if (char === "'") {
        state = "single";
        result += " ";
      } else if (char === '"') {
        state = "double";
        result += " ";
      } else if (char === "[") {
        state = "bracket";
        result += " ";
      } else if (char === "-" && next === "-") {
        state = "line-comment";
        result += "  ";
        index += 1;
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        result += "  ";
        index += 1;
      } else {
        result += char;
      }
    } else if (state === "single") {
      if (char === "'" && next === "'") {
        result += "  ";
        index += 1;
      } else if (char === "'") {
        state = "code";
        result += " ";
      } else {
        result += char === "\n" ? "\n" : " ";
      }
    } else if (state === "double") {
      if (char === '"' && next === '"') {
        result += "  ";
        index += 1;
      } else if (char === '"') {
        state = "code";
        result += " ";
      } else {
        result += char === "\n" ? "\n" : " ";
      }
    } else if (state === "bracket") {
      if (char === "]") state = "code";
      result += char === "\n" ? "\n" : " ";
    } else if (state === "line-comment") {
      if (char === "\n") {
        state = "code";
        result += "\n";
      } else {
        result += " ";
      }
    } else if (char === "*" && next === "/") {
      state = "code";
      result += "  ";
      index += 1;
    } else {
      result += char === "\n" ? "\n" : " ";
    }
    index += 1;
  }

  if (state === "single" || state === "double" || state === "block-comment") {
    throw new SqlConnectorError("POLICY_DENIED", "SQL contains an unterminated string or comment.");
  }
  return result;
}

function validateSingleStatement(sql: string, engine: Engine): string {
  if (engine === "mysql" && /\/\*[!+]/.test(sql)) {
    throw new SqlConnectorError("POLICY_DENIED", "MySQL executable and optimizer-hint comments are not allowed.");
  }

  const code = codeOnly(sql).trim().toLowerCase();
  if (!code) throw new SqlConnectorError("POLICY_DENIED", "SQL must not be empty.");

  const firstSemicolon = code.indexOf(";");
  if (firstSemicolon >= 0 && code.slice(firstSemicolon + 1).trim() !== "") {
    throw new SqlConnectorError("POLICY_DENIED", "Only one SQL statement is allowed.");
  }
  if (/^\s*go\s*$/m.test(code)) {
    throw new SqlConnectorError("POLICY_DENIED", "SQL Server batch separators are not allowed.");
  }
  return code.replace(/;\s*$/, "").trim();
}

function topLevelCode(code: string): string {
  let depth = 0;
  let result = "";
  for (const char of code) {
    if (char === "(") {
      depth += 1;
      result += " ";
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
      result += " ";
    } else {
      result += depth === 0 ? char : " ";
    }
  }
  return result;
}

function hasForbiddenReadConstruct(code: string): boolean {
  return (
    /\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|execute|exec|call)\b/.test(code) ||
    /\bselect\b[\s\S]*\binto\b/.test(code) ||
    /\bfor\s+(update|share)\b|\block\s+in\s+share\s+mode\b/.test(code)
  );
}

function assertReadLimit(engine: Engine, code: string): void {
  if (/^(show|describe|desc|explain)\b/.test(code)) return;
  const topLevel = topLevelCode(code);

  if (engine === "mssql") {
    const top = /\bselect\s+(?:distinct\s+)?top\s+(\d+)\b/.exec(topLevel);
    const amount = Number(top?.[1]);
    if (!top || !Number.isInteger(amount) || amount < 1 || amount > 200) {
      throw new SqlConnectorError("POLICY_DENIED", "MSSQL reads must use TOP n with n from 1 to 200.");
    }
    return;
  }

  const limit = /\blimit\s+(\d+)\b/.exec(topLevel);
  const amount = Number(limit?.[1]);
  if (!limit || !Number.isInteger(amount) || amount < 1 || amount > 200) {
    throw new SqlConnectorError("POLICY_DENIED", `${engine} reads must use LIMIT n with n from 1 to 200.`);
  }
}

export function assertReadOnlySql(engine: Engine, sql: string): void {
  const code = validateSingleStatement(sql, engine);
  const isReadStatement = /^(select|show|describe|desc|explain)\b/.test(code) || /^with\b/.test(code);
  if (!isReadStatement || hasForbiddenReadConstruct(code)) {
    throw new SqlConnectorError("POLICY_DENIED", "Only a single read-only SQL statement is allowed.");
  }
  assertReadLimit(engine, code);
}

export function assertUpdateSql(engine: Engine, sql: string): void {
  const code = validateSingleStatement(sql, engine);
  const kind = /^(insert|update|delete)\b/.exec(code)?.[1];
  if (!kind) {
    throw new SqlConnectorError("POLICY_DENIED", "Only INSERT, UPDATE, or DELETE statements are allowed.");
  }
  if ((kind === "update" || kind === "delete") && !/\bwhere\b/.test(topLevelCode(code))) {
    throw new SqlConnectorError("POLICY_DENIED", "UPDATE and DELETE statements must include a top-level WHERE clause.");
  }
}
