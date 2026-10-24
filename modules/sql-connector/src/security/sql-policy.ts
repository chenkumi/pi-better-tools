import type { Engine } from "../types.js";
import { SqlConnectorError } from "../types.js";

function denied(message: string): never {
  throw new SqlConnectorError("POLICY_DENIED", message);
}

/** Largest row count a read may request through LIMIT/TOP (per statement; set operations add up for MSSQL). */
const MAX_READ_ROWS = 200;

const BACKSLASH_DENIED = "Backslashes inside string literals are not allowed because their meaning depends on server settings; pass the value as a bound parameter.";

/** PostgreSQL identifiers may contain `$` after the first character, so `a$b$` is not a dollar quote. */
function identifierChar(char: string): boolean {
  return /[A-Za-z0-9_$\u0080-￿]/.test(char);
}

/** Opening `$tag$` of a PostgreSQL dollar-quoted string at `index`, or undefined. `$1` is a parameter. */
function dollarTag(sql: string, index: number): string | undefined {
  if (index > 0 && identifierChar(sql[index - 1] ?? "")) return undefined;
  return /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(index, index + 130))?.[0];
}

/**
 * Removes content that must not affect statement classification while retaining
 * whitespace and punctuation boundaries. The lexical rules follow each engine's
 * quoting and comment syntax, and anything whose meaning depends on server
 * settings is denied. This is intentionally fail-closed, not a full SQL parser.
 */
function codeOnly(sql: string, engine: Engine): string {
  // MySQL comments do not nest; PostgreSQL and SQL Server block comments do.
  const nestedComments = engine !== "mysql";
  let result = "";
  let index = 0;
  let state: "code" | "single" | "double" | "backtick" | "bracket" | "dollar" | "line-comment" | "block-comment" = "code";
  let commentDepth = 0;
  let tag = "";
  const hide = (text: string) => text.replace(/[^\n]/g, " ");

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
      } else if (char === "`" && engine === "mysql") {
        state = "backtick";
        result += " ";
      } else if (char === "[" && engine === "mssql") {
        state = "bracket";
        result += " ";
      } else if (char === "$" && engine === "pgsql" && dollarTag(sql, index)) {
        tag = dollarTag(sql, index)!;
        state = "dollar";
        result += hide(tag);
        index += tag.length - 1;
      } else if (char === "-" && next === "-" && (engine !== "mysql" || index + 2 >= sql.length || /[\s\x00-\x1f]/.test(sql[index + 2]!))) {
        // MySQL treats "--" as a comment only when followed by whitespace or a control character.
        state = "line-comment";
        result += "  ";
        index += 1;
      } else if (char === "#" && engine === "mysql") {
        state = "line-comment";
        result += " ";
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        commentDepth = 1;
        result += "  ";
        index += 1;
      } else {
        result += char;
      }
    } else if (state === "single" || state === "double") {
      const quote = state === "single" ? "'" : '"';
      // PostgreSQL double quotes delimit identifiers, where a backslash has no special meaning.
      const literal = state === "single" || engine === "mysql";
      if (char === "\\" && literal && engine !== "mssql") denied(BACKSLASH_DENIED);
      if (char === quote && next === quote) {
        result += "  ";
        index += 1;
      } else if (char === quote) {
        state = "code";
        result += " ";
      } else {
        result += char === "\n" ? "\n" : " ";
      }
    } else if (state === "backtick") {
      if (char === "`" && next === "`") {
        result += "  ";
        index += 1;
      } else {
        if (char === "`") state = "code";
        result += char === "\n" ? "\n" : " ";
      }
    } else if (state === "bracket") {
      if (char === "]" && next === "]") {
        result += "  ";
        index += 1;
      } else {
        if (char === "]") state = "code";
        result += char === "\n" ? "\n" : " ";
      }
    } else if (state === "dollar") {
      if (sql.startsWith(tag, index)) {
        state = "code";
        result += hide(tag);
        index += tag.length - 1;
      } else {
        result += char === "\n" ? "\n" : " ";
      }
    } else if (state === "line-comment") {
      if (char === "\n") {
        state = "code";
        result += "\n";
      } else {
        result += " ";
      }
    } else if (char === "/" && next === "*" && nestedComments) {
      commentDepth += 1;
      result += "  ";
      index += 1;
    } else if (char === "*" && next === "/") {
      commentDepth -= 1;
      if (commentDepth === 0) state = "code";
      result += "  ";
      index += 1;
    } else {
      result += char === "\n" ? "\n" : " ";
    }
    index += 1;
  }

  if (state !== "code" && state !== "line-comment") {
    denied("SQL contains an unterminated string, quoted identifier or comment.");
  }
  return result;
}

