import assert from "node:assert/strict";
import test from "node:test";
import { providerSourcePolicy, sourcePolicy } from "../src/source-policy.ts";

test("domains are trimmed, blanks dropped, and kept bare", () => {
  assert.deepEqual(sourcePolicy({ include_domains: [" example.com ", "", "*.docs.rs"], exclude_domains: ["spam.example"] }), {
    include: ["example.com", "*.docs.rs"],
    exclude: ["spam.example"],
  });
  assert.deepEqual(sourcePolicy({}), { include: [], exclude: [] });
});

test("a URL, a path, or a space is not a bare domain", () => {
  for (const bad of ["https://example.com", "example.com/docs", "example com", "http://x"]) {
    assert.throws(() => sourcePolicy({ include_domains: [bad] }), /is not a bare domain \(write example\.com, not a URL\)/, bad);
    assert.throws(() => sourcePolicy({ exclude_domains: [bad] }), /is not a bare domain/, bad);
  }
});

test("both lists together take at most 200 entries", () => {
  const domains = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}.example`);
  assert.doesNotThrow(() => sourcePolicy({ include_domains: domains(100, "a"), exclude_domains: domains(100, "b") }));
  assert.throws(() => sourcePolicy({ include_domains: domains(101, "a"), exclude_domains: domains(100, "b") }), /at most 200 entries/);
});

test("after_date is a real calendar date", () => {
  assert.equal(sourcePolicy({ after_date: " 2026-01-31 " }).afterDate, "2026-01-31");
  for (const bad of ["2026-1-31", "31/01/2026", "2026-13-01", "yesterday"]) {
    assert.throws(() => sourcePolicy({ after_date: bad }), /after_date must be a calendar date in YYYY-MM-DD form/, bad);
  }
});

test("Parallel's source_policy shape omits what restricts nothing", () => {
  assert.equal(providerSourcePolicy(sourcePolicy({})), undefined);
  assert.deepEqual(providerSourcePolicy(sourcePolicy({ include_domains: ["a.example"], after_date: "2026-01-01" })), {
    after_date: "2026-01-01",
    include_domains: ["a.example"],
  });
});
