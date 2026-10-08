/**
 * bench/curate.ts — offline verifier (and optional re-fetcher) for the frozen
 * gold packets in bench/gold.json.
 *
 * Usage:
 *   node bench/curate.ts            verify hashes, passage containment, completeness (offline)
 *   node bench/curate.ts --verify   same
 *   node bench/curate.ts --fetch    re-download official source URLs with plain fetch
 *                                   (no paid tools) and report hash drift vs the frozen files
 *
 * Verification checks:
 *   1. gold.json covers exactly the 12 primary IDs and 3 pilot IDs.
 *   2. Every required claim's sourceIds resolve to a declared source.
 *   3. Every official source file matches its frozen SHA-256.
 *   4. Every evidence passage is contained in its frozen source
 *      (HTML sources: tag-stripped, entity-unescaped, whitespace-normalized;
 *       JSON/fixture sources: verbatim substring).
 *   5. Every workspace fixture file matches its frozen SHA-256 and the
 *      workspace_files content declared in docs/benchmark-cases.json
 *      (single canonical copy => identical in both arms by construction).
 *   6. No selected fixture retains a "CURATOR:" placeholder.
 *   7. E2 artifact geometry: full-result.json >= 12000 chars, the Node.js 22
 *      end-of-life answer sits beyond character 9000, and the neutral receipt
 *      points at full-result.json without containing the answer.
 *   8. gold-sources/manifest.json agrees with gold.json source entries.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(BENCH);
const CASES_PATH = join(ROOT, 'docs', 'benchmark-cases.json');
const GOLD_PATH = join(BENCH, 'gold.json');
const MANIFEST_PATH = join(BENCH, 'gold-sources', 'manifest.json');

const PRIMARY_IDS = ['K1', 'D1', 'D3', 'S2', 'A1', 'A2', 'L1', 'L2', 'E2', 'P2', 'R1', 'R2'];
const PILOT_IDS = ['pilot-K', 'pilot-L', 'pilot-R'];

interface Source {
  id: string;
  kind: 'official_public_source' | 'workspace_fixture';
  url?: string;
  file?: string;
  path?: string;
  retrieved_utc?: string;
  sha256: string;
  bytes: number;
  passage_match: 'normalized_html_text' | 'verbatim';
  evidence_passages: string[];
}
interface GoldCase {
  sourceFamily: string;
  workspace_files?: Record<string, string>;
  requiredClaims: { id: string; text: string; sourceIds: string[] }[];
  sources: Source[];
  rubric: string;
}
interface Gold {
  schema_version: number;
  kind: string;
  visibility: string;
  generated_utc: string;
  retrieval: { method: string; paid_tools_used: boolean; window_utc: string[] };
  cases: Record<string, GoldCase>;
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Mirrors the normalization used to extract HTML passages at curation time. */
function normalizeHtml(s: string): string {
  let t = s.replace(/<[^>]+>/g, ' ');
  for (const [a, b] of [
    ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'],
    ['&#x27;', "'"], ['&#39;', "'"], ['&nbsp;', ' '], ['&mdash;', '—'],
  ] as const) t = t.split(a).join(b);
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/ ([,.;:!?])/g, '$1');
  return t.trim();
}

function fail(msg: string, errors: string[]) { errors.push(msg); }

