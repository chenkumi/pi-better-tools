import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import { ulid } from 'ulid';
import { diagnostic, feedback, LIMIT, MESSAGE_TYPE, STATE_TYPE, type Diagnostic } from './policy.js';

interface State {
  version: 1;
  taskId: string;
  used: number;
  enabled: boolean;
  handled: string[];
  fingerprints: string[];
  pending: Diagnostic | null;
}
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
function validDiagnostic(value: unknown): value is Diagnostic {
  if (!value || typeof value !== 'object') return false;
  const d = value as Diagnostic;
  return bounded(d.entryId, 128) && ['ignore', 'host', 'terminal', 'repairable', 'policy', 'review'].includes(d.kind) &&
    bounded(d.message, 2048) && bounded(d.provider, 256) && bounded(d.model, 256) && /^[a-f0-9]{64}$/.test(d.fingerprint);
}
function validState(value: unknown): value is State {
  if (!value || typeof value !== 'object') return false;
  const s = value as State;
  return s.version === 1 && bounded(s.taskId, 128) && Number.isInteger(s.used) && s.used >= 0 && s.used <= LIMIT &&
    typeof s.enabled === 'boolean' && Array.isArray(s.handled) && s.handled.length === s.used && new Set(s.handled).size === s.used && s.handled.every(x => bounded(x, 128)) &&
    Array.isArray(s.fingerprints) && s.fingerprints.length === s.used && s.fingerprints.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)) &&
    (s.pending === null || validDiagnostic(s.pending));
}

