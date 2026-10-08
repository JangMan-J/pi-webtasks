#!/usr/bin/env node
// Read-only snapshot of Parallel's public docs. No API key or paid API calls.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const origin = 'https://docs.parallel.ai';
const started = new Date().toISOString();
const directory = resolve(process.argv[2] ?? join(homedir(), '.cache', 'pi-parallelized', 'parallel-docs', started.replaceAll(':', '-')));
const manifest = { origin, started, finished: null, directory, concurrency: 4, resources: [] };
const queue = [];
const seen = new Set();
const bodies = new Map();
const accountSchema = 'https://api.parallel.ai/account/service/openapi.json';
const seeds = ['robots.txt', 'llms.txt', 'llms-full.txt', 'sitemap.xml', 'public-openapi.json', 'docs-latest-openapi.json', 'docs-legacy-openapi.json'];

function enqueue(raw, from) {
  let url;
  try { url = new URL(raw.replaceAll('&amp;', '&'), from === 'seed' ? origin : from); } catch { return; }
  if (url.origin !== origin && url.href !== accountSchema) return;
  let pathname;
  try { pathname = decodeURI(url.pathname); } catch { return; }
  if (url.search || /[{}<>\s]/.test(pathname)) return;
  url.hash = '';
  // Fetch document text, not HTML, assets, API endpoints, or application bundles.
  if (!/\.(md|json|xml|txt)$/.test(url.pathname)) {
    if (/\.[^/]+$/.test(url.pathname) || /^\/(?:_next|cdn-cgi|api)\//.test(url.pathname)) return;
    url.pathname = url.pathname === '/' ? '/index.md' : url.pathname.replace(/\/$/, '') + '.md';
  }
  if (seen.has(url.href)) return;
  if (seen.size >= 600) throw new Error('Discovery exceeded 600 resources; inspect links before widening the crawl.');
  seen.add(url.href);
  queue.push({ url: url.href, discovered_from: from });
}

function discover(text, url) {
  if (url.endsWith('.json')) return;
  // The combined export has no reliable base for relative links. Its Source
  // lines point to individual pages, where relative links can be resolved.
  if (url.endsWith('/llms-full.txt')) {
    for (const match of text.matchAll(/^Source:\s*(https:\/\/\S+)/gm)) enqueue(match[1], url);
    return;
  }
  // API reference Markdown names its spec in the YAML code-fence header.
  for (const match of text.matchAll(/(?:^|\s)(\/[\w./-]+openapi\.json)(?=\s|$)/gm)) enqueue(match[1], url);
  // Examples contain links to extracted third-party pages and placeholders.
  // These are data, not documentation navigation.
  text = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]+`/g, '');
  const links = [
    ...text.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g),
    ...text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g),
    ...text.matchAll(/(?:href|src)=["']([^"']+)["']/g),
  ];
  for (const match of links) {
    if (match[1].startsWith('#')) continue;
    enqueue(match[1], url);
  }
}

async function request(url) {
  const signal = AbortSignal.timeout(45_000);
  for (let redirects = 0; redirects <= 8; redirects++) {
    const response = await fetch(url, {
      signal,
      headers: { 'User-Agent': 'pi-parallelized-docs-snapshot', Accept: 'text/markdown, text/plain, application/json, application/xml' },
      redirect: 'manual',
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, final_url: url };
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect without Location');
    const destination = new URL(location, url);
    if (destination.origin !== origin) return { response, external_redirect: destination.href };
    url = destination.href;
  }
  throw new Error('More than eight redirects');
}

async function download(item) {
  const entry = { ...item, fetched_at: new Date().toISOString() };
  try {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await request(item.url);
        const { response } = result;
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
        await response.body?.cancel();
      } catch (error) {
        if (attempt === 2) throw error;
      }
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
    const { response, final_url, external_redirect } = result;
    entry.status = response.status;
    if (external_redirect) {
      entry.external_redirect = external_redirect;
      return;
    }
    entry.final_url = final_url;
    entry.content_type = response.headers.get('content-type');
    entry.etag = response.headers.get('etag');
    entry.last_modified = response.headers.get('last-modified');
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    if (!text.trim() || /^\s*(?:<!doctype html|<html)/i.test(text)) throw new Error('Expected text document; received empty content or HTML');
    if (item.url.endsWith('.json')) {
      const spec = JSON.parse(text);
      if (item.url.endsWith('openapi.json') && (!spec.openapi || !spec.paths)) throw new Error('Expected OpenAPI document');
    }
    const url = new URL(item.url);
    const path = url.origin === origin ? url.pathname.slice(1) : 'account-service-openapi.json';
    const target = resolve(directory, path);
    if (!target.startsWith(directory + '/')) throw new Error('Path escaped snapshot directory');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    Object.assign(entry, { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    bodies.set(item.url, text);
    discover(text, final_url);
  } catch (error) {
    entry.error = error.message;
  } finally {
    manifest.resources.push(entry);
  }
}

// Refuse to mix a new snapshot with an existing directory.
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory);
for (const seed of seeds) enqueue(`${origin}/${seed}`, 'seed');
enqueue(accountSchema, 'seed');
while (queue.length) {
  await Promise.all(queue.splice(0, manifest.concurrency).map(download));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
manifest.finished = new Date().toISOString();
manifest.resources.sort((a, b) => a.url.localeCompare(b.url));
const resources = new Map(manifest.resources.map(r => [r.url, r]));
const canonical = raw => {
  const url = new URL(raw);
  url.hash = '';
  return url.href.replace(/\.md$/, '').replace(/\/$/, '');
};
const indexed = [...(bodies.get(`${origin}/llms.txt`) ?? '').matchAll(/\]\((https:\/\/docs\.parallel\.ai\/[^)]+\.md)\)/g)].map(m => canonical(m[1]));
const sitemap = [...(bodies.get(`${origin}/sitemap.xml`) ?? '').matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)].map(m => canonical(m[1]));
const exported = [...(bodies.get(`${origin}/llms-full.txt`) ?? '').matchAll(/^Source:\s*(https:\/\/\S+)/gm)].map(m => canonical(m[1]));
const available = new Set(manifest.resources.filter(r => (r.path || r.external_redirect) && !r.error).map(r => canonical(r.url)));
manifest.coverage = Object.fromEntries(Object.entries({ index: indexed, sitemap, full_export: exported }).map(([name, urls]) => [name, {
  discovered: new Set(urls).size,
  missing: [...new Set(urls)].filter(url => !available.has(url)),
}]));
// Verify saved bytes, not just HTTP success, before claiming a usable snapshot.
for (const entry of manifest.resources.filter(r => r.path)) {
  const hash = createHash('sha256').update(await readFile(join(directory, entry.path))).digest('hex');
  if (hash !== entry.sha256) throw new Error(`Saved content hash mismatch: ${entry.path}`);
}
const failures = manifest.resources.filter(r => r.error);
manifest.summary = {
  saved: manifest.resources.filter(r => r.path).length,
  markdown_pages: manifest.resources.filter(r => r.path?.endsWith('.md')).length,
  bytes: manifest.resources.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
  failures: failures.map(({ url, error, discovered_from }) => ({ url, error, discovered_from })),
  external_redirects: manifest.resources.filter(r => r.external_redirect).map(({ url, external_redirect }) => ({ url, destination: external_redirect })),
};
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ directory, ...manifest.summary, coverage: manifest.coverage }, null, 2));
// Broken supplemental links remain recorded, but missing catalog pages or core
// resources make this snapshot incomplete and the command fail.
const incomplete = seeds.some(seed => !resources.get(`${origin}/${seed}`)?.path) || !resources.get(accountSchema)?.path ||
  Object.values(manifest.coverage).some(c => c.discovered === 0 || c.missing.length > 0);
if (incomplete) process.exitCode = 1;
