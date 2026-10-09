import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { clip, toolOutput, MAX_INLINE_BYTES, MAX_INLINE_LINES, MAX_STRUCTURED_BYTES } from '../../src/output.ts';
import { Check } from 'typebox/value';
import { fetchOutputSchema, searchOutputSchema } from '../../src/tool-schemas.ts';
import { FetchService } from '../../src/fetch/service.js';

test('Unicode byte clipping and terminal control cleanup', async () => {
  assert.equal(clip('中😀文', 7, 10), '中😀');
  assert.equal(clip('a\nb\nc', 100, 2), 'a\nb');
  assert.equal((await toolOutput('a\u001b[31mb')).content[0]?.text, 'a[31mb');
});
test('long output is bounded and readable; POSIX mode is not a Windows ACL assertion', async () => {
  const text = ('中😀text\n').repeat(5000);
  const result = await toolOutput(text);
  assert.ok(result.details.truncated);
  assert.ok(result.details.fullOutputPath);
  try {
    assert.ok(Buffer.byteLength(result.content[0]!.text) <= MAX_INLINE_BYTES);
    assert.ok(result.content[0]!.text.split('\n').length <= MAX_INLINE_LINES);
    assert.equal(await readFile(result.details.fullOutputPath!, 'utf8'), text);
    // L12: shutdown must preserve the documented full-output path for later read calls.
    const service = new FetchService({ channel: 'chromium', timeoutMs: 1000, maxConcurrency: 1, idleTimeoutMs: 1000 });
    await service.close();
    assert.equal(await readFile(result.details.fullOutputPath!, 'utf8'), text);
    const file = await stat(result.details.fullOutputPath!);
    assert.ok(file.isFile());
    // Windows privacy depends on profile/temp DACLs, not Node's POSIX mode bits.
    if (process.platform !== 'win32') assert.equal(file.mode & 0o777, 0o600);
    assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= MAX_STRUCTURED_BYTES);
    assert.equal(result.structuredContent.fullOutputPath, result.details.fullOutputPath);
    assert.equal(result.structuredContent.text, result.content[0]!.text);
  } finally { await rm(dirname(result.details.fullOutputPath!), { recursive: true }); }
});

test('structured fetch and REST contracts are queryable, bounded, and preserve ordinary text', async () => {
  const page = { url: 'https://example.com/', finalUrl: 'https://example.com/page', title: 'Title', status: 200,
    fetchedAt: '2026-09-30T00:00:00Z', extraction: 'main', warnings: [], content: 'Body', contentTruncated: false };
  const fetched = await toolOutput('Rendered page', {}, page);
  assert.ok(Check(fetchOutputSchema, fetched.structuredContent));
  assert.equal(fetched.structuredContent.data!.content, 'Body');
  assert.equal(fetched.content[0]!.text, 'Rendered page');
  assert.equal(fetched.structuredContent.dataOmitted, false);
  const data = { provider: 'brave', query: 'fixture', results: [{ title: 'T', url: 'https://example.com/', snippet: 'S' }], warnings: [] };
  const searched = await toolOutput('Search result', {}, data);
  assert.ok(Check(searchOutputSchema, searched.structuredContent));
  assert.equal(searched.structuredContent.data!.results[0]!.url, 'https://example.com/');
  assert.ok(!Check(searchOutputSchema, { ...searched.structuredContent, data: { ...data, provider: 'openai' } }));
});

test('oversized structured data is omitted rather than bypassing output bounds, including escaping', async () => {
  const result = await toolOutput('"\\\\'.repeat(12000), {}, { results: ['中😀'.repeat(20000)] });
  try {
    assert.equal(result.structuredContent.data, undefined);
    assert.equal(result.structuredContent.dataOmitted, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= MAX_STRUCTURED_BYTES);
    assert.equal(result.structuredContent.text, result.content[0]!.text);
  } finally { if (result.details.fullOutputPath) await rm(dirname(result.details.fullOutputPath), { recursive: true }); }
});
