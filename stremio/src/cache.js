/**
 * Caché en memoria con TTL y límite de entradas (LRU aproximado).
 *
 * El plan gratuito de Render duerme el servicio, así que la caché solo sirve
 * para evitar llamadas repetidas dentro de una misma sesión activa. No hace
 * falta nada más pesado.
 */

import { config } from "./config.js";

export class TtlCache {
  constructor({ ttlMs = config.cacheTtlMs, maxEntries = config.cacheMaxEntries } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Reinsertar para que las claves usadas recientemente queden al final.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (ttlMs <= 0) return value;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    return value;
  }

  /** Memoiza una promesa evitando llamadas duplicadas en paralelo. */
  async wrap(key, producer, ttlMs = this.ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight?.get(key);
    if (pending) return pending;

    if (!this.inflight) this.inflight = new Map();
    const promise = (async () => {
      try {
        const value = await producer();
        if (value !== undefined) this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  get size() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
    this.inflight?.clear();
  }
}

export const metaCache = new TtlCache();
export const streamCache = new TtlCache({ ttlMs: config.streamCacheTtlMs, maxEntries: 500 });
