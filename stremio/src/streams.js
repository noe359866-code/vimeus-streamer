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
import { decideDelivery } from "./probe.js";
import { bump } from "./metrics.js";
import { upstreamSemaphore } from "./limits.js";

/* ------------------------------------------------------------------ */
/* Construcción de entradas para Stremio                               */
/* ------------------------------------------------------------------ */

function streamName(providerName) {
  return `${config.addonName}\n${providerName}`;
}

function buildHlsStream({ candidate, media, variant, title, baseUrl, delivery }) {
  const headers = {
    "User-Agent": config.userAgent,
    Referer: `${candidate.origin}/`,
    Origin: candidate.origin,
    ...media.headers,
  };

  const targetUrl = variant ? variant.uri : media.url;
  const quality = variant ? variant.label : media.quality || "Auto";

  const url = delivery.viaProxy
    ? buildProxyUrl(baseUrl, {
        url: targetUrl,
        headers,
        key: media.playlistKey || "",
        unwrap: media.unwrap === "flixcloud-hd2" ? "image" : media.unwrap || "",
      })
    : targetUrl;

  const details = [`${media.kind === "mp4" ? "MP4" : "HLS"} · ${quality}`];
  if (variant?.bandwidth) details.push(`${Math.round(variant.bandwidth / 1000)} kbps`);
  if (media.subtitles?.length) details.push(`${media.subtitles.length} subtítulo(s)`);
  if (!delivery.viaProxy) details.push("directo");

  const behaviorHints = { bingeGroup: `${candidate.bingeGroup}-${quality}` };

  if (delivery.viaProxy) {
    // Nuestro proxy ya inyecta Referer/Origin, sirve por HTTPS, añade CORS y
    // pone el Content-Type correcto: el stream ES reproducible en web.
    //
    // Marcarlo notWebReady aquí sería un error: Stremio 5 lo desviaría a su
    // conversor HLS local (/hlsv2) sin necesidad, y proxyHeaders se ignora
    // igualmente porque el cliente no es quien hace la petición al CDN.
  } else {
    // Entrega directa: aquí sí necesitamos que sea el cliente quien ponga las
    // cabeceras. proxyHeaders SOLO surte efecto con notWebReady: true.
    behaviorHints.notWebReady = true;
    behaviorHints.proxyHeaders = { request: headers };
  }

  const stream = {
    name: streamName(candidate.providerName),
    title: [title, `▶ ${details.join(" · ")}`].filter(Boolean).join("\n"),
    url,
    behaviorHints,
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
    const raw = await upstreamSemaphore.run(() =>
      fetchText(media.url, {
        timeoutMs,
        maxBytes: 2 * 1024 * 1024,
        headers: {
          Referer: `${candidate.origin}/`,
          Origin: candidate.origin,
          ...media.headers,
        },
      }),
    );
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

  bump("streamRequests");
  if (streamCache.get(cacheKey) !== undefined) {
    bump("streamCacheHits");
    return streamCache.get(cacheKey);
  }
  bump("streamCacheMisses");

  // wrap() agrupa las peticiones idénticas que llegan a la vez: si 500
  // usuarios abren el mismo estreno en el mismo segundo, el resolvedor
  // recibe UNA llamada, no 500.
  return streamCache.wrap(cacheKey, () => resolveStreams(parsed, type, ctx));
}

async function resolveStreams(parsed, type, ctx) {
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

    const proxyAvailable = config.proxyEnabled && Boolean(ctx.baseUrl);

    for (const { candidate, media } of resolved) {
      for (const item of media.slice(0, 4)) {
        const remaining = deadline - Date.now();

        // Una sola decisión por medio: todas sus calidades se entregan igual.
        const delivery = await decideDelivery(item, { proxyAvailable });
        log(
          "debug",
          `${candidate.provider}: ${delivery.viaProxy ? "por el proxy" : "directo"} ` +
            `(${delivery.reason})`,
        );

        const variants =
          remaining > 1200 ? await expandVariants(item, candidate, remaining) : [];
        const base = { candidate, media: item, title, baseUrl: ctx.baseUrl, delivery };

        if (variants.length > 1) {
          for (const variant of variants) {
            streams.push(buildHlsStream({ ...base, variant }));
          }
          // Una entrada "Auto" apuntando al maestro, para ABR.
          streams.push(
            buildHlsStream({ ...base, media: { ...item, quality: "Auto (ABR)" }, variant: null }),
          );
        } else {
          streams.push(buildHlsStream({ ...base, variant: null }));
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
  log(
    "info",
    `${streams.length} stream(s) para ${type}/${parsed.raw} ` +
      `(${streams.filter((s) => s.url).length} directos)`,
  );
  return payload;
}

export { qualityLabel };
