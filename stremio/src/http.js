/**
 * Utilidades de red: fetch con timeout, reintento suave y logging discreto.
 */

import { config } from "./config.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function log(level, ...args) {
  if ((LEVELS[level] ?? 2) <= (LEVELS[config.logLevel] ?? 2)) {
    const stamp = new Date().toISOString();
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](`[${stamp}] [${level}]`, ...args);
  }
}

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** fetch con AbortController para que nada se quede colgado. */
export async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = config.fetchTimeoutMs, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      ...rest,
      signal: controller.signal,
      headers: {
        "User-Agent": config.userAgent,
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        ...(rest.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    throw new HttpError(`GET ${url} -> ${response.status}`, response.status);
  }
  return response.json();
}

export async function fetchText(url, options = {}) {
  const { maxBytes = 2 * 1024 * 1024 } = options;
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    throw new HttpError(`GET ${url} -> ${response.status}`, response.status);
  }
  const text = await response.text();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

/** Devuelve null en vez de lanzar: para datos opcionales (metadatos, mapeos). */
export async function tryJson(url, options = {}) {
  try {
    return await fetchJson(url, options);
  } catch (error) {
    log("debug", `fallo opcional en ${url}:`, error.message);
    return null;
  }
}

/** Ejecuta promesas en paralelo con un presupuesto global de tiempo. */
export async function allSettledWithDeadline(tasks, deadlineMs) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve("__timeout__"), deadlineMs));
  return Promise.all(
    tasks.map(async (task) => {
      try {
        const result = await Promise.race([task, timeout]);
        if (result === "__timeout__") return { status: "timeout", value: null };
        return { status: "fulfilled", value: result };
      } catch (error) {
        return { status: "rejected", reason: error };
      }
    }),
  );
}
