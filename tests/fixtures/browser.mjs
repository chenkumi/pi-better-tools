import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]), mode = 'static';
const heartbeat = setInterval(() => console.log(`[web-read] ${mode} still running...`), 10000);
let server, service, session, outputPath;
try {
  const { FetchService } = await import(pathToFileURL(join(root, 'modules/web-tools/src/fetch/service.ts')).href);
  const { toolOutput } = await import(pathToFileURL(join(root, 'modules/web-tools/src/output.ts')).href);
  // Code-only seam for the private-loopback fixture. Model-callable Fetch remains private-network blocked.
  service = new FetchService({ timeoutMs: 20000, maxConcurrency: 2 }, { allowPrivateNetwork: true });
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<title>Large static fixture</title><main id="ready">' + Array.from({ length: 1400 }, (_, i) => `<p>Paragraph ${i + 1}: independently rendered fixture data with sufficient content for pagination.</p>`).join('') + '</main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const input = { url: `http://127.0.0.1:${server.address().port}/`, extraction: 'main', format: 'text' };
  {
    const rendered = await service.fetch(input);
    assert.match(rendered.content, /Paragraph 1:/); assert.match(rendered.content, /Paragraph 1400:/);
    const result = await toolOutput(rendered.content, { title: rendered.title });
    assert.equal(result.details.truncated, true); outputPath = result.details.fullOutputPath;
    assert.ok(outputPath); assert.match(result.content[0].text, /Output truncated.*Full cleaned content/s);
    const home = homedir(), agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
    await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
    await writeFile(join(agentDir, 'auth.json'), '{}');
    await writeFile(join(agentDir, 'web-search.json'), '{"provider":"openai"}');
    process.env.PI_WEB_TOOLS_CONFIG = join(agentDir, 'web-search.json');
    const sdk = await import('@earendil-works/pi-coding-agent'); sdk.initTheme('dark', false);
    const settings = sdk.SettingsManager.inMemory({ defaultTools: ['read'], enableInstallTelemetry: false });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [root], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    ({ session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model: modelRuntime.getModels()[0], settingsManager: settings, resourceLoader: loader, tools: ['read'], sessionManager: sdk.SessionManager.inMemory(cwd) }));
    await session.bindExtensions({ mode: 'json' });
    const reader = session.agent.state.tools.find(t => t.name === 'read');
    const first = await reader.execute('browser-first', { path: outputPath, offset: 1, limit: 20 }, AbortSignal.timeout(20000));
    const later = await reader.execute('browser-later', { path: outputPath, offset: 1201, limit: 10 }, AbortSignal.timeout(20000));
    assert.equal(first.details.sha256.length, 32); assert.equal(first.details.sha256, later.details.sha256);
    const text = output => output.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    assert.match(text(first), /READ_CONTINUATION/); assert.match(text(later), /1201│/);
    assert.notEqual(text(first), text(later)); assert.equal(await readFile(outputPath, 'utf8'), rendered.content);
    await service.close();
    console.log(JSON.stringify({ mode, fetched: true, truncated: true, paginatedRead: true }));
  }
} finally {
  console.log('[web-read] Closing test-owned resources...');
  try { if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } }
  finally {
    try { await service?.close(); }
    finally {
      if (server) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      if (outputPath) await rm(dirname(outputPath), { recursive: true, force: true });
      clearInterval(heartbeat);
    }
  }
}
