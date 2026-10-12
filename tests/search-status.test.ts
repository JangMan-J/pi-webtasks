import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { SearchStatus, responseEstimate, webEstimate } from "../src/search-status.ts";

test("three result lanes animate only while busy and release their status on close", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const writes: (string | undefined)[] = [];
  const status = new SearchStatus(text => writes.push(text));
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   0   0");
  assert.equal(writes.at(-1), "\x1b[38;5;39m 0\x1b[0m  \x1b[38;5;141m 0\x1b[0m  \x1b[38;5;214m 0\x1b[0m  \x1b[38;5;82m 0\x1b[0m");

  const endWeb = status.begin("web");
  const endInteractive = status.begin("interactive");
  t.mock.timers.tick(120);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0⠙   0⠙   0   0⠙");
  status.add("web", 4, 1_000);
  status.add("interactive", 1, 10_000);
  endWeb();
  endInteractive();
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 4   1   0   0.01");

  status.setDeepPending(2);
  t.mock.timers.tick(120);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 4   1   0⠙   0.01⠙");
  status.deepReceived("research_a", "low", 3);
  status.deepReceived("research_a", "low", 3);
  status.setDeepPending(0);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 4   1   3   0.04");

  status.close();
  assert.equal(writes.at(-1), undefined);
  const count = writes.length;
  t.mock.timers.tick(240);
  assert.equal(writes.length, count);
});

test("estimates published Parallel list rates for each lane, not returned source count alone", () => {
  assert.equal(webEstimate("search", "low", 1, 10), 1_000);
  assert.equal(webEstimate("search", "medium", 1, 13), 8_000);
  assert.equal(webEstimate("search", "high", 1, 10), 5_000);
  assert.equal(webEstimate("extract", "low", 3, 2), 3_000);
  assert.equal(webEstimate("entity", "low", 1, 103), 5_150);
  assert.equal(responseEstimate("low"), 10_000);
  assert.equal(responseEstimate("medium"), 50_000);
  assert.equal(responseEstimate("high"), 250_000);
  const writes: (string | undefined)[] = [];
  const status = new SearchStatus(text => writes.push(text));
  status.deepReceived("mid", "medium", 3);
  status.deepReceived("high", "high", 2);
  status.deepReceived("high", "high", 2);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   5   0.70");
  status.add("web", 0, 300_000);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   5   1.00");
  assert.match(writes.at(-1)!, /\x1b\[38;5;82m 1\.00\x1b\[0m/);
  assert.doesNotMatch(writes.at(-1)!, /\$/);
  status.add("web", 0, 10_000);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   5   1.01");
  status.add("web", 0, 600_000);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   5   1.61");
  status.add("web", 0, 8_390_000);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   5   10");
  status.add("web", 0, 989_000_000);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   5   999");
  status.add("web", 0, 1_000_000);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   5   1K");
  status.close();
});

test("cost stays at 0 for sub-cent calls, then shows cents before whole dollars", () => {
  const writes: (string | undefined)[] = [];
  const status = new SearchStatus(text => writes.push(text));
  status.add("web", 0, 1_000);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   0   0");
  status.add("web", 0, 249_000);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   0   0.25");
  status.add("web", 0, 250_000);
  assert.equal(stripVTControlCharacters(writes.at(-1)!), " 0   0   0   0.50");
  status.close();
});

test("SDK processors without a known estimate mark the subtotal as incomplete", () => {
  let text: string | undefined;
  const status = new SearchStatus(value => { text = value; });
  status.deepReceived("known", "low", 2);
  status.deepReceived("custom", "custom", 4);
  status.deepReceived("custom", "custom", 4);
  assert.equal(stripVTControlCharacters(text!), " 0   0   6   0.03+?");
  status.close();
});
