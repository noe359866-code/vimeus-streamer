/**
 * Resolución directa (best effort).
 *
 * Los tres sitios entregan reproductores HTML, no ficheros de vídeo. Cuando
 * RESOLVE_DIRECT está activo intentamos localizar un .m3u8/.mp4 dentro del
 * HTML o de sus scripts para poder reproducir dentro de Stremio.
 *
 * Es un intento, no una garantía: si no se encuentra nada, el addon sigue
 * ofreciendo el enlace externo, que siempre funciona.
 */

import { config } from "./config.js";
import { streamCache } from "./cache.js";
import { fetchText, log } from "./http.js";

const MEDIA_RE = /https?:\/\/[^\s"'`<>\\)]+?\.(m3u8|mp4)(\?[^\s"'`<>\\)]*)?/gi;
const SCRIPT_SRC_RE = /<script[^>]+src=["']([^"']+)["']/gi;
const MAX_SCRIPTS = 4;

/** Deshace los escapes típicos de JSON/JS embebido en HTML. */
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

/** Extrae URLs de medios válidas de un texto arbitrario. */
export function extractMediaUrls(text) {
  const normalized = unescapeEmbedded(text);
  const found = new Map();

  for (const match of normalized.matchAll(MEDIA_RE)) {
    const candidate = match[0].replace(/[),;\]}>'"]+$/g, "");
    let parsedUrl;
    try {
      parsedUrl = new URL(candidate);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") continue;
    if (!/\.(m3u8|mp4)$/i.test(parsedUrl.pathname)) continue;
    // Los reproductores suelen incluir anuncios o trailers; los descartamos.
    if (/\b(ads?|advert|preroll|trailer|promo|sample)\b/i.test(parsedUrl.pathname)) continue;

    const href = parsedUrl.toString();
    if (!found.has(href)) {
      found.set(href, {
        url: href,
        kind: /\.m3u8$/i.test(parsedUrl.pathname) ? "hls" : "mp4",
        quality: guessQuality(href),
      });
    }
  }

  return [...found.values()];
}

function guessQuality(url) {
  const match = url.match(/(2160|1440|1080|720|480|360)\s*p?/i);
  if (match) return `${match[1]}p`;
  if (/\b4k|uhd\b/i.test(url)) return "2160p";
  if (/master|index|playlist/i.test(url)) return "Auto";
  return null;
}

function absolutize(src, baseUrl) {
  try {
    return new URL(src, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Intenta resolver un candidato a enlace reproducible.
 * @returns {Promise<Array<{url:string,kind:string,quality:string|null}>>}
 */
export async function resolveCandidate(candidate, { timeoutMs = config.resolveTimeoutMs } = {}) {
  const cacheKey = `resolve:${candidate.url}`;
  const cached = streamCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const started = Date.now();
  const remaining = () => Math.max(500, timeoutMs - (Date.now() - started));

  const headers = {
    Referer: `${candidate.origin}/`,
    Origin: candidate.origin,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  try {
    const html = await fetchText(candidate.url, { headers, timeoutMs: remaining() });
    let media = extractMediaUrls(html);

    if (!media.length) {
      // Los reproductores modernos cargan las fuentes desde un bundle JS.
      const scripts = [...html.matchAll(SCRIPT_SRC_RE)]
        .map((match) => absolutize(match[1], candidate.url))
        .filter((url) => url && url.startsWith(candidate.origin))
        .slice(0, MAX_SCRIPTS);

      for (const scriptUrl of scripts) {
        if (remaining() <= 600) break;
        try {
          const code = await fetchText(scriptUrl, {
            headers,
            timeoutMs: remaining(),
            maxBytes: 512 * 1024,
          });
          media = extractMediaUrls(code);
          if (media.length) break;
        } catch {
          // Un script que falla no invalida el resto del intento.
        }
      }
    }

    streamCache.set(cacheKey, media, media.length ? config.streamCacheTtlMs : 60_000);
    return media;
  } catch (error) {
    log("debug", `no se pudo resolver ${candidate.url}: ${error.message}`);
    streamCache.set(cacheKey, [], 60_000);
    return [];
  }
}
