import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import registerSubagent from '../extensions/subagent/index.ts';
import { registerWebTools } from '../../web-tools/src/index.ts';
import { defaults } from '../../web-tools/src/config.ts';

const root = await mkdtemp(join(tmpdir(), 'pi-agent-catalog-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});
for (const [directory, description] of [[join(root, 'agent', 'agents'), 'User worker'], [join(root, 'workspace', '.pi', 'agents'), 'Project worker']]) {
  await mkdir(directory!, { recursive: true });
  await writeFile(join(directory!, 'worker.md'), `---\nname: worker\ndescription: ${description}\n---\nFixture instructions.`);
}
const CATALOG = 'pi_subagents_agent_catalog';
const BACKGROUND = 'pi_better_tools_background_lifecycle';
const WEB = 'pi_web_tools_native_search';
function fixture(order: 'subagent-first' | 'web-first', forced = false) {
  const handlers: Function[] = [];
  const active = ['subagent', 'web_fetch'];
  const pi = {
    on(name: string, handler: Function) { if (name === 'before_agent_start') handlers.push(handler); },
    getActiveTools: () => active,
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const subagent = () => registerSubagent(pi, { debugLog: false });
  const web = () => registerWebTools(pi, defaults, () => {});
  if (order === 'subagent-first') { subagent(); web(); } else { web(); subagent(); }
  const options = { sections: { other: 'KEEP_OTHER' } as Record<string, string>, customPrompt: 'KEEP_CUSTOM',
    forceSystemPrompt: forced ? 'KEEP_FORCED' : undefined };
  const ctx = { cwd: join(root, 'workspace'), hasUI: false, isProjectTrusted: () => false,
    model: { provider: 'openai', api: 'openai-responses', id: 'fixture' } };
  const run = (messageType?: 'user' | 'custom') => {
    const event = { messageType, systemPromptOptions: options,
      get systemPrompt() { return options.forceSystemPrompt ?? 'KEEP_CUSTOM'; } };
    for (const handler of handlers) {
      const result = handler(event, ctx);
      if (result?.systemPrompt !== undefined) options.forceSystemPrompt = result.systemPrompt;
    }
  };
  return { active, options, ctx, run };
}

for (const order of ['subagent-first', 'web-first'] as const) {
  test(`${order}: catalog, background and Web compose as sections for user/custom runs without forcing the prompt`, () => {
    const f = fixture(order);
    for (const messageType of [undefined, 'user', 'custom'] as const) {
      f.run(messageType);
      assert.equal(f.options.forceSystemPrompt, undefined);
      assert.equal(f.options.customPrompt, 'KEEP_CUSTOM');
      assert.equal(f.options.sections.other, 'KEEP_OTHER');
      assert.match(f.options.sections[CATALOG]!, /### subagent agent catalog/);
      assert.match(f.options.sections[BACKGROUND]!, /### Background job lifecycle/);
      assert.match(f.options.sections[WEB]!, /Web tools/);
      assert.doesNotMatch(f.options.sections[CATALOG]!, /Project worker/);
      assert.match(f.options.sections[CATALOG]!, /not listed until the current project is trusted/);
    }
    f.ctx.isProjectTrusted = () => true;
    f.run('custom');
    const catalog = f.options.sections[CATALOG]!;
    assert.match(catalog.split('agentScope: "project"')[0]!, /worker.*\(user\).*User worker/);
    assert.match(catalog.split('agentScope: "project"')[1]!.split('agentScope: "both"')[0]!, /worker.*\(project\).*Project worker/);
    assert.match(catalog.split('agentScope: "both"')[1]!, /worker.*\(project\).*Project worker/);
    f.ctx.isProjectTrusted = () => false;
    f.run();
    assert.doesNotMatch(f.options.sections[CATALOG]!, /Project worker/);
    f.active.splice(0, 1, 'subagent_status');
    f.run();
    assert.equal(f.options.sections[CATALOG], undefined);
    assert.ok(f.options.sections[BACKGROUND]);
    assert.ok(f.options.sections[WEB]);
    assert.equal(f.options.forceSystemPrompt, undefined);
  });
  test(`${order}: an external forced prompt keeps catalog and guidance once, with removal when tools are disabled`, () => {
    const f = fixture(order, true);
    f.run('custom');
    f.run('custom');
    assert.ok(f.options.forceSystemPrompt!.startsWith('KEEP_FORCED'));
    assert.equal(f.options.forceSystemPrompt!.split('### subagent agent catalog').length - 1, 1);
    assert.equal(f.options.forceSystemPrompt!.split('### Background job lifecycle').length - 1, 1);
    assert.equal(f.options.forceSystemPrompt!.split(f.options.sections[WEB]!).length - 1, 1);
    f.ctx.isProjectTrusted = () => true;
    f.run();
    assert.match(f.options.forceSystemPrompt!, /Project worker/);
    assert.equal(f.options.forceSystemPrompt!.split('### subagent agent catalog').length - 1, 1);
    f.active.length = 0;
    f.ctx.model = { provider: 'anthropic', api: 'anthropic-messages', id: 'fixture' };
    f.run();
    assert.equal(f.options.forceSystemPrompt, 'KEEP_FORCED');
    assert.deepEqual(f.options.sections, { other: 'KEEP_OTHER' });
  });
}
