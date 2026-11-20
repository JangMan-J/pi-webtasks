import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtractParams, ExtractResponse, SearchParams, SearchResult } from "parallel-web/resources";
import { ResearchStore } from "../src/store.ts";
import { createResearchService, type ResearchClient } from "../src/research-service.ts";
import { createRecallService } from "../src/recall.ts";
import { createAlertDelivery } from "../src/alert-delivery.ts";

type Call = { kind: "search" | "extract"; body: SearchParams | ExtractParams; options: { signal?: AbortSignal; maxRetries?: number; timeout?: number } | undefined };

function fakeClient(handlers: { search?: (body: SearchParams) => Promise<SearchResult>; extract?: (body: ExtractParams) => Promise<ExtractResponse> } = {}) {
  const calls: Call[] = [];
  const client: ResearchClient = {
    async search(body, options) {
      calls.push({ kind: "search", body, options });
      if (handlers.search) return handlers.search(body);
      return {
        search_id: `search_provider_${calls.length}`,
        session_id: "pss_1",
        results: [
          { url: "https://example.org/a", title: "Alpha", publish_date: "2026-01-02", excerpts: ["alpha fact one", "alpha fact two"] },
          { url: "https://example.org/b", title: "Beta", excerpts: ["beta fact"] },
        ],
      };
    },
    async extract(body, options) {
      calls.push({ kind: "extract", body, options });
      if (handlers.extract) return handlers.extract(body);
      return {
        extract_id: `extract_provider_${calls.length}`,
        session_id: "pss_1",
        results: [{ url: body.urls[0]!, title: "Alpha page", excerpts: ["excerpted text"], full_content: "full body text for alpha" }],
        errors: [],
      };
    },
  };
  return { client, calls };
}

async function harness(t: import("node:test").TestContext, handlers: Parameters<typeof fakeClient>[0] = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "research-core-"));
  const store = new ResearchStore(dir);
  await store.init();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const { client, calls } = fakeClient(handlers);
  const service = createResearchService({ store, sessionId: "s1", client: async () => client, clientModel: "test/model" });
  const recall = createRecallService({ store, sessionId: "s1", alerts: createAlertDelivery({ store, sessionId: "s1", deliver: () => undefined }) });
  const recallOther = createRecallService({ store, sessionId: "s2", alerts: createAlertDelivery({ store, sessionId: "s2", deliver: () => undefined }) });
  return { dir, store, service, recall, recallOther, calls };
}

test("a search sends objective, separate keyword queries, an explicit mode, and no retries", async t => {
  const h = await harness(t);
  const receipt = await h.service.search({
    objective: "Understand how advisory locks behave across database engines",
    search_queries: ["postgres advisory locks", "sqlite locking"],
    include_domains: ["example.org"],
    after_date: "2026-01-01",
    max_results: 5,
  }, { invocationId: "call-1" });

  assert.equal(h.calls.length, 1);
  const body = h.calls[0]!.body as SearchParams;
  assert.deepEqual(body.search_queries, ["postgres advisory locks", "sqlite locking"], "queries stay short and separate from the objective");
  assert.notEqual(body.search_queries[0], body.objective, "the objective is never copied into a keyword query");
  assert.equal(body.objective, "Understand how advisory locks behave across database engines");
  assert.equal(body.mode, "basic", "the default mode is sent explicitly");
  assert.equal(body.session_id, undefined, "an unrelated search starts a new provider context");
  assert.equal(h.calls[0]!.options?.maxRetries, 0, "a paid call is never retried by the SDK");
  assert.deepEqual(body.advanced_settings, {
    max_results: 5,
    source_policy: { after_date: "2026-01-01", include_domains: ["example.org"] },
  });

  assert.match(receipt.text, /2 sources/);
  assert.match(receipt.text, /ev_[0-9a-f]{16}/, "the receipt names readable handles");
  assert.doesNotMatch(receipt.text, /search_provider_1|pss_1/, "provider ids stay in the store");
  assert.equal(receipt.details.sources, 2);
  assert.equal(h.store.path.endsWith("research.sqlite"), true);

  const stored = await h.recall.recall({ query: "alpha fact" });
  assert.match(stored.text, /example\.org\/a/);
  assert.doesNotMatch(stored.text, /beta fact/);

  const run = await h.store.run("s1", String(receipt.details.reference));
  assert.equal(run?.kind, "search");
  assert.equal(run?.state, "completed");
  assert.equal(run?.provider_run_id, "search_provider_1");
  assert.equal(run?.provider_session_id, "pss_1");
});

