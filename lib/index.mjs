// The Moshpit registry, over HTTP.
//
// The registry is the only thing that knows which endings are claimed, which
// names exist, where they point, and what keys they may present. Every client
// in the stack has to ask it, and three of them had grown their own asker: the
// resolver bridge, the pinning proxy, and the browser extension. They agreed on
// the endpoints and disagreed on everything else — which failures are cacheable,
// whether two simultaneous lookups become one request, how long to wait.
//
// This is one asker, with the strictest of those behaviours:
//
//   - bounded timeouts, because this sits in front of navigation and a slow
//     registry must become a fast "no" rather than a hang
//   - a cache in front, so a page of names is not a page of requests
//   - coalesced lookups, so a client retrying a query it thinks was lost turns
//     into one request rather than N
//   - failures that return null instead of throwing, and are cached briefly, so
//     an outage is not amplified into a flood
//
// The distinction that matters most is between a definite no and an outage. A
// 400 or 404 is an answer — cacheable for as long as a real one. A timeout or a
// 500 is not, and a client that treats them alike either fails closed forever
// or fails open once, and the second is how a namespace gets quietly defeated.

export const DEFAULT_REGISTRY_BASE = "https://pit.moshcode.sh";

/** Long enough for a slow phone, short enough not to stall a navigation. */
export const DEFAULT_TIMEOUT_MS = 8000;

/** Keep batch queries useful without overwhelming a small registry. */
export const DEFAULT_CONCURRENCY = 8;

/** How long an answer is trusted. Names change hands; keys change rarely. */
export const DEFAULT_TTL_MS = 60_000;

/** How long a failure is remembered, so an outage is not amplified. */
export const DEFAULT_ERROR_TTL_MS = 5_000;

export function createRegistry({
  base = DEFAULT_REGISTRY_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttlMs = DEFAULT_TTL_MS,
  errorTtlMs = DEFAULT_ERROR_TTL_MS,
  maxEntries = 10_000,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const root = String(base).replace(/\/+$/, "");
  const cache = new Map();
  const inflight = new Map();
  const stats = { hits: 0, misses: 0, errors: 0 };
  let generation = 0;

  function remember(key, value, ttl) {
    // A non-positive bound disables storage without disabling the separate
    // in-flight map that coalesces simultaneous lookups.
    if (maxEntries <= 0) return;

    // Insertion-ordered Map, so the first key is the oldest — good enough
    // eviction for entries that all expire within minutes anyway.
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { value, expires: now() + ttl });
  }

  /**
   * One GET, with every failure mode folded into `null`.
   *
   * `definite` names the statuses that are answers rather than outages, so they
   * are cached for as long as a real answer would be.
   */
  async function ask(path, { definite = [400, 404] } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${root}${path}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (definite.includes(res.status)) return { value: null, ttl: ttlMs };
      if (!res.ok) throw new Error(`registry responded ${res.status}`);
      return { value: await res.json(), ttl: ttlMs };
    } catch {
      stats.errors++;
      return { value: null, ttl: errorTtlMs };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cached, coalesced GET. One request per key in flight, ever. */
  async function cached(key, path, options) {
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      stats.hits++;
      return hit.value;
    }
    stats.misses++;

    const existing = inflight.get(key);
    if (existing) return existing;

    const requestGeneration = generation;
    const promise = ask(path, options)
      .then(({ value, ttl }) => {
        if (requestGeneration === generation) remember(key, value, ttl);
        return value;
      })
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      });

    inflight.set(key, promise);
    return promise;
  }

  const clean = (name) => String(name ?? "").trim().toLowerCase().replace(/\.$/, "");

  return {
    /** Where a name points, and whether the pit has any authority over it. */
    async resolve(name) {
      const key = `resolve:${clean(name)}`;
      if (!clean(name)) return null;
      return cached(key, `/api/moshpit/resolve?name=${encodeURIComponent(clean(name))}`);
    },

    /**
     * The keys a name may present.
     *
     * `kind` narrows to a transport — `tls` for a certificate's SPKI, `mtp` for
     * an ML-DSA identity. Omitting it is safe rather than merely convenient: a
     * pin of the wrong kind can never match, since the hashes are over
     * different key types.
     */
    async pins(name, kind = null) {
      if (!clean(name)) return null;
      const query = `name=${encodeURIComponent(clean(name))}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`;
      const body = await cached(`pins:${clean(name)}:${kind || "*"}`, `/api/moshpit/pins?${query}`);
      const list = Array.isArray(body?.pins) ? body.pins.filter((p) => typeof p === "string" && p) : [];
      // An empty list is "no key published", which is a definite no — not a
      // reason to try again, and not permission to accept anything.
      return list.length ? { ...body, pins: list } : null;
    },

    /** Every ending claimed in the pit. */
    async tlds() {
      const body = await cached("tlds", "/api/moshpit/tlds");
      return Array.isArray(body?.tlds)
        ? body.tlds.map((t) => (typeof t === "string" ? t : t?.tld)).filter(Boolean)
        : [];
    },

    stats: () => ({ ...stats, entries: cache.size }),
    clear: () => { generation++; cache.clear(); inflight.clear(); },
  };
}
