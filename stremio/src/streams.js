/**
 * Orquestador: id de Stremio -> lista de streams HLS.
 *
 * Flujo:
 *   id -> proveedores -> candidatos (páginas de reproductor)
 *      -> extractores  -> medios (.m3u8 / .mp4)
 *      -> playlist maestra -> una entrada por calidad
 *      -> proxy firmado -> streams para Stremio
 */

import { config } from "./config.js";
import { streamCache } from "./cache.js";
import { parseStreamId, describeId, seasonEpisode } from "./ids.js";
import { resolveDisplayTitle, resolveTmdbId, resolveAnilistId } from "./meta.js";
import { activeProviders } from "./providers/index.js";
import { extractMedia } from "./extractors/index.js";
import { buildProxyUrl } from "./proxy.js";
import { fetchText, log } from "./http.js";
import { decryptManifest, parseMasterVariants, qualityLabel } from "./hls.js";

/* ------------------------------------------------------------------ */
/* Construcción de entradas para Stremio                               */
/* ------------------------------------------------------------------ */

function streamName(providerName) {
  return `${config.addonName}\n${providerName}`;
}

function buildHlsStream({ candidate, media, variant, title, baseUrl }) {
  const headers = {
    "User-Agent": config.userAgent,
    Referer: `${candidate.origin}/`,
    Origin: candidate.origin,
    ...media.headers,
  };

  const targetUrl = variant ? variant.uri : media.url;
  const quality = variant ? variant.label : media.quality || "Auto";

  // Sin proxy el CDN suele devolver 403 por falta de Referer, así que es la
  // ruta por defecto. proxyHeaders queda como respaldo para clientes que lo
  // respetan y prefieren ir directos.
  const url =
    config.proxyEnabled && baseUrl
      ? buildProxyUrl(baseUrl, {
          url: targetUrl,
          headers,
          key: media.playlistKey || "",
          unwrap: media.unwrap === "flixcloud-hd2" ? "image" : media.unwrap || "",
        })
      : targetUrl;

  const details = [`${media.kind === "mp4" ? "MP4" : "HLS"} · ${quality}`];
  if (variant?.bandwidth) {
    details.push(`${Math.round(variant.bandwidth / 1000)} kbps`);
  }
  if (media.subtitles?.length) {
    details.push(`${media.subtitles.length} subtítulo(s)`);
  }

  const stream = {
    name: streamName(candidate.providerName),
    title: [title, `▶ ${details.join(" · ")}`].filter(Boolean).join("\n"),
    url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: `${candidate.bingeGroup}-${quality}`,
      proxyHeaders: { request: headers },
    },
  };

  if (media.subtitles?.length) {
    stream.subtitles = media.subtitles.map((subtitle, index) => ({
      id: `${candidate.provider}-${index}`,
      url: subtitle.url,
      lang: subtitle.lang,
    }));
  }

  return stream;
}

