// The registry client.
//
// Mostly about failure: which failures are answers, which are outages, and
// whether a flood of callers becomes a flood of requests.
import assert from "node:assert/strict";
import test from "node:test";

import { createRegistry } from "../lib/index.mjs";

function stub(handler) {
  let calls = 0;
  const impl = async (url) => {
    calls++;
    const { status, body } = handler(String(url), calls);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { impl, calls: () => calls };
}

test("resolve returns what the registry said", async () => {
  const { impl } = stub(() => ({ status: 200, body: { name: "a.eggs", registered: true, target: "1.2.3.4" } }));
  const r = createRegistry({ fetchImpl: impl });
  assert.equal((await r.resolve("a.eggs")).target, "1.2.3.4");
});

test("a page of names is not a page of requests", async () => {
  const { impl, calls } = stub(() => ({ status: 200, body: { registered: true } }));
  const r = createRegistry({ fetchImpl: impl });

  await Promise.all(Array.from({ length: 25 }, () => r.resolve("a.eggs")));
  assert.equal(calls(), 1);
});

test("simultaneous lookups coalesce into one request", async () => {
  let release;
  const gate = new Promise((res) => (release = res));
  let calls = 0;
  const impl = async () => {
    calls++;
    await gate;
    return { ok: true, status: 200, json: async () => ({ registered: true }) };
  };

  const r = createRegistry({ fetchImpl: impl });
  const both = Promise.all([r.resolve("a.eggs"), r.resolve("a.eggs")]);
  release();
  await both;
  assert.equal(calls, 1, "a client retrying a lost query must not become two requests");
});

test("400 and 404 are answers, and are cached like one", async () => {
  for (const status of [400, 404]) {
    const { impl, calls } = stub(() => ({ status }));
    const r = createRegistry({ fetchImpl: impl });

    assert.equal(await r.resolve("nope.eggs"), null);
    assert.equal(await r.resolve("nope.eggs"), null);
    assert.equal(calls(), 1, `${status} is definite — asking again changes nothing`);
  }
});

test("an outage is not cached like an answer", async () => {
  // The distinction that matters: a definite no means stop, a 500 means the
  // registry is unwell and will be asked again shortly.
  let clock = 0;
  const { impl, calls } = stub(() => ({ status: 500 }));
  const r = createRegistry({ fetchImpl: impl, errorTtlMs: 100, ttlMs: 60_000, now: () => clock });

  assert.equal(await r.resolve("a.eggs"), null);
  clock = 50;
  await r.resolve("a.eggs");
  assert.equal(calls(), 1, "still inside the error window");
  clock = 200;
  await r.resolve("a.eggs");
  assert.equal(calls(), 2, "past it — ask again");
});

test("a thrown fetch is an outage, not a crash", async () => {
  const r = createRegistry({ fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(await r.resolve("a.eggs"), null);
  assert.equal(r.stats().errors, 1);
});

test("a timeout aborts rather than hanging a navigation", async () => {
  const impl = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const r = createRegistry({ fetchImpl: impl, timeoutMs: 20 });
  assert.equal(await r.resolve("a.eggs"), null);
});

test("pins: an empty list is no key published, not any key", async () => {
  const { impl } = stub(() => ({ status: 200, body: { pins: [] } }));
  const r = createRegistry({ fetchImpl: impl });
  assert.equal(await r.pins("a.eggs"), null);
});

test("pins: a kind narrows the request", async () => {
  let seen = "";
  const impl = async (url) => {
    seen = url;
    return { ok: true, status: 200, json: async () => ({ pins: ["AAAA"] }) };
  };
  const r = createRegistry({ fetchImpl: impl });
  await r.pins("a.eggs", "mtp");
  assert.match(seen, /kind=mtp/);
  assert.match(seen, /name=a\.eggs/);
});

test("pins of different kinds are cached apart", async () => {
  const { impl, calls } = stub(() => ({ status: 200, body: { pins: ["AAAA"] } }));
  const r = createRegistry({ fetchImpl: impl });

  await r.pins("a.eggs", "tls");
  await r.pins("a.eggs", "mtp");
  assert.equal(calls(), 2, "one kind's answer is not the other's");
});

test("tlds copes with either shape the registry returns", async () => {
  const objects = createRegistry({ fetchImpl: stub(() => ({ status: 200, body: { tlds: [{ tld: "eggs" }, { tld: "420" }] } })).impl });
  assert.deepEqual(await objects.tlds(), ["eggs", "420"]);

  const strings = createRegistry({ fetchImpl: stub(() => ({ status: 200, body: { tlds: ["eggs"] } })).impl });
  assert.deepEqual(await strings.tlds(), ["eggs"]);
});

test("names are normalised, so one name is one cache entry", async () => {
  const { impl, calls } = stub(() => ({ status: 200, body: { registered: true } }));
  const r = createRegistry({ fetchImpl: impl });

  await r.resolve("A.Eggs.");
  await r.resolve("a.eggs");
  assert.equal(calls(), 1);
});

test("the cache does not grow without bound", async () => {
  const { impl } = stub(() => ({ status: 200, body: { registered: true } }));
  const r = createRegistry({ fetchImpl: impl, maxEntries: 3 });

  for (let i = 0; i < 10; i++) await r.resolve(`n${i}.eggs`);
  assert.ok(r.stats().entries <= 3);
});