test("a context handle keeps related calls in one provider session and never exposes its id", async t => {
  const h = await harness(t);
  const first = await h.service.search({ search_queries: ["first query"] }, { invocationId: "call-1" });
  const context = String(first.details.context);
  assert.match(context, /^run_[0-9a-f]{16}$/);

  await h.service.search({ search_queries: ["second query"], context }, { invocationId: "call-2" });
  await h.service.fetch({ urls: ["https://example.org/a"], context }, { invocationId: "call-3" });
  const bodies = h.calls.map(call => call.body as { session_id?: string });
  assert.equal(bodies[1]!.session_id, "pss_1", "the second search reuses the provider context");
  assert.equal(bodies[2]!.session_id, "pss_1", "an extract can share the same context");
  assert.doesNotMatch(first.text, /pss_1|search_provider_1/);

  await assert.rejects(
    () => h.service.search({ search_queries: ["third"], context: "run_0000000000000000" }, { invocationId: "call-4" }),
    /not a Search\/Extract context/,
  );
  assert.equal(h.calls.length, 3, "an unknown context makes no provider call");
});

test("invalid input is rejected before any paid call or local record", async t => {
  const h = await harness(t);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{}, /search_queries needs 1-3/],
    [{ objective: "a long objective only" }, /search_queries needs 1-3/],
    [{ search_queries: ["a", "b", "c", "d"] }, /at most 3/],
    [{ search_queries: ["a"], mode: "deep" }, /mode must be one of/],
    [{ search_queries: ["a"], include_domains: ["https://example.org"] }, /not a bare domain/],
    [{ search_queries: ["a"], after_date: "01/02/2026" }, /YYYY-MM-DD/],
    [{ search_queries: ["a"], max_results: 50 }, /max_results/],
  ];
  for (const [input, pattern] of bad) {
    await assert.rejects(() => h.service.search(input as never, { invocationId: `bad-${String((input as { search_queries?: unknown }).search_queries)}` }), pattern);
  }
  await assert.rejects(() => h.service.fetch({ urls: ["ftp://example.org/a"] }, { invocationId: "f1" }), /not an http\(s\) URL/);
  await assert.rejects(() => h.service.fetch({ urls: [] }, { invocationId: "f2" }), /at least one/);
  await assert.rejects(() => h.service.fetch({ urls: ["https://example.org/a"], max_age_seconds: 60 }, { invocationId: "f3" }), /at least 600/);

  assert.equal(h.calls.length, 0, "no provider call was made");
  assert.deepEqual(await h.store.listRuns("s1"), [], "no paid intent was recorded");
});

test("a replayed invocation returns stored evidence instead of paying twice", async t => {
  const h = await harness(t);
  const first = await h.service.search({ search_queries: ["alpha"] }, { invocationId: "call-1" });
  const replay = await h.service.search({ search_queries: ["alpha"] }, { invocationId: "call-1" });

  assert.equal(h.calls.length, 1, "the provider is called exactly once");
  assert.equal(replay.details.replayed, true);
  assert.equal(replay.details.reference, first.details.reference);
  assert.match(replay.text, /This search call was already sent as run_\w+ .*it is not sent again/)
  assert.match(replay.text, /not sent again/);
  assert.match(replay.text, /ev_[0-9a-f]{16}/, "the replay still surfaces readable handles");
  assert.equal((await h.store.listRuns("s1")).length, 1);

  const distinct = await h.service.search({ search_queries: ["alpha"] }, { invocationId: "call-2" });
  assert.equal(h.calls.length, 2, "a deliberate new investigation is a new call");
  assert.equal(distinct.details.replayed, undefined);
});

