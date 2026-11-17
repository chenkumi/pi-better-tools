import { createHash } from "node:crypto";

/**
 * The version token of `read`, `write`, `edit` and `note`: the first 16 hex characters (64 bits) of the SHA-256 of the
 * file bytes. It detects an accidental change between a read and a write, it is not a defence against a forged
 * collision. Older tokens (32 characters, or the full 64) stay valid: a token is accepted when it is a prefix of the
 * current digest, so no version marker or migration is needed.
 */
export const VERSION_TOKEN_LENGTH = 16;
export const FULL_DIGEST_LENGTH = 64;
/** Lengths a caller may pass back: the current token, the 128-bit token of earlier versions and the full digest. */
export const ACCEPTED_TOKEN_LENGTHS = [VERSION_TOKEN_LENGTH, 32, FULL_DIGEST_LENGTH] as const;

export function digestHex(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The token that read, write and edit report for `content`. */
export function versionToken(content: Uint8Array | string): string {
  return digestHex(content).slice(0, VERSION_TOKEN_LENGTH);
}

/** True for a string made of hex digits with one of the accepted lengths. */
export function isVersionToken(value: string): boolean {
  return ACCEPTED_TOKEN_LENGTHS.some((length) => value.length === length) && /^[a-fA-F0-9]+$/.test(value);
}

/** True when `token` (any accepted length, any case) names the file whose full digest is `fullDigest`. */
export function matchesVersionToken(token: string, fullDigest: string | undefined): boolean {
  if (!fullDigest || !isVersionToken(token)) return false;
  return fullDigest.startsWith(token.toLowerCase());
}

/** A hash cut to the token length for messages. */
export function shortenDigest(hash: string | undefined): string | undefined {
  return hash && hash.length > VERSION_TOKEN_LENGTH ? hash.slice(0, VERSION_TOKEN_LENGTH) : hash;
}

/** Regex alternatives (unanchored) matching an accepted token, for JSON-schema `pattern` strings. */
export const VERSION_TOKEN_ALTERNATIVES = ACCEPTED_TOKEN_LENGTHS.map((length) => `[a-fA-F0-9]{${length}}`).join("|");
