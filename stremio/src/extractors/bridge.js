/**
 * Puente hacia un resolvedor externo.
 *
 * Los tres proveedores cifran la resolución de sus streams (tokens sellados,
 * catálogos cifrados, claves rotativas en WASM). Ese trabajo lo hacen ya varios
 * proyectos de código abierto mantenidos activamente, así que en lugar de
 * duplicar — y tener que perseguir — esa criptografía, el addon puede delegar
 * en uno de ellos: tú despliegas el resolvedor y aquí pones su URL.
 *
 * El contrato es deliberadamente flexible porque cada proyecto devuelve una
 * forma distinta. Se aceptan, entre otras:
 *
 *   { "url": "https://.../master.m3u8" }
 *   { "sources": [ { "url": "...", "quality": "1080p", "type": "hls" } ] }
 *   { "data": { "sources": [ { "file": "..." } ] } }
 *   { "streams": [ { "url": "...", "headers": { "Referer": "..." } } ] }
 *
 * Y campos opcionales reconocidos: headers/referer, playlist_key/key, unwrap,
 * subtitles/tracks.
 */

import { config } from "./../config.js";
import { fetchJson, log } from "./../http.js";
import { streamCache } from "./../cache.js";

/** Sustituye los marcadores {tmdb}, {season}, … en la plantilla de URL. */
export function expandTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (full, name) => {
    const value = vars[name];
    if (value === undefined || value === null || value === "") return "";
    return encodeURIComponent(String(value));
  });
}

function pickArray(payload) {
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload.sources,
    payload.streams,
    payload.results,
    payload.data?.sources,
    payload.data?.streams,
    payload.data,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }
  // Una respuesta plana también vale si trae una URL reconocible.
  if (firstUrl(payload)) return [payload];
  return [];
}

function firstUrl(item) {
  if (!item || typeof item !== "object") return null;
  for (const key of ["url", "file", "link", "src", "stream", "playlist", "m3u8"]) {
    const value = item[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  }
  return null;
}

function normalizeHeaders(item, payload) {
  const headers = {};
  const sources = [payload?.headers, item?.headers, item?.requestHeaders];
  for (const source of sources) {
    if (source && typeof source === "object") Object.assign(headers, source);
  }
  const referer = item?.referer || item?.referrer || payload?.referer || payload?.referrer;
  if (typeof referer === "string" && referer) {
    headers.Referer = referer;
    try {
      headers.Origin = new URL(referer).origin;
    } catch {
      // Un referer malformado no debe tumbar la resolución.
    }
  }
  return headers;
}

function detectKind(url, item) {
  const declared = String(item?.type || item?.format || "").toLowerCase();
  if (declared.includes("hls") || declared.includes("m3u8")) return "hls";
  if (declared.includes("mp4")) return "mp4";
  if (/\.m3u8(\?|$)/i.test(url)) return "hls";
  if (/\.mp4(\?|$)/i.test(url)) return "mp4";
  return "hls";
}

function normalizeSubtitles(payload, item) {
  const raw = item?.subtitles || item?.tracks || payload?.subtitles || payload?.tracks;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const url = typeof entry === "string" ? entry : entry?.url || entry?.file || entry?.src;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
      const lang = entry?.lang || entry?.language || entry?.label || entry?.name || "und";
      return { url, lang: String(lang) };
    })
    .filter(Boolean);
}

/** Normaliza la respuesta del resolvedor a la forma que usa el addon. */
export function normalizeResolverPayload(payload) {
  const items = pickArray(payload);
  const out = [];

  for (const item of items) {
    const url = firstUrl(item);
    if (!url) continue;

    out.push({
      url,
      kind: detectKind(url, item),
      quality:
        item?.quality || item?.label || item?.resolution || item?.name || null,
      headers: normalizeHeaders(item, payload),
      // Clave para manifiestos ofuscados con Base64+XOR.
      playlistKey:
        item?.playlist_key || item?.playlistKey || item?.key || payload?.playlist_key || "",
      unwrap: item?.unwrap || payload?.unwrap || "",
      subtitles: normalizeSubtitles(payload, item),
    });
  }

  return out;
}

/** URL del resolvedor para un proveedor (específica o la global). */
export function resolverUrlFor(providerId) {
  return config.resolvers[providerId] || config.resolvers.default || "";
}

/**
 * Pide los streams al resolvedor externo.
 * @returns {Promise<Array>} lista normalizada (vacía si no hay resolvedor o falla)
 */
export async function resolveViaBridge(providerId, vars) {
  const template = resolverUrlFor(providerId);
  if (!template) return [];

  const url = expandTemplate(template, { provider: providerId, ...vars });
  if (!/^https?:\/\//i.test(url)) {
    log("warn", `RESOLVER_URL de ${providerId} no es una URL válida`);
    return [];
  }

  const cacheKey = `bridge:${url}`;
  const cached = streamCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const payload = await fetchJson(url, {
      timeoutMs: config.resolveTimeoutMs,
      headers: config.resolverToken
        ? { Authorization: `Bearer ${config.resolverToken}` }
        : undefined,
    });
    const normalized = normalizeResolverPayload(payload);
    log(
      normalized.length ? "info" : "debug",
      `resolvedor ${providerId}: ${normalized.length} fuente(s)`,
    );
    streamCache.set(cacheKey, normalized, normalized.length ? config.streamCacheTtlMs : 60_000);
    return normalized;
  } catch (error) {
    log("debug", `resolvedor ${providerId} falló: ${error.message}`);
    streamCache.set(cacheKey, [], 30_000);
    return [];
  }
}