// Failed-versus-uncertain settlement is the recorded paid call's rule (tests/paid-call.test.ts).
// These check only that search and fetch go through it under their own names.
test("a failed search or fetch settles its record under the tool's name", async t => {
  const h = await harness(t, {
    search: async () => { throw Object.assign(new Error("invalid request"), { status: 400, name: "BadRequestError" }); },
    extract: async () => { throw Object.assign(new Error("socket hang up"), { name: "APIConnectionError" }); },
  });
  await assert.rejects(() => h.service.search({ search_queries: ["alpha"] }, { invocationId: "call-1" }), /Search did not complete: invalid request\. Record run_/);
  await assert.rejects(() => h.service.fetch({ urls: ["https://example.org/a"] }, { invocationId: "call-2" }), /Fetch did not complete: socket hang up\. Its outcome is unknown/);
  const runs = await h.store.listRuns("s1");
  assert.deepEqual(runs.map(run => [run.kind, run.state]).sort(), [["extract", "uncertain"], ["search", "failed"]]);
});

test("extract stores per-URL content and reports failures without inventing evidence", async t => {
  const h = await harness(t, {
    extract: async (body) => ({
      extract_id: "extract_2",
      session_id: "pss_2",
      results: [
        { url: body.urls[0]!, title: "Alpha page", excerpts: ["short excerpt"], full_content: "the complete alpha body" },
        { url: body.urls[1]!, title: "Empty page", excerpts: [] },
      ],
      errors: [{ url: body.urls[2]!, error_type: "http_error", http_status_code: 404, content: "not found" }],
    }),
  });
  const receipt = await h.service.fetch({
    urls: ["https://example.org/a", "https://example.org/empty", "https://example.org/missing"],
    full_content: true,
    max_age_seconds: 900,
  }, { invocationId: "call-1" });

  const body = h.calls[0]!.body as ExtractParams;
  assert.deepEqual(body.advanced_settings, { fetch_policy: { max_age_seconds: 900 }, full_content: true });
  assert.match(receipt.text, /Read 2 of 3 URLs/);
  assert.match(receipt.text, /http_error \(HTTP 404\)/);
  assert.match(receipt.text, /no content was returned/);
  assert.equal(receipt.details.saved, 1, "only the URL with content becomes evidence");
  assert.match(receipt.text, /Empty page — https:\/\/example\.org\/empty \(0 chars stored\)\n  no content was returned/, "the empty URL gets no handle");
  assert.match(receipt.text, /Alpha page — https:\/\/example\.org\/a \([\d,]+ chars stored\)\n  ev_[0-9a-f]{16}: /, "the handle sits under the URL it was read from");

  const stored = await h.recall.recall({ query: "complete alpha body" });
  assert.match(stored.text, /ev_[0-9a-f]{16}/);
  assert.match(stored.text, /source/, "full content is stored as source evidence");
  const handle = String(stored.details.handles[0]);
  const read = await h.recall.recall({ handle });
  assert.match(read.text, /the complete alpha body/);
  assert.match(read.text, /End of stored text\./);

  const dup = await h.store.listRuns("s1");
  assert.equal(dup[0]!.kind, "extract");
  assert.equal(dup[0]!.provider_run_id, "extract_2");
});

test("receipts stay bounded even with many long sources", async t => {
  const sources = Array.from({ length: 20 }, (_, index) => ({
    url: `https://example.org/${index}`,
    title: `Source ${index}`,
    excerpts: [("filler text about the topic. ".repeat(40)).trim()],
  }));
  const h = await harness(t, {
    search: async () => ({ search_id: "search_many", session_id: "pss_many", results: sources }),
  });
  const receipt = await h.service.search({ search_queries: ["bounded"] }, { invocationId: "call-1" });
  assert.ok(receipt.text.length <= 4300, `receipt must stay bounded, got ${receipt.text.length}`);
  assert.match(receipt.text, /further lines omitted; the sources are all stored and searchable/);
  assert.match(receipt.text, /all stored and searchable/);
  assert.equal(receipt.details.saved, 20, "every source is stored even when the receipt truncates");

  const all = await h.recall.recall({ reference: String(receipt.details.reference), limit: 20 });
  assert.equal(all.details.hits, 20);
});