function validateSingleStatement(sql: string, engine: Engine): string {
  if (engine === "mysql" && /\/\*[!+]/.test(sql)) {
    denied("MySQL executable and optimizer-hint comments are not allowed.");
  }
  if (sql.includes("\0")) denied("SQL must not contain NUL characters.");

  const code = codeOnly(sql, engine).trim().toLowerCase();
  if (!code) denied("SQL must not be empty.");

  const firstSemicolon = code.indexOf(";");
  if (firstSemicolon >= 0 && code.slice(firstSemicolon + 1).trim() !== "") {
    denied("Only one SQL statement is allowed.");
  }
  if (/^\s*go\s*$/m.test(code)) {
    denied("SQL Server batch separators are not allowed.");
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

/**
 * A SQL Server batch needs no separator between statements, so a single-statement
 * check cannot see a second one. Deny every keyword that can start a non-read
 * statement or pass SQL through to another server. Quote an identifier that
 * collides with one of these words as [name].
 */
const MSSQL_STATEMENT_WORDS = ["backup", "begin", "break", "bulk", "checkpoint", "commit", "continue", "dbcc", "deallocate", "declare", "deny", "disable", "enable", "goto", "if", "kill", "move", "opendatasource", "openquery", "openrowset", "print", "raiserror", "readtext", "receive", "reconfigure", "restore", "return", "revert", "rollback", "save", "send", "set", "setuser", "shutdown", "throw", "updatetext", "use", "waitfor", "while", "writetext"];
const words = (list: readonly string[]) => new RegExp(`\\b(${list.join("|")})\\b`);
const MSSQL_STATEMENT_KEYWORDS = words(MSSQL_STATEMENT_WORDS);
// SET is part of UPDATE itself; every other statement keyword would append a second statement to the batch.
const MSSQL_UPDATE_FORBIDDEN = words(["merge", "truncate", "create", "alter", "drop", "grant", "revoke", "execute", "exec", "call", ...MSSQL_STATEMENT_WORDS.filter(word => word !== "set")]);

/**
 * SQL Server needs no separator between statements, so `SELECT ... SELECT ...` is two statements. Outside parentheses a
 * query has one SELECT plus one per set operator; an UPDATE or DELETE has none; an INSERT ... VALUES has none and an
 * INSERT ... SELECT follows the query rule. Subqueries, CTE bodies and EXISTS sit inside parentheses and are not counted.
 */
function hasStackedMssqlSelect(code: string, kind?: string): boolean {
  const top = topLevelCode(code);
  const selects = top.match(/\bselect\b/g)?.length ?? 0;
  const allowedByOperators = 1 + (top.match(/\b(?:union|intersect|except)\b/g)?.length ?? 0);
  if (kind === "update" || kind === "delete") return selects > 0;
  if (kind === "insert" && /\bvalues\b/.test(top)) return selects > 0;
  return selects > allowedByOperators;
}

function hasForbiddenReadConstruct(engine: Engine, code: string): boolean {
  return (
    /\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|execute|exec|call)\b/.test(code) ||
    /\bselect\b[\s\S]*\binto\b/.test(code) ||
    /\bfor\s+(update|share)\b|\block\s+in\s+share\s+mode\b/.test(code) ||
    (engine === "mssql" && (MSSQL_STATEMENT_KEYWORDS.test(code) || hasStackedMssqlSelect(code)))
  );
}

function assertReadLimit(engine: Engine, code: string): void {
  if (/^(show|describe|desc|explain)\b/.test(code)) return;
  const topLevel = topLevelCode(code);

  if (engine === "mssql") {
    // PERCENT and WITH TIES do not cap the row count; the driver would buffer the whole recordset first.
    if (/\btop\s*\(?\s*\d+(?:\.\d+)?\s*\)?\s*percent\b/.test(code) || /\bwith\s+ties\b/.test(code)) {
      denied("MSSQL reads must use TOP n with n from 1 to 200 (TOP PERCENT and WITH TIES are not allowed).");
    }
    // A set operation returns rows from every branch, so each branch needs its own TOP and the total stays within 200.
    let total = 0;
    for (const branch of topLevel.split(/\b(?:union|intersect|except)\b/)) {
      const top = /\bselect\s+(?:distinct\s+)?top\s+(\d+)\b/.exec(branch);
      const amount = Number(top?.[1]);
      if (!top || !Number.isInteger(amount) || amount < 1 || amount > MAX_READ_ROWS) {
        denied("MSSQL reads must use TOP n with n from 1 to 200 in every SELECT of a UNION/INTERSECT/EXCEPT.");
      }
      total += amount;
    }
    if (total > MAX_READ_ROWS) denied("MSSQL reads must return at most 200 rows; the TOP values of a set operation add up.");
    return;
  }

  const limit = /\blimit\s+(\d+)\b/.exec(topLevel);
  const amount = Number(limit?.[1]);
  if (!limit || !Number.isInteger(amount) || amount < 1 || amount > MAX_READ_ROWS) {
    denied(`${engine} reads must use LIMIT n with n from 1 to 200.`);
  }
}

export function assertReadOnlySql(engine: Engine, sql: string): void {
  const code = validateSingleStatement(sql, engine);
  const isReadStatement = /^(select|show|describe|desc|explain)\b/.test(code) || /^with\b/.test(code);
  if (!isReadStatement) denied("Only a single read-only SQL statement is allowed.");
  if (hasForbiddenReadConstruct(engine, code)) {
    denied(engine === "mssql"
      ? "Only a single read-only SQL statement is allowed. Quote identifiers that are SQL keywords as [name]."
      : "Only a single read-only SQL statement is allowed.");
  }
  assertReadLimit(engine, code);
}

/**
 * The leading INSERT/UPDATE/DELETE is the only one allowed to appear, and only an INSERT may use INTO;
 * a second DML word or a `SELECT ... INTO` would be a second statement in the same batch.
 */
function hasAppendedMssqlStatement(code: string, kind: string): boolean {
  const dml = code.match(/\b(insert|update|delete)\b/g)?.length ?? 0;
  const into = code.match(/\binto\b/g)?.length ?? 0;
  return dml > 1 || into > (kind === "insert" ? 1 : 0);
}

export function assertUpdateSql(engine: Engine, sql: string): void {
  const code = validateSingleStatement(sql, engine);
  const kind = /^(insert|update|delete)\b/.exec(code)?.[1];
  if (!kind) {
    denied("Only INSERT, UPDATE, or DELETE statements are allowed.");
  }
  if ((kind === "update" || kind === "delete") && !/\bwhere\b/.test(topLevelCode(code))) {
    denied("UPDATE and DELETE statements must include a top-level WHERE clause.");
  }
  if (engine === "mssql" && (MSSQL_UPDATE_FORBIDDEN.test(code) || hasAppendedMssqlStatement(code, kind) || hasStackedMssqlSelect(code, kind))) {
    denied("Only one INSERT, UPDATE, or DELETE statement is allowed. Quote identifiers that are SQL keywords as [name].");
  }
}
