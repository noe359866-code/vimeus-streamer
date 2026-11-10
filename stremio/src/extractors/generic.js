/**
 * Extractor genérico.
 *
 * Recorre el HTML del reproductor y sus scripts del mismo origen buscando
 * enlaces de medios. Funciona con reproductores que dejan la fuente a la vista;
 * no sirve contra los que la cifran (que es el caso de los tres proveedores
 * configurados por defecto, de ahí el puente a un resolvedor externo).
 */

import { config } from "./../config.js";
import { fetchText, log } from "./../http.js";
import { streamCache } from "./../cache.js";

const MEDIA_RE = /https?:\/\/[^\s"'`<>\\)]+?\.(m3u8|mp4)(\?[^\s"'`<>\\)]*)?/gi;
const SCRIPT_SRC_RE = /<script[^>]+src=["']([^"']+)["']/gi;
const MAX_SCRIPTS = 4;
const JUNK_RE = /\b(ads?|advert|preroll|midroll|trailer|promo|sample|intro|logo)\b/i;

export function unescapeEmbedded(input) {
  return String(input)
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003a/gi, ":")
    .replace(/\\u002f/gi, "/")
    .replace(/\\x3a/gi, ":")
    .replace(/\\x2f/gi, "/")
    .replace(/\\x26/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/gi, "&")
    .replace(/&#x0*26;/gi, "&");
}

export function guessQuality(url) {
  const match = url.match(/(2160|1440|1080|720|480|360)\s*p?\b/i);
  if (match) return match[1] === "2160" ? "4K" : `${match[1]}p`;
  if (/\b4k|uhd\b/i.test(url)) return "4K";
  if (/master|index|playlist/i.test(url)) return "Auto";
  return null;
}

/** Busca URLs de medios dentro de un texto arbitrario. */
export function extractMediaUrls(text) {
  const normalized = unescapeEmbedded(text);
  const found = new Map();

  for (const match of normalized.matchAll(MEDIA_RE)) {
    const candidate = match[0].replace(/[),;\]}>'"]+$/g, "");
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (!/\.(m3u8|mp4)$/i.test(parsed.pathname)) continue;
    if (JUNK_RE.test(parsed.pathname)) continue;

    const href = parsed.toString();
    if (found.has(href)) continue;
    found.set(href, {
      url: href,
      kind: /\.m3u8$/i.test(parsed.pathname) ? "hls" : "mp4",
      quality: guessQuality(href),
      headers: {},
      playlistKey: "",
      unwrap: "",
      subtitles: [],
    });
  }

  return [...found.values()];
}

function absolutize(src, baseUrl) {
  try {
    return new URL(src, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Intenta extraer medios de una página de reproductor.
 * @param {{url:string, origin:string}} candidate
 */
export async function extractFromEmbed(candidate, { timeoutMs = config.resolveTimeoutMs } = {}) {
  const cacheKey = `generic:${candidate.url}`;
  const cached = streamCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const started = Date.now();
  const remaining = () => Math.max(400, timeoutMs - (Date.now() - started));

  const headers = {
    Referer: `${candidate.origin}/`,
    Origin: candidate.origin,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  try {
    const html = await fetchText(candidate.url, { headers, timeoutMs: remaining() });
    let media = extractMediaUrls(html);

    if (!media.length) {
      const scripts = [...html.matchAll(SCRIPT_SRC_RE)]
        .map((match) => absolutize(match[1], candidate.url))
        .filter((url) => url && url.startsWith(candidate.origin))
        .slice(0, MAX_SCRIPTS);

      for (const scriptUrl of scripts) {
        if (remaining() <= 500) break;
        try {
          const code = await fetchText(scriptUrl, {
            headers,
            timeoutMs: remaining(),
            maxBytes: 512 * 1024,
          });
          media = extractMediaUrls(code);
          if (media.length) break;
        } catch {
          // Un script que falla no invalida el intento completo.
        }
      }
    }

    // Las cabeceras del origen hacen falta para que el CDN no rechace.
    const withHeaders = media.map((item) => ({
      ...item,
      headers: { Referer: `${candidate.origin}/`, Origin: candidate.origin },
    }));

    streamCache.set(cacheKey, withHeaders, withHeaders.length ? config.streamCacheTtlMs : 60_000);
    return withHeaders;
  } catch (error) {
    log("debug", `extractor genérico falló en ${candidate.url}: ${error.message}`);
    streamCache.set(cacheKey, [], 60_000);
    return [];
  }
}