test("recall searches, pages, filters by kind, and reads bounded slices", async t => {
  const h = await harness(t);
  await h.service.search({ search_queries: ["alpha"] }, { invocationId: "call-1" });

  const page = await h.recall.recall({ query: "fact", limit: 1 });
  assert.equal(page.details.hits, 1);
  assert.equal(page.details.more, true);
  assert.match(page.text, /More results: web_recall \{ cursor:/);

  const second = await h.recall.recall({ query: "fact", limit: 1, cursor: String(page.details.cursor) });
  assert.equal(second.details.hits, 1);
  assert.notDeepEqual(second.details.handles, page.details.handles);

  // The receipt advertises `web_recall { cursor }`: a cursor alone continues the same search.
  const cursorOnly = await h.recall.recall({ limit: 1, cursor: String(page.details.cursor) });
  assert.deepEqual(cursorOnly.details.handles, second.details.handles);

  const wrongKind = await h.recall.recall({ query: "fact", kinds: ["report"] });
  assert.match(wrongKind.text, /No stored evidence matches/);

  const handle = String(page.details.handles[0]);
  const slice = await h.recall.recall({ handle, offset: 2, max_chars: 500 });
  assert.equal(slice.details.offset, 2);
  assert.equal(slice.details.chars, Number(slice.details.total_chars) - 2, "the slice starts at the requested offset and runs to the end");
  assert.equal(slice.details.truncated_before, true);
  assert.equal(slice.details.truncated_after, false);
  assert.match(slice.text, /Stored text: \d+ chars; showing 2–/);
  assert.match(slice.text, /End of stored text\./);

  await assert.rejects(() => h.recall.recall({ handle, query: "fact" }), /not both/);
  await assert.rejects(() => h.recall.recall({}), /Pass handle to read/);
  await assert.rejects(() => h.recall.recall({ query: "fact", offset: 2 }), /offset applies only/);
  const crossHandle = await h.recallOther.recall({ handle });
  assert.match(crossHandle.text, new RegExp(handle));
  const foreignSearch = await h.service.search({ search_queries: ["alpha"] }, { invocationId: "call-2" });
  const crossRef = await h.recallOther.recall({ reference: String(foreignSearch.details.reference) });
  assert.equal(crossRef.details.hits, 2);
  await assert.rejects(() => h.recallOther.recall({ handle: "ev_0000000000000000" }), /No evidence/);
  const missingReference = await h.recallOther.recall({ reference: String(page.details.handles[0]) });
  assert.match(missingReference.text, /No stored evidence matches/);
});

test("recall cannot see another session's evidence", async t => {
  const h = await harness(t);
  await h.service.search({ search_queries: ["alpha"] }, { invocationId: "call-1" });
  const other = await h.recallOther.recall({ query: "alpha" });
  assert.match(other.text, /No stored evidence matches/);
  assert.equal(other.details.hits, 0);
});

test("recall supports cross-session time-range queries, listing, pagination, and validation", async t => {
  const dir = await mkdtemp(resolve(tmpdir(), "research-time-"));
  let now = Date.UTC(2026, 2, 10, 12, 0, 0); // 2026-03-10T12:00:00Z
  const store = new ResearchStore(dir, { now: () => now });
  await store.init();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });

  const recallS1 = createRecallService({ store, sessionId: "s1", alerts: createAlertDelivery({ store, sessionId: "s1", deliver: () => undefined }) });
  const recallS2 = createRecallService({ store, sessionId: "s2", alerts: createAlertDelivery({ store, sessionId: "s2", deliver: () => undefined }) });

  const seed = async (sessionId: string, intentKey: string, at: number, title: string, body: string) => {
    now = at;
    const { reference } = await store.beginRun({ sessionId, intentKey, intent: { title }, kind: "search" });
    const completed = await store.completeRun({
      sessionId,
      reference,
      state: "completed",
      evidence: [{ kind: "excerpt", origin: "provider_source", title, body }],
    });
    return { reference, handle: completed.evidence[0]!.handle };
  };

  // Seed evidence across s1 and s2 at various ages relative to 2026-03-10T12:00:00Z
  const t35d = Date.UTC(2026, 1, 3, 12, 0, 0);  // 35 days ago
  const t10d = Date.UTC(2026, 1, 28, 12, 0, 0); // 10 days ago
  const t3d = Date.UTC(2026, 2, 7, 12, 0, 0);   // 3 days ago
  const t12h = Date.UTC(2026, 2, 10, 0, 0, 0);  // 12 hours ago
  const t30m = Date.UTC(2026, 2, 10, 11, 30, 0); // 30 minutes ago

  const rOld = await seed("s1", "k-old", t35d, "Old s1", "sharedtopic from 35 days ago");
  await seed("s2", "k-10d", t10d, "TenDays s2", "sharedtopic from 10 days ago");
  await seed("s1", "k-3d", t3d, "ThreeDays s1", "sharedtopic from 3 days ago");
  await seed("s2", "k-12h", t12h, "TwelveHours s2", "sharedtopic from 12 hours ago");
  await seed("s2", "k-30m", t30m, "ThirtyMins s2", "sharedtopic from 30 minutes ago");

  // Reset clock to anchor time
  now = Date.UTC(2026, 2, 10, 12, 0, 0);

  // store.run with crossSession
  assert.equal(await store.run("s2", rOld.reference), undefined);
  const crossRun = await store.run("s2", rOld.reference, { crossSession: true });
  assert.equal(crossRun?.reference, rOld.reference);
  assert.equal(crossRun?.session_id, "s1");

  // within: "1h", "24h", "7d", "30d", "all", "session"
  const w1h = await recallS1.recall({ within: "1h" });
  assert.equal(w1h.details.hits, 1);
  assert.match(w1h.text, /ThirtyMins s2/);

  const w24h = await recallS1.recall({ within: "24h" });
  assert.equal(w24h.details.hits, 2);
  assert.match(w24h.text, /ThirtyMins s2[\s\S]*TwelveHours s2/);

  const w7d = await recallS1.recall({ within: "7d" });
  assert.equal(w7d.details.hits, 3);

  const w30d = await recallS1.recall({ within: "30d" });
  assert.equal(w30d.details.hits, 4);

  const wAll = await recallS1.recall({ within: "all" });
  assert.equal(wAll.details.hits, 5);
  assert.match(wAll.text, /ThirtyMins s2[\s\S]*Old s1/);

  const wSession = await recallS1.recall({ within: "session" });
  assert.equal(wSession.details.hits, 2);
  assert.match(wSession.text, /ThreeDays s1[\s\S]*Old s1/);
  assert.doesNotMatch(wSession.text, /TwelveHours s2/);

  // since / until with YYYY-MM-DD and ISO-8601
  const byDate = await recallS1.recall({ since: "2026-02-28", until: "2026-03-07" });
  assert.equal(byDate.details.hits, 2);
  assert.match(byDate.text, /ThreeDays s1[\s\S]*TenDays s2/);

  const byIso = await recallS2.recall({ since: "2026-03-10T00:00:00Z", until: "2026-03-10T11:45:00Z" });
  assert.equal(byIso.details.hits, 2);

  // within: "session" + since honors session scoping and time bound
  const sessionSince = await recallS1.recall({ within: "session", since: "2026-03-01" });
  assert.equal(sessionSince.details.hits, 1);
  assert.match(sessionSince.text, /ThreeDays s1/);

  // Cursor pagination preserves cross-session and time-range bounds
  const page1 = await recallS1.recall({ query: "sharedtopic", within: "30d", limit: 2 });
  assert.equal(page1.details.hits, 2);
  assert.equal(page1.details.more, true);
  const page2 = await recallS1.recall({ cursor: String(page1.details.cursor), limit: 2 });
  assert.equal(page2.details.hits, 2);
  assert.equal(page2.details.more, false);
  const allHandles = [...(page1.details.handles as string[]), ...(page2.details.handles as string[])];
  assert.equal(new Set(allHandles).size, 4);

  // Validation errors
  await assert.rejects(() => recallS1.recall({ within: "bogus" }), /Invalid within/);
  await assert.rejects(() => recallS1.recall({ since: "2026-02-30" }), /Invalid since/);
  await assert.rejects(() => recallS1.recall({ until: "not-a-date" }), /Invalid until/);
  await assert.rejects(() => recallS1.recall({ within: "24h", since: "2026-03-01" }), /Pass either within or since, not both/);
  await assert.rejects(() => recallS1.recall({ since: "2026-03-10", until: "2026-03-01" }), /since must not be later than until/);
  await assert.rejects(() => recallS1.recall({ handle: rOld.handle, within: "24h" }), /not both/);
});
