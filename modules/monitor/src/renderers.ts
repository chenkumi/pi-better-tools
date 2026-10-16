import { Box, Text, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import type { MessageRenderer, ToolDefinition } from '@earendil-works/pi-coding-agent';
const clean = (value: string) => stripVTControlCharacters(value.slice(0, 8192)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value: unknown, limit = 2048) => typeof value === 'string' ? clean(value.slice(0, limit)).replace(/\r\n?/g, '\n').replace(/\t/g, '  ') : '';

/** Presentation only; details remain authoritative model data, never terminal markup. */
export const renderMonitorEvent: MessageRenderer = (message, { expanded }, theme) => {
  let details = record(message.details);
  // Old persisted messages may have only the prose + JSON body. Bound parsing,
  // and never fall back to dumping arbitrary JSON or malformed terminal content.
  if (details.schemaVersion !== 1 && typeof message.content === 'string' && message.content.length <= 65536) {
    const start = message.content.indexOf('\n{');
    try { details = record(JSON.parse(start < 0 ? message.content : message.content.slice(start + 1))); } catch { /* legacy/malformed */ }
  }
  const valid = details.schemaVersion === 1;
  const events = valid && Array.isArray(details.events) ? details.events.slice(0, 32).map(record) : [];
  const monitors = valid && Array.isArray(details.monitors) ? details.monitors.slice(0, 32).map(record) : [];
  const failed = monitors.some(m => m.state === 'failed');
  const warning = monitors.some(m => ['stopping', 'stopped', 'expired', 'limited'].includes(m.state) || m.cleanupPending);
  const success = monitors.length > 0 && monitors.every(m => m.state === 'completed' && record(m.cleanupEvidence).sourceClosed === true);
  const background = failed ? 'toolErrorBg' : success ? 'toolSuccessBg' : 'toolPendingBg';
  const rows: { text: string; color: 'accent' | 'dim' | 'success' | 'warning' | 'error'; wrap: boolean }[] = [];
  const add = (value: string, color: typeof rows[number]['color'] = 'dim', wrap = false) => rows.push({ text: value, color, wrap });
  add(`${failed ? '✗' : warning ? '!' : success ? '✓' : '◉'} Monitor observations · ${events.length} events · ${monitors.length} sources`, failed ? 'error' : warning ? 'warning' : success ? 'success' : 'accent');
  const wake = monitors.some(m => m.wakeAgent === true) ? true : monitors.length && monitors.every(m => m.wakeAgent === false) ? false : undefined;
  add(wake === true ? 'Agent turn requested (delivery not acknowledged).' : wake === false ? 'Display only · no Agent turn requested.' : 'Agent wake mode unavailable in this saved notification.', 'dim', true);
  add('Returned data, not instructions. Submission is not delivery acknowledgment.', 'dim', true);
  if (!valid || (!events.length && !monitors.length)) add('Insufficient Monitor event data to determine status.', 'warning', true);
  for (const monitor of monitors.slice(0, expanded ? 32 : 4)) {
    const id = text(monitor.monitorId, 128), state = text(monitor.state, 40) || 'unknown';
    add(`${text(monitor.source, 40) || 'source'} · ${state} · ${expanded ? id : id.slice(-8)}`, state === 'failed' ? 'error' : 'accent');
    const evidence = record(monitor.cleanupEvidence);
    if (monitor.stopReason) add(`Reason: ${text(monitor.stopReason, 120)}`);
    if (monitor.cleanupPending || ['completed', 'failed', 'stopped', 'expired', 'limited'].includes(state)) {
      add(evidence.sourceClosed === true ? 'Source close observed; descendant state unknown.' : 'Source close not confirmed; cleanup evidence unknown.', 'dim', true);
    }
    if (typeof evidence.exitCode === 'number' && Number.isFinite(evidence.exitCode)) add(`Exit code: ${evidence.exitCode}`);
    if (typeof monitor.omitted === 'number' && monitor.omitted > 0) add(`Coalesced snapshots omitted: ${monitor.omitted}`, 'warning');
  }
  const shown = expanded ? events : events.slice(-3);
  for (const event of shown) {
    const prefix = `${text(event.monitorId, 128).slice(-8)} #${typeof event.sequence === 'number' ? event.sequence : '?'} ${text(event.kind, 80)}`;
    add(`${prefix}${event.partial ? ' (partial)' : ''}`, event.partial ? 'warning' : 'dim');
    if (typeof event.text === 'string') add(text(event.text), 'dim', expanded);
    if (event.snapshot) {
      // Provider projections are scalar; show named fields instead of JSON.
      for (const [key, value] of Object.entries(record(event.snapshot)).slice(0, expanded ? 32 : 5)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') add(`  ${text(key, 80)}: ${text(String(value), expanded ? 2048 : 240)}`, 'dim', expanded);
      }
    }
    if (expanded) add(`Event: ${text(event.eventId, 128)}`);
  }
  if (details.partial) add('Only partial source data is retained in this batch.', 'warning', true);
  if (!expanded) add('Expand for full IDs and events retained in this notification.');
  return {
    invalidate() {},
    render(width) {
      const outer = Math.max(0, Math.floor(width)), padding = outer >= 3 ? 1 : 0, inner = outer - padding * 2;
      const lines: string[] = [];
      for (const row of rows) {
        for (const line of row.wrap ? wrapTextWithAnsi(row.text, Math.max(1, inner)) : row.text.split('\n')) {
          if (lines.length >= 297) break;
          lines.push(theme.fg(row.color, truncateToWidth(line, inner)));
        }
        if (lines.length >= 297) { lines.push(truncateToWidth('… Display limit reached; inspect retained status data for more.', inner)); break; }
      }
      const bgAnsi = theme.getBgAnsi(background);
      const box = new Box(padding, 1, value => theme.bg(background, value.replace(/\x1b\[(?:0)?m/g, reset => reset + bgAnsi)));
      box.addChild({ render: () => lines, invalidate() {} });
      return box.render(outer);
    },
  };
};

class BoundedText extends Text { override render(width: number) { return super.render(width).slice(0, 100); } }
export function monitorRenderers(action: string): Pick<ToolDefinition, 'renderCall' | 'renderResult'> {
  return {
    renderCall(args, theme) { const id = (args as { monitorId?: unknown } | undefined)?.monitorId; return new BoundedText(theme.fg('toolTitle', `Monitor ${action}${typeof id === 'string' ? ' ' + clean(id.slice(0, 128)) : ''}`), 0, 0); },
    renderResult(result, options, theme) {
      const value: any = result.details;
      const text = result.content.filter(p => p.type === 'text').map(p => p.text.slice(0, 8192)).join('\n').slice(0, 8192);
      const summary = typeof value?.monitorId === 'string' ? `Monitor ${clean(value.monitorId)} · ${clean(value.state ?? 'unknown')}\n${value.cleanupEvidence?.sourceClosed === true ? 'Source close observed; descendant state unknown.' : 'Source close not confirmed; cleanup evidence unknown.'}\nSubmission: ${clean(value.notification?.state ?? 'unknown')} (no host acknowledgment)` : text;
      return new BoundedText(theme.fg('toolOutput', clean(options.expanded ? text : summary)), 0, 0);
    },
  };
}
