import { Agent, fetch as undiciFetch } from 'undici';

/**
 * fetch() with a short TCP connect timeout.
 * A stopped container's address often drops packets instead of refusing them, which would otherwise
 * stall each attempt for several seconds. UND_ERR_CONNECT_TIMEOUT is treated as "never delivered",
 * so it is safe to retry and maps to a fast 502.
 */
export function createFetch({ connectTimeoutMs }) {
  const dispatcher = new Agent({ connect: { timeout: connectTimeoutMs }, keepAliveTimeout: 30_000 });
  return (url, init = {}) => undiciFetch(url, { ...init, dispatcher });
}
