/**
 * Shared settings-panel contract. A module describes its configuration once (fields, visibility, how edited values map
 * back onto its JSON file); the panel, the safe write and the `/settings:<id>` command are shared.
 */
export type Values = Record<string, string | number | boolean>;

interface FieldBase {
  /** Unique within the schema; used as the key in `Values`. Not necessarily a JSON path. */
  key: string;
  label: string;
  group: string;
  /** Page the field lives on; defaults to `group`. All pages share one fixed dialog height. */
  tab?: string;
  help?: string;
  /** Hidden fields are neither shown nor written. Evaluated against the live (unsaved) values. */
  visibleWhen?: (values: Values) => boolean;
}
export type Field =
  | (FieldBase & { type: 'boolean' })
  | (FieldBase & { type: 'enum'; options: readonly string[] })
  | (FieldBase & { type: 'int'; min: number; max: number })
  | (FieldBase & { type: 'string'; placeholder?: string })
  /** Masked. The stored value is never loaded into the panel; `configured` only says whether one exists. */
  | (FieldBase & { type: 'secret'; configured: (values: Values) => boolean })
  /**
   * A generated value shown read-only (for example a pairing code). Enter replaces it with `generate()` right away; like any
   * other value it is only written when the user saves, and Esc discards the new one.
   */
  | (FieldBase & { type: 'code'; generate(): string })
  /**
   * A one-shot operation (for example a download). Enter arms it, a second Enter starts it after showing `confirm`; it runs in
   * the background, reports through `progress`, and is aborted by Esc or when the panel closes. Never part of the saved values.
   */
  | (FieldBase & {
    type: 'action';
    confirm: string;
    /** Current state shown in the value column. Read at open and again after each run, not on every render. */
    status(): string;
    run(control: { signal: AbortSignal; progress(text: string): void }): Promise<string>;
  });

/** One change to the raw JSON document. `value: undefined` deletes the key. */
export interface Patch { path: readonly string[]; value: unknown }

export interface SettingsSchema<C = unknown> {
  /** Command suffix: `/settings:<id>`. */
  id: string;
  title: string;
  /** Absolute path of the JSON file. */
  path: string;
  fields: readonly Field[];
  /** Validates a whole document; throws on an invalid one. The module's own loader stays the only rule source. */
  parse(raw: unknown): C;
  /** Keys whose initial value is not stored yet (for example a freshly generated code): they count as changed from the start, so Save writes them. */
  unsaved?: readonly string[];
  /** Initial panel values from a parsed config. Secret fields are omitted (their value is never loaded). */
  toValues(config: C): Values;
  /** Turns edited values into patches. `dirty` lists the keys the user changed. Throws with a user-readable message. */
  toPatch(values: Values, dirty: ReadonlySet<string>, current: C): Patch[];
  /**
   * Effects outside the JSON file (for example a credential kept in another store), run after the file was written.
   * A returned string is shown as the save error (the file is already saved by then).
   */
  afterWrite?(values: Values, dirty: ReadonlySet<string>): Promise<string | undefined> | string | undefined;
  /** Short note shown after a successful save. */
  afterSave?: string;
  /** Shown under the title (for example "an environment variable currently overrides this file"). */
  notice?: string;
  /** When every key has been removed, delete the file instead of writing `{}` (the module treats "no file" as its default). */
  deleteWhenEmpty?: boolean;
}
