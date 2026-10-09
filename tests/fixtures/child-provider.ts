// Synthetic provider for real CLI parent -> integrated managed child. No HTTP transport.
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream, getCurrentTools } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
const text = (message: any) => (message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export default function (pi: ExtensionAPI) {
  let requests = 0;
  const isParent = () => pi.getActiveTools().includes('subagent');
  pi.registerTool({ name: 'integration_probe', label: 'Offline integration probe', description: 'Synthetic test-only nested tool contract check', parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      assert.ok(!isParent()); assert.ok(!ctx.tools.some(t => t.name === 'subagent'));
      const call = async (name: string, args: unknown) => { const outcome = await ctx.executeTool(name, args); assert.equal(outcome.isError, false, text(outcome.result)); return outcome.result; };
      const shellName = process.platform === 'win32' ? 'powershell' : 'bash';
      const shell = ctx.tools.find(t => t.name === shellName)!;
      assert.ok(shell.parameters.properties.timeoutMs); assert.equal(shell.parameters.properties.timeout, undefined);
      await call('write', { path: 'child.txt', content: 'child alpha\n', expectedHash: 'missing' });
      const read = await call('read', { path: 'child.txt', offset: null, limit: null });
      assert.match(text(read), /1│child alpha/); assert.equal((read.details as any).sha256.length, 32);
      const edit = await call('edit', { path: 'child.txt', expectedHash: (read.details as any).sha256, edits: [{ oldText: 'alpha', newText: 'BETA' }] });
      assert.match(text(edit), /FILE_EDIT_SUCCESS/);
      assert.match(text(await call(shellName, { command: process.platform === 'win32' ? "Write-Output 'CHILD_SHELL_OK'" : "printf 'CHILD_SHELL_OK'", timeoutMs: 20000 })), /CHILD_SHELL_OK/);
      const data = { child: true, noRecursiveSubagent: true, nestedFileAndShell: true, cwd: ctx.cwd };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data };
    } });
  pi.registerProvider('integration-offline', { baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'offline-dummy', api: 'integration-offline-api',
    models: [{ id: 'fixture', name: 'Offline integration fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream(), nth = ++requests, parent = isParent();
      const message: any = { role: 'assistant', provider: model.provider, api: model.api, model: model.id, content: [], stopReason: 'pending', usage: usage(), timestamp: Date.now() };
      setImmediate(() => {
        try {
          if (!parent) {
            assert.ok(!getCurrentTools(context.messages).some(t => ['subagent', 'subagent_message', 'subagent_status', 'subagent_cancel'].includes(t.name)), 'child must not inherit invocation-starting or parent-management tools');
            assert.ok(!getCurrentTools(context.messages).some(t => t.name === 'goal'), 'managed child cannot inherit goal mutation/continuation');
          }
          const prior = [...context.messages].reverse().find((m: any) => m.role === 'toolResult');
          const userTurns = context.messages.filter((m: any) => m.role === 'user').length;
          let call;
          if (parent && nth === 1) call = { id: 'integrated-child', name: 'subagent', arguments: { agent: 'worker', task: 'Synthetic offline probe; no real provider or credential access.', ...(process.env.PI_BETTER_TOOLS_CHILD_CWD ? { cwd: process.env.PI_BETTER_TOOLS_CHILD_CWD } : {}) } };
          else if (parent && nth === 2) {
            assert.ok(prior && !prior.isError, text(prior));
            const first = (prior as any).details.results[0]; assert.equal(first.canResume, true);
            call = { id: 'integrated-resume', name: 'subagent_message', arguments: { subagentSessionId: first.subagentSessionId, message: 'Resume saved offline history; report native continuation without repeating file mutations.' } };
          } else if (!parent && nth === 1 && userTurns === 1) call = { id: 'child-probe', name: 'integration_probe', arguments: {} };
          stream.push({ type: 'start', partial: message });
          if (call) {
            message.content = [{ type: 'toolCall', ...call }]; message.stopReason = 'toolUse';
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message }); stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message });
          } else {
            assert.ok(prior && !prior.isError, text(prior));
            const content = parent ? 'integrated parent complete' : userTurns === 2
              ? JSON.stringify({ ...JSON.parse(text(prior)), nativeResume: true, userTurns }) : text(prior);
            message.content = [{ type: 'text', text: content }]; message.stopReason = 'stop';
            stream.push({ type: 'text_start', contentIndex: 0, partial: message }); stream.push({ type: 'text_end', contentIndex: 0, content, partial: message });
          }
          stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
        } catch (error) { message.stopReason = 'error'; message.errorMessage = String(error); stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); }
      }); return stream;
    } });
}