function buildExternalStream(candidate, title) {
  return {
    name: streamName(candidate.providerName),
    title: [title, `🌐 Reproductor web · ${candidate.label}`].filter(Boolean).join("\n"),
    externalUrl: candidate.url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: `${candidate.bingeGroup}-web`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Expansión de la playlist maestra en calidades                       */
/* ------------------------------------------------------------------ */

/**
 * Abre el .m3u8 maestro y devuelve sus variantes. Si no es un maestro (o no se
 * puede leer) devuelve lista vacía y se usa la URL tal cual.
 */
async function expandVariants(media, candidate, timeoutMs) {
  if (media.kind !== "hls" || !config.expandQualities) return [];

  try {
    const raw = await fetchText(media.url, {
      timeoutMs,
      maxBytes: 2 * 1024 * 1024,
      headers: {
        Referer: `${candidate.origin}/`,
        Origin: candidate.origin,
        ...media.headers,
      },
    });
    const { text } = decryptManifest(raw, media.playlistKey || "");
    const variants = parseMasterVariants(text, media.url);
    if (variants.length > 1) {
      log("debug", `${candidate.provider}: ${variants.length} calidades detectadas`);
    }
    return variants;
  } catch (error) {
    log("debug", `no se pudo leer el maestro de ${candidate.provider}: ${error.message}`);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Entrada principal                                                   */
/* ------------------------------------------------------------------ */

export async function getStreams(type, rawId, ctx = {}) {
  const parsed = parseStreamId(type, rawId);
  if (!parsed) {
    log("debug", `id no reconocido: ${type}/${rawId}`);
    return { streams: [] };
  }

  const cacheKey = [
    "streams",
    parsed.type,
    parsed.raw,
    config.providers.join("+"),
    config.resolveDirect ? "hls" : "web",
    ctx.baseUrl || "",
  ].join(":");

  const cached = streamCache.get(cacheKey);
  if (cached) return cached;

  const providers = activeProviders();
  const title = await resolveDisplayTitle(parsed).catch(() => null);

  const candidateLists = await Promise.all(
    providers.map(async (provider) => {
      try {
        return await provider.getCandidates(parsed, { publicUrl: ctx.baseUrl });
      } catch (error) {
        log("warn", `${provider.id} falló para ${describeId(parsed)}: ${error.message}`);
        return [];
      }
    }),
  );

  const candidates = candidateLists.flat();
  if (!candidates.length) {
    log("info", `sin fuentes para ${type}/${parsed.raw}`);
    const empty = { streams: [] };
    streamCache.set(cacheKey, empty, 60_000);
    return empty;
  }

  const streams = [];

  if (config.resolveDirect) {
    // Variables disponibles para la plantilla del resolvedor externo.
    const { season, episode } = seasonEpisode(parsed);
    const [tmdbId, anilistId] = await Promise.all([
      resolveTmdbId(parsed).catch(() => null),
      resolveAnilistId(parsed).catch(() => null),
    ]);
    const vars = {
      type: parsed.type,
      tmdb: tmdbId || "",
      imdb: parsed.source === "imdb" ? parsed.id : "",
      anilist: anilistId || "",
      season: season || "",
      episode: episode || "",
      title: title || "",
    };

    const deadline = Date.now() + config.resolveTimeoutMs;

    const resolved = await Promise.all(
      candidates.map(async (candidate) => {
        const remaining = deadline - Date.now();
        if (remaining <= 600) return { candidate, media: [] };
        try {
          const media = await extractMedia(candidate, vars, { timeoutMs: remaining });
          return { candidate, media };
        } catch (error) {
          log("debug", `extracción falló en ${candidate.provider}: ${error.message}`);
          return { candidate, media: [] };
        }
      }),
    );

    for (const { candidate, media } of resolved) {
      for (const item of media.slice(0, 4)) {
        const remaining = deadline - Date.now();
        const variants =
          remaining > 1200 ? await expandVariants(item, candidate, remaining) : [];

        if (variants.length > 1) {
          for (const variant of variants) {
            streams.push(buildHlsStream({ candidate, media: item, variant, title, baseUrl: ctx.baseUrl }));
          }
          // Una entrada "Auto" apuntando al maestro, para ABR.
          streams.push(
            buildHlsStream({
              candidate,
              media: { ...item, quality: "Auto (ABR)" },
              variant: null,
              title,
              baseUrl: ctx.baseUrl,
            }),
          );
        } else {
          streams.push(buildHlsStream({ candidate, media: item, variant: null, title, baseUrl: ctx.baseUrl }));
        }
      }
    }
  }

  if (config.includeExternal || !streams.length) {
    for (const candidate of candidates) {
      streams.push(buildExternalStream(candidate, title));
    }
  }

  const payload = { streams };
  streamCache.set(cacheKey, payload);
  log(
    "info",
    `${streams.length} stream(s) para ${type}/${parsed.raw} ` +
      `(${streams.filter((s) => s.url).length} directos)`,
  );
  return payload;
}

export { qualityLabel };
