import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../scripts/snapshot-docs.mjs', import.meta.url));
const fixture = String.raw`
  import { pathToFileURL } from 'node:url';
  const origin = 'https://docs.parallel.ai';
  const spec = JSON.stringify({ openapi: '3.1.0', paths: { '/v1/search': {} } });
  const pages = {
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/llms.txt': '[Page](' + origin + '/guide/page.md)\n[Alias](' + origin + '/old.md)\n[Status](' + origin + '/status.md)',
    '/llms-full.txt': '# Page\nSource: ' + origin + '/guide/page\n[Do not resolve here](wrong-relative-page)\n# Status\nSource: ' + origin + '/status',
    '/sitemap.xml': '<urlset><url><loc>' + origin + '/guide/page</loc></url></urlset>',
    '/public-openapi.json': spec,
    '/docs-latest-openapi.json': spec,
    '/docs-legacy-openapi.json': spec,
    '/guide/page.md': '# Page\n[Child](child)\n[JSON](/data.json)\n[Outside](https://example.com/no-fetch)\n' +
      '~~~md\n[Example](/not-a-page)\n~~~\nInline ' + String.fromCharCode(96) + '[Placeholder](url)' + String.fromCharCode(96),
    '/guide/child.md': '# Child',
    '/data.json': '{"data": true}',
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.href === 'https://api.parallel.ai/account/service/openapi.json') return new Response(spec);
    if (url.origin !== origin) throw new Error('Unexpected external request');
    if (url.pathname === '/old.md') return new Response(null, { status: 307, headers: { location: '/guide/page.md' } });
    if (url.pathname === '/status.md') return new Response(null, { status: 307, headers: { location: 'https://status.parallel.ai' } });
    if (process.env.SNAPSHOT_MISSING === '1' && url.pathname === '/guide/page.md') return new Response('missing', { status: 404 });
    return url.pathname in pages ? new Response(pages[url.pathname]) : new Response('not found', { status: 404 });
  };
  await import(pathToFileURL(process.argv[1]).href);
`;

// Run the real CLI, replacing only its HTTP transport. No live requests.
test('docs snapshot saves indexed pages, follows local redirects and records external redirects without crawling them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-docs-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'snapshot');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', fixture, script, directory], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.coverage.index, { discovered: 3, missing: [] });
  assert.deepEqual(manifest.summary.failures, []);
  assert.deepEqual(manifest.summary.external_redirects, [{ url: 'https://docs.parallel.ai/status.md', destination: 'https://status.parallel.ai/' }]);
  assert.ok(manifest.resources.some(r => r.path === 'guide/child.md'));
  assert.ok(manifest.resources.some(r => r.path === 'data.json'));
  assert.ok(manifest.resources.filter(r => r.path).every(r => /^[a-f0-9]{64}$/.test(r.sha256)));
  const repeat = spawnSync(process.execPath, ['--input-type=module', '-e', fixture, script, directory], { encoding: 'utf8' });
  assert.notEqual(repeat.status, 0);
  assert.match(repeat.stderr, /EEXIST/);
});

test('docs snapshot exits nonzero and names missing catalog pages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-docs-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'snapshot');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', fixture, script, directory], {
    encoding: 'utf8', env: { ...process.env, SNAPSHOT_MISSING: '1' },
  });
  assert.equal(run.status, 1, run.stderr + run.stdout);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.ok(manifest.coverage.index.missing.includes('https://docs.parallel.ai/guide/page'));
  assert.ok(manifest.summary.failures.some(r => r.error === 'HTTP 404'));
});
