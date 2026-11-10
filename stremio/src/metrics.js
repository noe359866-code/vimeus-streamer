/**
 * Contadores en memoria.
 *
 * Con 12.000 usuarios lo que de verdad hace falta saber es: cuánto acierta la
 * caché, cuántos bytes está retransmitiendo el proxy y si el resolvedor está
 * fallando. Todo eso sale por /health.
 */

export const metrics = {
  startedAt: Date.now(),
  streamRequests: 0,
  streamCacheHits: 0,
  streamCacheMisses: 0,
  resolverCalls: 0,
  resolverFailures: 0,
  proxyRequests: 0,
  proxyPlaylists: 0,
  proxySegments: 0,
  proxyBytes: 0,
  proxyRejected: 0,
  rateLimited: 0,
  errors: 0,
};

export function bump(key, amount = 1) {
  if (key in metrics) metrics[key] += amount;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function snapshot() {
  const total = metrics.streamCacheHits + metrics.streamCacheMisses;
  return {
    ...metrics,
    uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1000),
    cacheHitRate: total ? `${((metrics.streamCacheHits / total) * 100).toFixed(1)}%` : "n/d",
    proxyTraffic: formatBytes(metrics.proxyBytes),
  };
}
