import dns from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * DNS lookup with a short cache and stale-while-revalidate.
 *
 * Why: Docker's embedded DNS answers "no such name" for a STOPPED container only after a slow
 * upstream round trip (measured 2.7-3.5 s on the test machine) and handles lookups one after another.
 * Without a cache, every new connection resolves its host first, so while one dependency is down the
 * lookups for HEALTHY dependencies queue behind its slow failures, the connect timeout fires, and a
 * healthy service is reported as unreachable. With this cache:
 *   - a host that was resolved recently is answered instantly from memory (no resolver round trip);
 *   - an expired entry is still used immediately while a single background lookup refreshes it
 *     (so request latency never depends on resolver latency);
 *   - a failed refresh (e.g. the container is stopped) keeps the last known address, so the request
 *     fails fast on the TCP connect timeout instead of waiting for DNS.
 * The TTL is short so that a restarted container with a new address is picked up within seconds.
 */
export function createCachingLookup({ ttlMs = 2000, lookup = dns.lookup, now = Date.now } = {}) {
  const cache = new Map();
  const inflight = new Map();
  const keyOf = (host, o) => `${host}|${o.family ?? 0}|${o.all ? 1 : 0}`;

  const refresh = (host, opts, key) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = new Promise((resolve) => {
      lookup(host, opts, (err, address, family) => {
        if (!err) cache.set(key, { address, family, expires: now() + ttlMs });
        resolve({ err, address, family });
      });
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  return function cachingLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : { ...options };
    const key = keyOf(hostname, opts);
    const hit = cache.get(key);
    if (hit) {
      if (hit.expires <= now()) void refresh(hostname, opts, key);   // stale-while-revalidate
      process.nextTick(() => callback(null, hit.address, hit.family));
      return;
    }
    refresh(hostname, opts, key).then(({ err, address, family }) => callback(err, address, family));
  };
}

/**
 * fetch() with a short TCP connect timeout and cached DNS.
 * A stopped container's address often drops packets instead of refusing them, which would otherwise
 * stall each attempt for several seconds. UND_ERR_CONNECT_TIMEOUT is treated as "never delivered",
 * so it is safe to retry and maps to a fast 502.
 */
export function createFetch({ connectTimeoutMs, dnsTtlMs = 2000 }) {
  const dispatcher = new Agent({
    connect: { timeout: connectTimeoutMs, lookup: createCachingLookup({ ttlMs: dnsTtlMs }) },
    keepAliveTimeout: 30_000,
  });
  return (url, init = {}) => undiciFetch(url, { ...init, dispatcher });
}
