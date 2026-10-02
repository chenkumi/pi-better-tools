import { appendFile, mkdir } from "node:fs/promises";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileToolError } from "./errors.js";

export const FILE_TOOLS_PROJECT_NAME = "pi-file-tools";

export interface FileToolsGlobalConfig {
  debugLog?: boolean;
}

export function getFileToolsConfigPath(agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")): string {
  return join(agentDir, "settings.json");
}

export function loadFileToolsGlobalConfig(agentDir?: string): FileToolsGlobalConfig {
  const configPath = getFileToolsConfigPath(agentDir);
  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { debugLog: false };
    throw error;
  }

  let parsed: unknown;
  try {
    // Match Pi's settings loader, which tolerates a UTF-8 BOM (common from Windows editors/PowerShell).
    parsed = JSON.parse(source.startsWith("﻿") ? source.slice(1) : source);
  } catch (error) {
    throw new Error(`Invalid JSON in Pi global settings at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Pi global settings at ${configPath} must contain a JSON object.`);
  }
  const projectConfig = (parsed as Record<string, unknown>)[FILE_TOOLS_PROJECT_NAME];
  if (projectConfig === undefined) return { debugLog: false };
  if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) {
    throw new Error(`Pi global settings property "${FILE_TOOLS_PROJECT_NAME}" at ${configPath} must be an object.`);
  }
  const debugLog = (projectConfig as Record<string, unknown>).debugLog;
  if (debugLog !== undefined && typeof debugLog !== "boolean") {
    throw new Error(`Pi global settings property "${FILE_TOOLS_PROJECT_NAME}.debugLog" at ${configPath} must be a boolean.`);
  }
  return { debugLog: debugLog ?? false };
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof FileToolError) return { ...error.payload };
  if (error instanceof Error) {
    return { status: "error", name: error.name, message: error.message, stack: error.stack };
  }
  return { status: "error", message: String(error) };
}

function createFailureRecord(tool: string, toolCallId: string, request: unknown, error: unknown) {
  return {
    timestamp: new Date().toISOString(),
    tool,
    toolCallId,
    request,
    result: describeError(error),
  };
}

function appendFailureLogSync(
  tool: string,
  toolCallId: string,
  request: unknown,
  error: unknown,
  logDirectory = join(homedir(), ".pi", "logs", FILE_TOOLS_PROJECT_NAME),
): void {
  const record = createFailureRecord(tool, toolCallId, request, error);
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  appendFileSync(join(logDirectory, `${record.timestamp.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function writeFileToolFailureLog(
  tool: string,
  toolCallId: string,
  request: unknown,
  error: unknown,
  logDirectory = join(homedir(), ".pi", "logs", FILE_TOOLS_PROJECT_NAME),
): Promise<void> {
  const record = createFailureRecord(tool, toolCallId, request, error);
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  await appendFile(join(logDirectory, `${record.timestamp.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function prepareWithFailureLogging<T>(
  debugLog: boolean,
  tool: string,
  prepare: (args: unknown) => T,
  logDirectory?: string,
): (args: unknown) => T {
  return (args) => {
    try {
      return prepare(args);
    } catch (error) {
      if (debugLog) {
        try {
          appendFailureLogSync(tool, "prepareArguments", args, error, logDirectory);
        } catch {
          // Logging must never mask or replace the original validation failure.
        }
      }
      throw error;
    }
  };
}

export async function executeWithFailureLogging<T>(
  debugLog: boolean,
  tool: string,
  toolCallId: string,
  request: unknown,
  execute: () => Promise<T>,
  logDirectory?: string,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (debugLog) {
      try {
        await writeFileToolFailureLog(tool, toolCallId, request, error, logDirectory);
      } catch {
        // Logging must never mask or replace the original tool failure.
      }
    }
    throw error;
  }
}

