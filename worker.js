const VIEW_KEY_DEFAULT = "WPYQGojygcZENZk2bEPj7QzCQZOeDxYykIETbzZ2NUU";
const VIMEUS_ORIGIN = "https://vimeus.com";
const VIMEUS_REFERER = `${VIMEUS_ORIGIN}/`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const KODI_USER_AGENT = "Mozilla/5.0";
const CINEMETA_ORIGIN = "https://v3-cinemeta.strem.fun";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json; charset=utf-8",
};

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders },
  });
}

export default {
  async fetch(request, env = {}, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponse(
        { error: "Método no permitido" },
        405,
        { Allow: "GET, OPTIONS" },
      );
    }

    // Stremio manifest.
    if (url.pathname === "/manifest.json") {
      return jsonResponse({
        id: "com.vimeus.streamer",
        version: "1.0.0",
        name: "Vimeus Streamer",
        description: "Tu contenido favorito, directo a tu pantalla.",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: [],
      });
    }

    // Stremio: /stream/:type/:id.json
    const streamMatch = url.pathname.match(
      /^\/stream\/(movie|series)\/([^/]+)\.json$/,
    );
    if (streamMatch) {
      const [, type, encodedId] = streamMatch;
      let parsed;
      try {
        parsed = parseId(encodedId);
      } catch {
        return jsonResponse({ streams: [], error: "ID no válido" }, 400);
      }

      if (!hasMediaId(parsed)) {
        return jsonResponse({ streams: [], error: "Se requiere un ID IMDb o TMDb" }, 400);
      }

      const viewKey = env.VIEW_KEY || VIEW_KEY_DEFAULT;
      try {
        const embedUrl = buildEmbedUrl(type, parsed, viewKey);
        // The title lookup and Vimeus page fetch do not depend on one another.
        // Running them concurrently avoids adding the metadata round-trip to playback latency.
        const [titleName, hlsUrl] = await Promise.all([
          getMediaTitle(type, parsed),
          extractHlsUrl(embedUrl, env.PROXY_URL),
        ]);

        if (!hlsUrl) {
          return jsonResponse({ streams: [] });
        }

        return jsonResponse({
          streams: [
            {
              name: "Vimeus Streamer",
              title: formatDynamicTitle(titleName, type, parsed),
              url: hlsUrl,
              behaviorHints: {
                notSupported: false,
                requestHeaders: {
                  Referer: VIMEUS_REFERER,
                  "User-Agent": USER_AGENT,
                },
              },
            },
          ],
        });
      } catch (err) {
        return jsonResponse({ streams: [], error: errorMessage(err) });
      }
    }

    // Kodi: /kodi/stream?type=movie&imdb=tt... or ?type=series&tmdb=...&se=1&ep=1
    if (url.pathname === "/kodi/stream") {
      const type = url.searchParams.get("type") || "movie";
      if (type !== "movie" && type !== "series") {
        return jsonResponse({ error: "El tipo debe ser movie o series" }, 400);
      }

      const parsed = {
        imdb: url.searchParams.get("imdb"),
        tmdb: url.searchParams.get("tmdb"),
        season: url.searchParams.get("se"),
        episode: url.searchParams.get("ep"),
      };
      if (!hasMediaId(parsed)) {
        return jsonResponse({ error: "Se requiere un parámetro imdb o tmdb" }, 400);
      }

      const viewKey = env.VIEW_KEY || VIEW_KEY_DEFAULT;
      try {
        const embedUrl = buildEmbedUrl(type, parsed, viewKey);
        const [titleName, hlsUrl] = await Promise.all([
          getMediaTitle(type, parsed),
          extractHlsUrl(embedUrl, env.PROXY_URL),
        ]);

        if (!hlsUrl) {
          return jsonResponse({ error: "Stream no disponible" }, 404);
        }

        const kodiStreamUrl =
          `${hlsUrl}|Referer=${VIMEUS_REFERER}` +
          `&User-Agent=${KODI_USER_AGENT}`;

        return jsonResponse({
          title: formatDynamicTitle(titleName, type, parsed),
          url: kodiStreamUrl,
          raw_hls: hlsUrl,
        });
      } catch (err) {
        return jsonResponse({ error: errorMessage(err) }, 500);
      }
    }

    return new Response("Vimeus Streamer Engine Active", {
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  },
};

function hasMediaId(parsed) {
  return Boolean(parsed && (parsed.imdb || parsed.tmdb));
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

export async function getMediaTitle(type, parsed) {
  const id = parsed?.imdb || parsed?.tmdb;
  if (!id) return null;

  try {
    const mediaType = type === "movie" ? "movie" : "series";
    const metadataUrl =
      `${CINEMETA_ORIGIN}/meta/${mediaType}/` +
      `${encodeURIComponent(String(id))}.json`;
    const response = await fetch(metadataUrl, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return null;
    const data = await response.json();
    const name = data?.meta?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    // Metadata is optional; playback can still be returned with a generic title.
    return null;
  }
}

export function formatDynamicTitle(titleName, type, parsed = {}) {
  const name = titleName || (type === "movie" ? "Película" : "Contenido");
  if (type === "series" || parsed.season) {
    const season = parsed.season || "1";
    const episode = parsed.episode || "1";
    return `${name} T${season}-Cap${episode}`;
  }
  return `${name} • Full HD`;
}

export function parseId(idStr) {
  const decoded = decodeURIComponent(String(idStr));

  if (decoded.startsWith("tmdb:")) {
    const [, tmdb, season, episode] = decoded.split(":");
    return {
      tmdb: tmdb || null,
      season: season || null,
      episode: episode || null,
    };
  }

  if (decoded.startsWith("tt")) {
    const [imdb, season, episode] = decoded.split(":");
    return {
      imdb: imdb || null,
      season: season || null,
      episode: episode || null,
    };
  }

  return { imdb: decoded || null };
}

export function buildEmbedUrl(type, parsed, viewKey = VIEW_KEY_DEFAULT) {
  const endpoint = type === "movie" ? "movie" : "serie";
  const params = new URLSearchParams();

  if (parsed?.imdb) {
    params.set("imdb", String(parsed.imdb));
  } else if (parsed?.tmdb) {
    params.set("tmdb", String(parsed.tmdb));
  }

  if (type === "series" || parsed?.season) {
    if (parsed?.season) params.set("se", String(parsed.season));
    if (parsed?.episode) params.set("ep", String(parsed.episode));
  }

  params.set("view_key", String(viewKey));
  return `${VIMEUS_ORIGIN}/e/${endpoint}?${params.toString()}`;
}

export async function extractHlsUrl(embedUrl, proxyUrl) {
  const targetUrl = buildTargetUrl(embedUrl, proxyUrl);
  const response = await fetch(targetUrl, {
    method: "GET",
    headers: {
      Referer: VIMEUS_REFERER,
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Error en el servidor de reproducción (${response.status})`);
  }

  const html = await response.text();
  return findHlsUrl(html);
}

function buildTargetUrl(embedUrl, proxyUrl) {
  if (!proxyUrl) return embedUrl;

  const target = new URL(proxyUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("PROXY_URL debe usar HTTP o HTTPS");
  }
  target.searchParams.set("url", embedUrl);
  return target.toString();
}

function findHlsUrl(html) {
  // Vimeus pages may serialize player URLs in JavaScript or HTML attributes.
  const normalized = String(html)
    .replace(/\\u0026/gi, "&")
    .replace(/\\x26/gi, "&")
    .replace(/\\u003a/gi, ":")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/gi, "&")
    .replace(/&#x0*26;/gi, "&");
  const match = normalized.match(
    /https?:\/\/[^\s"'<>\\]+?\.m3u8(?:[?#][^\s"'<>\\]*)?/i,
  );
  if (!match) return null;

  const candidate = match[0].replace(/[),;\]}]+$/g, "");
  try {
    const parsedUrl = new URL(candidate);
    if (
      (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
      !/\.m3u8$/i.test(parsedUrl.pathname)
    ) {
      return null;
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
}