/** Native, bounded diagnostic recovery. Never replaces the host's provider/retry machinery. */
export default function runtime(pi: ExtensionAPI) {
  let owner: string | undefined, generation = 0, stopped = true, healthy = true, enabled = true;
  let state: State | undefined, confirming = false;
  // Pi 1.1.0 has no public run ID. A one-shot phase token follows its admitted
  // prompt path, not prompt text (templates, transforms and image hints change it).
  type Admission = object;
  let inputCandidate: Admission | undefined, prepared: Admission | undefined, started: Admission | undefined;
  const admittedMessages = new WeakSet<object>();
  let confirmationController: AbortController | undefined;
  const clearInput = () => { inputCandidate = prepared = started = undefined; };
  const invalidate = () => { generation++; confirmationController?.abort(); clearInput(); };
  const owned = (ctx: ExtensionContext) => !stopped && ctx.sessionManager.getSessionId() === owner;
  const notify = (ctx: ExtensionContext, text: string) => { ctx.ui.notify(`Pi Runtime: ${text}`, 'warning'); };
  function persist(ctx: ExtensionContext, next: State): boolean {
    if (!owned(ctx) || !healthy || !ctx.sessionManager.getSessionFile()) return false;
    try { pi.appendEntry(STATE_TYPE, next); state = next; return true; }
    catch { healthy = false; notify(ctx, 'Recovery state could not be recorded; no recovery will be submitted.'); return false; }
  }
  function sameModel(ctx: ExtensionContext, d: Diagnostic): boolean {
    return ctx.model?.id === d.model && ctx.model.provider === d.provider;
  }
  function eligible(ctx: ExtensionContext, d: Diagnostic): boolean {
    return owned(ctx) && healthy && enabled && !!state && state.used < LIMIT &&
      !ctx.signal?.aborted && !!ctx.sessionManager.getSessionFile() && sameModel(ctx, d) &&
      !state.handled.includes(d.entryId) && ctx.sessionManager.getBranch().some(e => e.type === 'message' && e.id === d.entryId && e.message.role === 'assistant' && e.message.stopReason === 'error');
  }
  function reserve(ctx: ExtensionContext, d: Diagnostic): number | undefined {
    if (!eligible(ctx, d) || !state) return;
    const next: State = { ...state, used: state.used + 1, handled: [...state.handled, d.entryId],
      fingerprints: [...state.fingerprints, d.fingerprint], pending: null };
    // Reserve durably before submission; do not refill after uncertain delivery/commit failure.
    if (persist(ctx, next)) return next.used;
  }
  function restore(ctx: ExtensionContext) {
    state = undefined; enabled = true; healthy = true;
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e.type !== 'custom' || e.customType !== STATE_TYPE) continue;
      if (validState(e.data)) { state = structuredClone(e.data); enabled = state.enabled; }
      else { healthy = false; notify(ctx, 'Invalid saved recovery state; recovery is disabled rather than replenishing its budget.'); }
      break;
    }
    if (!state || !healthy) return;
    // A task's spend is session-wide, not rolled back with the visible branch.
    const entries = ctx.sessionManager.getEntries();
    if (entries.length > 100000) { healthy = false; notify(ctx, 'Recovery history exceeds the inspection bound; recovery disabled.'); return; }
    const handled = new Map<string, string>();
    for (const entry of entries) {
      if (entry.type !== 'custom' || entry.customType !== STATE_TYPE) continue;
      const data = entry.data as Partial<State> | null;
      if (data?.taskId !== state.taskId) continue;
      if (!validState(data)) { healthy = false; notify(ctx, 'Invalid task reservation history; recovery disabled.'); return; }
      for (let i = 0; i < data.handled.length; i++) {
        const id = data.handled[i], fingerprint = data.fingerprints[i];
        if (handled.has(id) && handled.get(id) !== fingerprint) {
          healthy = false; notify(ctx, 'Invalid conflicting task reservation; recovery disabled.'); return;
        }
        handled.set(id, fingerprint);
      }
    }
    if (handled.size > LIMIT) { healthy = false; notify(ctx, 'Invalid task reservation count; recovery disabled.'); return; }
    state = { ...state, used: handled.size, handled: [...handled.keys()], fingerprints: [...handled.values()] };
  }
  pi.on('session_start', (_event, ctx) => {
    invalidate(); owner = ctx.sessionManager.getSessionId(); stopped = false; confirming = false; clearInput(); restore(ctx);
  });
  pi.on('session_before_tree', () => { invalidate(); });
  pi.on('session_tree', (_event, ctx) => { if (owned(ctx)) { invalidate(); restore(ctx); } });
  pi.on('model_select', () => { invalidate(); });
  pi.on('session_shutdown', () => { stopped = true; invalidate(); });
  pi.on('input', (event, ctx) => {
    if (!owned(ctx)) return;
    invalidate();
    // A queued/handled input is not proof of a new started user task.
    if (event.source !== 'extension' && !event.streamingBehavior && ctx.isIdle()) inputCandidate = {};
  });
  pi.on('before_agent_start', (_event, ctx) => {
    if (!owned(ctx)) return;
    prepared = inputCandidate;
    inputCandidate = undefined;
  });
  pi.on('agent_start', (_event, ctx) => {
    if (!owned(ctx)) return;
    generation++; confirmationController?.abort(); started = prepared; inputCandidate = prepared = undefined;
  });
  pi.on('message_end', (event, ctx) => {
    if (!owned(ctx) || !started || event.message.role === 'system') return;
    clearInput();
    // agent.prompt emits its user object first (after an optional system delta).
    // Continuations have no complete input/preflight token; custom messages are
    // not user admissions. Host persists this object only after message_end.
    if (event.message.role !== 'user' || admittedMessages.has(event.message) || ctx.signal?.aborted) return;
    admittedMessages.add(event.message);
    persist(ctx, { version: 1, taskId: ulid().toUpperCase(), used: 0, enabled, handled: [], fingerprints: [], pending: null });
  });
  pi.on('agent_settled', () => { clearInput(); });
  pi.on('turn_end', (event, ctx) => {
    if (!owned(ctx) || !state || event.message.role !== 'assistant') return;
    if (event.message.stopReason !== 'error' || ctx.signal?.aborted) {
      if (state.pending) persist(ctx, { ...state, pending: null });
      return;
    }
    const d = diagnostic(event.message, event.messageEntryId);
    if (state.handled.includes(d.entryId)) return;
    persist(ctx, { ...state, pending: d });
  });
  pi.on('agent_before_settle', (event, ctx) => {
    const d = state?.pending;
    if (!d || !owned(ctx) || event.outcome === 'aborted' || ctx.signal?.aborted) return;
    if (d.kind !== 'repairable' || !eligible(ctx, d) || state?.fingerprints.includes(d.fingerprint)) {
      if (d.kind === 'policy' || d.kind === 'review' || d.kind === 'repairable')
        notify(ctx, `Automatic recovery paused (${d.kind}); use /runtime-recover with a legitimate-purpose/scope clarification after review, or start a new task. Budget ${state?.used ?? 0}/${LIMIT}.`);
      return;
    }
    const attempt = reserve(ctx, d);
    if (attempt === undefined) return;
    const draft: SessionBoundaryDraft = { type: 'custom_message', customType: MESSAGE_TYPE, display: true,
      content: feedback(d, attempt), details: { taskId: state?.taskId, attempt, limit: LIMIT, mode: 'automatic', error: d } };
    return { entries: [...event.entries, draft], continue: true };
  });
  pi.registerCommand('runtime-recovery', {
    description: 'Show bounded runtime recovery status, or turn it on/off for this session (does not reset the task budget).',
    handler: async (args, ctx) => {
      if (!owned(ctx)) return;
      const option = args.trim() || 'status';
      if (option === 'on' || option === 'off') {
        invalidate();
        const nextEnabled = option === 'on';
        if (state && !persist(ctx, { ...state, enabled: nextEnabled })) return;
        enabled = nextEnabled;
      } else if (option !== 'status') { notify(ctx, 'Usage: /runtime-recovery status|on|off'); return; }
      ctx.ui.notify(`Pi Runtime: ${enabled && healthy ? 'on' : 'off'}; recoveries ${state?.used ?? 0}/${LIMIT}; pending ${state?.pending?.kind ?? 'none'}.`, 'info');
    },
  });
  pi.registerCommand('runtime-recover', {
    description: 'Review a paused API error with a scope clarification and explicit human confirmation; spends the same bounded task budget.',
    handler: async (args, ctx) => {
      const d = state?.pending, clarification = args.trim();
      if (!d || !['policy', 'review', 'repairable'].includes(d.kind) || !eligible(ctx, d) || !ctx.isIdle() || ctx.mode !== 'tui' || !ctx.hasUI || confirming) {
        notify(ctx, 'No eligible paused error, or recovery is disabled/busy/exhausted. Manual recovery requires idle TUI confirmation; RPC/JSON/print are unsupported because idle host abort cannot revoke their pending approval.'); return;
      }
      if (clarification.length < 8 || clarification.length > 4096 || /^(?:retry|重試|再試|\s|[.!！。])+$/i.test(clarification)) {
        notify(ctx, 'Provide a legitimate-purpose and authorized-scope clarification (8–4096 characters), not merely “retry”.'); return;
      }
      // Idle host abort has no public extension event/signal. This is TUI dialog consent,
      // not an idle SDK/RPC abort guarantee; rejecting the dialog always stops submission.
      const currentGeneration = generation, leaf = ctx.sessionManager.getLeafId();
      confirming = true;
      const controller = new AbortController(); confirmationController = controller;
      const abort = () => controller.abort(); ctx.signal?.addEventListener('abort', abort, { once: true });
      try {
        const approved = await ctx.ui.confirm('Review bounded API-error recovery?',
          'Confirm the legitimate objective and your authorized scope. This does not grant API/model access or tool permissions and must not be used to evade safeguards.\n' + clarification.slice(0, 2048), { signal: controller.signal });
        if (!approved || controller.signal.aborted || generation !== currentGeneration || !ctx.isIdle() || ctx.sessionManager.getLeafId() !== leaf || state?.pending?.entryId !== d.entryId) return;
        const attempt = reserve(ctx, d);
        if (attempt === undefined) return;
        pi.sendMessage({ customType: MESSAGE_TYPE, content: feedback(d, attempt, clarification), display: true,
          details: { taskId: state?.taskId, attempt, limit: LIMIT, mode: 'manual', error: d } }, { triggerTurn: true, deliverAs: 'followUp' });
        ctx.ui.notify('Pi Runtime: diagnostic recovery submitted; this is not a delivery or success acknowledgement.', 'info');
      } finally {
        ctx.signal?.removeEventListener('abort', abort);
        if (confirmationController === controller) { confirmationController = undefined; confirming = false; }
      }
    },
  });
}