function verify(): { errors: string[]; checks: number } {
  const errors: string[] = [];
  let checks = 0;
  const ok = (cond: boolean, msg: string) => { checks++; if (!cond) fail(msg, errors); };

  const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf8')) as Gold;
  const catalog = JSON.parse(readFileSync(CASES_PATH, 'utf8'));

  // 1. case coverage
  const ids = Object.keys(gold.cases).sort();
  const expected = [...PRIMARY_IDS, ...PILOT_IDS].sort();
  ok(JSON.stringify(ids) === JSON.stringify(expected),
    `gold cases ${JSON.stringify(ids)} != expected ${JSON.stringify(expected)}`);
  ok(gold.retrieval?.paid_tools_used === false, 'gold.retrieval.paid_tools_used must be false');

  const catalogById = new Map<string, any>();
  for (const c of catalog.case_catalog) catalogById.set(c.id, c);
  for (const c of catalog.pilot.cases) catalogById.set(c.id, c);

  for (const [cid, gc] of Object.entries(gold.cases)) {
    ok(Array.isArray(gc.requiredClaims) && gc.requiredClaims.length > 0, `${cid}: no requiredClaims`);
    ok(typeof gc.rubric === 'string' && gc.rubric.length > 40, `${cid}: rubric missing/thin`);
    ok(typeof gc.sourceFamily === 'string' && gc.sourceFamily.length > 0, `${cid}: sourceFamily missing`);
    const claimIds = new Set<string>();
    for (const cl of gc.requiredClaims) {
      ok(!claimIds.has(cl.id), `${cid}: duplicate claim id ${cl.id}`);
      claimIds.add(cl.id);
    }
    const sids = new Set(gc.sources.map((s) => s.id));
    // 2. claim -> source resolution
    for (const cl of gc.requiredClaims)
      for (const sid of cl.sourceIds)
        ok(sids.has(sid), `${cid}/${cl.id}: unknown sourceId ${sid}`);

    // 3/4. source hashes and passage containment
    for (const s of gc.sources) {
      const rel = s.kind === 'workspace_fixture' ? s.path! : s.file!;
      const abs = join(BENCH, rel);
      ok(existsSync(abs), `${cid}/${s.id}: missing file ${rel}`);
      if (!existsSync(abs)) continue;
      const buf = readFileSync(abs);
      ok(sha256(buf) === s.sha256, `${cid}/${s.id}: sha256 mismatch for ${rel}`);
      ok(buf.length === s.bytes, `${cid}/${s.id}: byte size mismatch for ${rel}`);
      const raw = buf.toString('utf8');
      const hay = s.passage_match === 'normalized_html_text' ? normalizeHtml(raw) : raw;
      for (const p of s.evidence_passages)
        ok(hay.includes(p), `${cid}/${s.id}: passage not contained in ${rel}: ${p.slice(0, 60)}…`);
    }

    // 5/6. fixtures match catalog workspace_files; no curator placeholders
    const catCase = catalogById.get(cid);
    if (catCase?.workspace_files) {
      for (const [name, content] of Object.entries(catCase.workspace_files as Record<string, string>)) {
        const fp = join(BENCH, 'fixtures', cid, name);
        if ((content as string).startsWith('CURATOR:')) {
          // curator-built fixture (E2): must exist on disk and contain no placeholder
          ok(existsSync(fp), `${cid}: curator fixture ${name} missing from bench/fixtures`);
          if (existsSync(fp))
            ok(!readFileSync(fp, 'utf8').includes('CURATOR:'), `${cid}: ${name} retains CURATOR placeholder`);
          continue;
        }
        ok(existsSync(fp), `${cid}: fixture ${name} missing from bench/fixtures`);
        if (existsSync(fp))
          ok(readFileSync(fp, 'utf8') === content, `${cid}: fixture ${name} differs from catalog workspace_files`);
      }
    }
    // fixture source entries point at real fixture files
    for (const s of gc.sources.filter((x) => x.kind === 'workspace_fixture'))
      ok(existsSync(join(BENCH, s.path!)), `${cid}: fixture source path missing ${s.path}`);
  }

  // 7. E2 geometry
  const full = readFileSync(join(BENCH, 'fixtures', 'E2', 'full-result.json'), 'utf8');
  const receipt = readFileSync(join(BENCH, 'fixtures', 'E2', 'receipt.json'), 'utf8');
  ok(full.length >= 12000, `E2 full-result.json has ${full.length} chars (< 12000)`);
  ok(full.indexOf('2027-04-30') > 9000, `E2 answer at char ${full.indexOf('2027-04-30')} (<= 9000)`);
  ok(full.includes('https://github.com/nodejs/Release/blob/main/schedule.json'),
    'E2 artifact lacks recorded official source URL');
  ok(!receipt.includes('2027-04-30') && !receipt.includes('2027'),
    'E2 receipt preview leaks the answer');
  ok(receipt.includes('full-result.json'), 'E2 receipt does not point to full-result.json');

  // 8. manifest agreement
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const mById = new Map<string, any>(manifest.sources.map((s: any) => [s.id, s]));
  const official = Object.values(gold.cases)
    .flatMap((c) => c.sources)
    .filter((s) => s.kind === 'official_public_source');
  for (const s of official) {
    const m = mById.get(s.id);
    ok(!!m, `manifest missing source ${s.id}`);
    if (m) {
      ok(m.sha256 === s.sha256, `manifest sha256 mismatch for ${s.id}`);
      ok(m.url === s.url, `manifest url mismatch for ${s.id}`);
    }
  }

  return { errors, checks };
}

async function fetchDrift(): Promise<void> {
  const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf8')) as Gold;
  const seen = new Map<string, Source>();
  for (const c of Object.values(gold.cases))
    for (const s of c.sources)
      if (s.kind === 'official_public_source') seen.set(s.id, s);
  for (const s of seen.values()) {
    const res = await fetch(s.url!);
    const buf = Buffer.from(await res.arrayBuffer());
    const h = sha256(buf);
    const status = res.ok ? (h === s.sha256 ? 'MATCH' : 'DRIFT') : `HTTP ${res.status}`;
    console.log(`${status.padEnd(8)} ${s.id.padEnd(32)} ${s.url}`);
  }
}

const mode = process.argv.includes('--fetch') ? 'fetch' : 'verify';
if (mode === 'fetch') {
  await fetchDrift();
} else {
  const { errors, checks } = verify();
  if (errors.length) {
    console.error(`FAIL: ${errors.length} problem(s) in ${checks} checks`);
    for (const e of errors) console.error(' -', e);
    process.exit(1);
  }
  console.log(`OK: ${checks} checks passed (hashes, passages, fixtures, E2 geometry, manifest)`);
}
