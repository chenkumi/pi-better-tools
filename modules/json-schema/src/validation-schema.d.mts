export const SUBSCHEMA: ReadonlySet<string>;
export const SUBSCHEMA_LIST: ReadonlySet<string>;
export const SUBSCHEMA_MAP: ReadonlySet<string>;
export function childSchemas(node: Record<string, unknown>, maps?: ReadonlySet<string>): Generator<[child: unknown, pathSuffix: string]>;
export function withoutSchemaDefaults(node: unknown): unknown;
export function toZodSchema(node: unknown): any;
export function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string;
export function isValidationFault(reason: string): boolean;
