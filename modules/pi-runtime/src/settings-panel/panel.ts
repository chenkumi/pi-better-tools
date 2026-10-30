import type { Component } from '@earendil-works/pi-tui';
import { decodeKittyPrintable, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { Field, Values } from './schema.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export interface PanelStyle { fg(color: string, text: string): string; bold(text: string): string }
export interface PanelOptions {
  title: string;
  notice?: string;
  fields: readonly Field[];
  values: Values;
  /** Keys that start out changed: their initial value is not stored yet. */
  unsaved?: readonly string[];
  style: PanelStyle;
  rows: () => number;
  requestRender(): void;
  /** Returns an error message to keep the panel open, or undefined once saved. Receives edited values and changed keys. */
  onSave(values: Values, dirty: ReadonlySet<string>): Promise<string | undefined>;
  onClose(saved: boolean): void;
}

/**
 * Form over a flat `Values` map. Secret text lives only in the edit buffer and, once committed, in `secrets`; it is never
 * rendered (only a `*` count) and leaves this component through `onSave` alone.
 */
export class SettingsPanel implements Component {
  readonly #o: PanelOptions;
  readonly #values: Values;
  readonly #initial: Values;
  readonly #secrets = new Map<string, string>();
  #cursor = 0;
  #tab: string | undefined;
  #edit: { key: string; buffer: string } | undefined;
  #paste: string | undefined;
  #message: { text: string; error: boolean } | undefined;
  #confirmDiscard = false;
  #saving = false;
  #closed = false;
  #height = 0;
  #armed: string | undefined;
  #busy: { key: string; abort: AbortController } | undefined;
  readonly #status = new Map<string, string>();

  constructor(options: PanelOptions) {
    this.#o = options;
    this.#values = { ...options.values };
    this.#initial = { ...options.values };
    for (const key of options.unsaved ?? []) delete this.#initial[key];
    for (const f of options.fields) if (f.type === 'action') this.#status.set(f.key, safe(f.status));
  }

  get #shown(): Field[] { return this.#o.fields.filter(f => !f.visibleWhen || f.visibleWhen(this.#values)); }
  /** Pages that currently have a visible field, in declaration order. */
  get #tabs(): string[] { return [...new Set(this.#shown.map(tabOf))]; }
  get #activeTab(): string | undefined { const tabs = this.#tabs; return this.#tab !== undefined && tabs.includes(this.#tab) ? this.#tab : tabs[0]; }
  get #visible(): Field[] { const tab = this.#activeTab; return this.#shown.filter(f => tabOf(f) === tab); }
  get dirty(): Set<string> {
    const keys = new Set<string>();
    for (const f of this.#o.fields) {
      if (f.visibleWhen && !f.visibleWhen(this.#values)) continue; // hidden fields are never written
      if (f.type === 'secret') { if (this.#secrets.has(f.key)) keys.add(f.key); }
      else if (this.#values[f.key] !== this.#initial[f.key]) keys.add(f.key);
    }
    return keys;
  }

  handleInput(data: string): void {
    if (this.#closed || this.#saving) return;
    if (this.#busy) { // only cancelling is accepted while an action runs
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.#busy.abort.abort(); this.#message = { text: 'Cancelling…', error: false }; this.#o.requestRender(); }
      return;
    }
    if (this.#edit) return this.#editInput(data);
    if (this.#armed && !matchesKey(data, 'enter')) { this.#armed = undefined; this.#message = undefined; }
    if (!matchesKey(data, 'escape')) this.#confirmDiscard = false;
    if (matchesKey(data, 'ctrl+s')) { void this.#save(); return; }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      if (this.dirty.size && !this.#confirmDiscard) { this.#confirmDiscard = true; this.#message = { text: 'Unsaved changes. Press Esc again to discard, or Ctrl+S to save.', error: false }; return this.#o.requestRender(); }
      return this.#close(false);
    }
    const tabs = this.#tabs;
    if (tabs.length > 1 && (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab'))) {
      const at = tabs.indexOf(this.#activeTab!);
      this.#tab = tabs[(at + (matchesKey(data, 'tab') ? 1 : -1) + tabs.length) % tabs.length];
      this.#cursor = 0; this.#message = undefined;
      return this.#o.requestRender();
    }
    const rows = this.#visible;
    if (!rows.length) return;
    if (matchesKey(data, 'up')) this.#cursor = (this.#cursor - 1 + rows.length) % rows.length;
    else if (matchesKey(data, 'down')) this.#cursor = (this.#cursor + 1) % rows.length;
    else {
      const field = rows[Math.min(this.#cursor, rows.length - 1)]!;
      const left = matchesKey(data, 'left'), right = matchesKey(data, 'right');
      const act = matchesKey(data, 'enter') || data === ' ';
      this.#message = undefined;
      if (field.type === 'boolean' && (act || left || right)) this.#values[field.key] = !this.#values[field.key];
      else if (field.type === 'enum' && (act || left || right)) {
        const at = field.options.indexOf(String(this.#values[field.key]));
        this.#values[field.key] = field.options[(at + (left ? -1 : 1) + field.options.length) % field.options.length]!;
      } else if (act && field.type === 'code') {
        this.#values[field.key] = field.generate();
        this.#message = { text: 'New value generated. Save to keep it; Esc discards it.', error: false };
      } else if (act && field.type === 'action') {
        if (this.#armed !== field.key) { this.#armed = field.key; this.#message = { text: `${field.confirm} Enter starts, other keys cancel.`, error: false }; }
        else { this.#armed = undefined; void this.#runAction(field); }
      } else if (act && field.type !== 'boolean' && field.type !== 'enum' && field.type !== 'code') {
        this.#edit = { key: field.key, buffer: field.type === 'secret' ? '' : String(this.#values[field.key] ?? '') };
      }
    }
    this.#cursor = Math.min(this.#cursor, Math.max(0, this.#visible.length - 1));
    this.#o.requestRender();
  }

  #editInput(data: string): void {
    const edit = this.#edit!;
    const field = this.#o.fields.find(f => f.key === edit.key)!;
    if (this.#paste !== undefined || data.includes(PASTE_START)) {
      if (this.#paste === undefined) { this.#paste = ''; data = data.slice(data.indexOf(PASTE_START) + PASTE_START.length); }
      this.#paste += data;
      const end = this.#paste.indexOf(PASTE_END);
      if (end === -1) return;
      const text = this.#paste.slice(0, end).replace(/[\r\n]+/g, ''); this.#paste = undefined;
      edit.buffer += clean(text);
    } else if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { edit.buffer = ''; this.#edit = undefined; }
    else if (matchesKey(data, 'enter')) {
      const error = this.#commit(field, edit.buffer);
      if (error) this.#message = { text: error, error: true };
      else { this.#edit = undefined; this.#message = undefined; }
    } else if (matchesKey(data, 'backspace')) edit.buffer = Array.from(edit.buffer).slice(0, -1).join('');
    else if (matchesKey(data, 'ctrl+u')) edit.buffer = '';
    else {
      const printable = decodeKittyPrintable(data) ?? (data.startsWith('\x1b') ? undefined : data);
      if (printable !== undefined) edit.buffer += clean(printable);
    }
    this.#o.requestRender();
  }

  #commit(field: Field, text: string): string | undefined {
    if (field.type === 'secret') {
      const value = text.trim();
      if (value) this.#secrets.set(field.key, value); else this.#secrets.delete(field.key);
      return undefined;
    }
    if (field.type === 'int') {
      const n = Number(text.trim());
      if (!text.trim() || !Number.isInteger(n) || n < field.min || n > field.max) return `${field.label}: enter an integer from ${field.min} to ${field.max}`;
      this.#values[field.key] = n; return undefined;
    }
    this.#values[field.key] = text.trim(); return undefined;
  }

  async #runAction(field: Extract<Field, { type: 'action' }>): Promise<void> {
    const abort = new AbortController();
    this.#busy = { key: field.key, abort };
    this.#message = { text: 'Starting…', error: false }; this.#o.requestRender();
    let outcome: { text: string; error: boolean };
    try { outcome = { text: await field.run({ signal: abort.signal, progress: text => { if (this.#busy?.abort === abort && !this.#closed) { this.#message = { text, error: false }; this.#o.requestRender(); } } }), error: false }; }
    catch (error) { outcome = { text: error instanceof Error ? error.message : 'The operation failed.', error: true }; }
    this.#busy = undefined;
    if (this.#closed) return;
    this.#status.set(field.key, safe(field.status));
    this.#message = outcome; this.#o.requestRender();
  }

  async #save(): Promise<void> {
    const dirty = this.dirty;
    if (!dirty.size) { this.#message = { text: 'Nothing to save.', error: false }; return this.#o.requestRender(); }
    this.#saving = true; this.#message = { text: 'Saving…', error: false }; this.#o.requestRender();
    // Secrets only join the values handed to onSave, and only for visible fields.
    const values: Values = { ...this.#values };
    for (const [key, secret] of this.#secrets) values[key] = secret;
    let error: string | undefined;
    try { error = await this.#o.onSave(values, dirty); } catch (e) { error = e instanceof Error ? e.message : 'save failed'; }
    this.#saving = false;
    if (this.#closed) return;
    if (error) { this.#message = { text: error, error: true }; return this.#o.requestRender(); }
    this.#close(true);
  }

  #close(saved: boolean): void {
    if (this.#closed) return;
    this.dispose();
    this.#o.onClose(saved);
  }

  /** Drops typed secrets. Safe to call more than once. */
  dispose(): void {
    this.#closed = true; this.#secrets.clear(); this.#paste = undefined; this.#busy?.abort.abort();
    if (this.#edit) this.#edit.buffer = '';
    this.#edit = undefined;
  }

  invalidate(): void {}

  /**
   * Fixed-height rounded frame: the body is as tall as the fullest layout (capped by the terminal) and the help/message
   * line is always reserved, so switching a provider never resizes the dialog. Every line is one row, ellipsised if needed.
   */
  render(width: number): string[] {
    const w = Math.max(30, width), inner = w - 4, s = this.#o.style, edge = (t: string) => s.fg('dim', t);
    const line = (text: string) => `${edge('│')} ${truncateToWidth(text, inner, '…', true)} ${edge('│')}`;
    const layout = (fields: readonly Field[], cursor?: number) => {
      const lines: string[] = [], rowLine: number[] = [];
      let group: string | undefined;
      const headers = new Set(fields.map(f => f.group)).size > 1; // a page of one group needs no heading
      fields.forEach((field, index) => {
        if (field.group !== group) { group = field.group; if (headers) lines.push(s.bold(s.fg('accent', group))); }
        rowLine[index] = lines.length;
        const label = `${index === cursor ? '▸' : ' '} ${field.label}`.padEnd(30);
        const text = `${label}${this.#display(field)}`;
        lines.push(index === cursor ? s.fg('accent', text) : text);
      });
      return { lines, rowLine };
    };
    const rows = this.#visible, { lines, rowLine } = layout(rows, this.#cursor);
    const room = Math.max(5, this.#o.rows() - 8);
    this.#height = Math.max(this.#height, this.#tallest(layout));
    const height = Math.min(room, this.#height);
    let from = 0;
    if (lines.length > height) from = Math.min(Math.max(0, (rowLine[this.#cursor] ?? 0) - Math.floor(height / 2)), lines.length - height);
    const body = Array.from({ length: height }, (_, i) => lines[from + i] ?? '');
    // The tab row exists whenever the schema has several pages, even if only one is visible right now, so the height is stable.
    const pages = new Set(this.#o.fields.map(tabOf)).size > 1;
    const active = this.#activeTab;
    const tabBar = this.#tabs.map(t => (t === active ? s.bold(s.fg('accent', `[ ${t} ]`)) : s.fg('dim', `  ${t}  `))).join(' ');
    if (from > 0 && height) body[0] = `${truncateToWidth(body[0]!, inner - 2, '…', true)} ▲`;
    if (from + height < lines.length && height) body[height - 1] = `${truncateToWidth(body[height - 1]!, inner - 2, '…', true)} ▼`;
    const mark = this.dirty.size ? ' ●' : '';
    const head = ` ${this.#o.title}${mark} `;
    const top = `${edge('╭──')}${s.bold(head)}${edge(`${'─'.repeat(Math.max(0, w - 4 - head.length))}╮`)}`;
    const focus = rows[this.#cursor];
    const help = this.#message ? s.fg(this.#message.error ? 'error' : 'warning', this.#message.text) : s.fg('dim', focus?.help ?? '');
    const hint = s.fg('dim', this.#edit ? 'Enter confirm  Esc cancel edit  Ctrl+U clear' : `↑/↓ move  Enter/←/→ change  ${pages ? 'Tab page  ' : ''}Ctrl+S save  Esc close`);
    return [
      truncateToWidth(top, w),
      ...(this.#o.notice ? [line(s.fg('warning', this.#o.notice))] : []),
      ...(pages ? [line(tabBar), line('')] : []),
      ...body.map(line), line(''), line(help), line(hint),
      edge(`╰${'─'.repeat(w - 2)}╯`),
    ];
  }

  /** Tallest page reachable by flipping one enum/boolean from the current values; every page shares it and it never shrinks. */
  #tallest(layout: (fields: readonly Field[]) => { lines: string[] }): number {
    const pages = [...new Set(this.#o.fields.map(tabOf))];
    const count = (values: Values) => {
      const saved = { ...this.#values };
      Object.assign(this.#values, values);
      try { return Math.max(0, ...pages.map(tab => layout(this.#shown.filter(f => tabOf(f) === tab)).lines.length)); }
      finally { Object.assign(this.#values, saved); }
    };
    let tallest = count({});
    for (const f of this.#o.fields) {
      if (f.type === 'boolean') tallest = Math.max(tallest, count({ [f.key]: !this.#values[f.key] }));
      else if (f.type === 'enum') for (const option of f.options) tallest = Math.max(tallest, count({ [f.key]: option }));
    }
    return tallest;
  }

  #display(field: Field): string {
    const editing = this.#edit?.key === field.key ? this.#edit : undefined;
    if (field.type === 'code') return `${String(this.#values[field.key] ?? '')}  (Enter to regenerate)`;
    if (field.type === 'action') return this.#busy?.key === field.key ? 'running…  (Esc cancels)' : `${this.#status.get(field.key) ?? ''}  (Enter to run)`;
    if (field.type === 'secret') {
      if (editing) return `${'*'.repeat(Array.from(editing.buffer).length)}_`;
      return this.#secrets.has(field.key) ? `${'*'.repeat(8)} (new, unsaved)` : field.configured(this.#initial) ? '******** (configured; Enter to replace)' : '(not set)';
    }
    if (editing) return `${editing.buffer}_`;
    const v = this.#values[field.key];
    if (field.type === 'boolean') return v ? '[x]' : '[ ]';
    if (field.type === 'enum') return `‹ ${v} ›`;
    return String(v === '' || v === undefined ? (field.type === 'string' ? field.placeholder ?? '' : '') : v);
  }
}

/** Control characters are never stored. */
function clean(text: string): string {
  return Array.from(text).filter(char => { const code = char.codePointAt(0)!; return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f); }).join('');
}

const tabOf = (field: Field): string => field.tab ?? field.group;

const safe = (status: () => string): string => { try { return status(); } catch { return 'unknown'; } };
