/**
 * Controles de carga: semáforo, cortocircuito y límite por IP.
 *
 * Sin estas piezas, un pico de tráfico degrada el servicio de la peor manera:
 * miles de peticiones salientes a la vez, todas esperando el timeout completo
 * contra un origen que ya no responde, hasta agotar memoria.
 */

import { config } from "./config.js";
import { log } from "./http.js";

/* ------------------------------------------------------------------ */
/* Semáforo                                                            */
/* ------------------------------------------------------------------ */

export class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  /** Ejecuta `fn` ocupando una plaza del semáforo. */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get pending() {
    return this.queue.length;
  }
}

export const upstreamSemaphore = new Semaphore(config.maxConcurrentUpstream);

/* ------------------------------------------------------------------ */
/* Cortocircuito                                                       */
/* ------------------------------------------------------------------ */

export class CircuitBreaker {
  constructor({
    threshold = config.breakerThreshold,
    resetMs = config.breakerResetMs,
    name = "circuito",
  } = {}) {
    this.threshold = threshold;
    this.resetMs = resetMs;
    this.name = name;
    this.failures = 0;
    this.openedAt = 0;
  }

  /** ¿Se permite intentarlo ahora? */
  allow() {
    if (!this.openedAt) return true;
    if (Date.now() - this.openedAt >= this.resetMs) {
      // Medio abierto: dejamos pasar una petición de prueba.
      this.openedAt = 0;
      this.failures = this.threshold - 1;
      log("info", `${this.name}: reintentando tras el cortocircuito`);
      return true;
    }
    return false;
  }

  onSuccess() {
    this.failures = 0;
    this.openedAt = 0;
  }

  onFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold && !this.openedAt) {
      this.openedAt = Date.now();
      log(
        "warn",
        `${this.name}: abierto tras ${this.failures} fallos; ` +
          `en pausa ${Math.round(this.resetMs / 1000)}s`,
      );
    }
  }

  get isOpen() {
    return Boolean(this.openedAt) && Date.now() - this.openedAt < this.resetMs;
  }
}

const breakers = new Map();

export function breakerFor(name) {
  if (!breakers.has(name)) breakers.set(name, new CircuitBreaker({ name }));
  return breakers.get(name);
}

export function breakerStates() {
  const out = {};
  for (const [name, breaker] of breakers) {
    out[name] = breaker.isOpen ? "abierto" : "cerrado";
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Límite por IP                                                       */
/* ------------------------------------------------------------------ */

export class RateLimiter {
  constructor({ windowMs = config.rateLimitWindowMs, max = config.rateLimitMax } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.lastPrune = Date.now();
  }

  /** @returns {{allowed:boolean, retryAfter:number}} */
  check(key) {
    const now = Date.now();

    // Poda perezosa: evita que el Map crezca sin control.
    if (now - this.lastPrune > this.windowMs) {
      for (const [entryKey, entry] of this.hits) {
        if (now - entry.start > this.windowMs) this.hits.delete(entryKey);
      }
      this.lastPrune = now;
    }

    const entry = this.hits.get(key);
    if (!entry || now - entry.start > this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return { allowed: true, retryAfter: 0 };
    }

    entry.count += 1;
    if (entry.count > this.max) {
      return {
        allowed: false,
        retryAfter: Math.ceil((this.windowMs - (now - entry.start)) / 1000),
      };
    }
    return { allowed: true, retryAfter: 0 };
  }

  get size() {
    return this.hits.size;
  }
}

export const streamRateLimiter = new RateLimiter();

/** IP del cliente teniendo en cuenta el proxy de Render. */
export function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.socket?.remoteAddress || "desconocido";
}
