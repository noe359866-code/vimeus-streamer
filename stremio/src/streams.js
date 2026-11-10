/**
 * Orquestador: id de Stremio -> lista de streams.
 */

import { config } from "./config.js";
import { streamCache } from "./cache.js";
import { parseStreamId, describeId } from "./ids.js";
import { resolveDisplayTitle } from "./meta.js";
import { activeProviders } from "./providers/index.js";
import { resolveCandidate } from "./resolve.js";
import { buildProxyUrl } from "./proxy.js";
import { log } from "./http.js";

/** Construye el objeto `stream` que entiende Stremio. */
function toExternalStream(candidate, title) {
  return {
    name: `${config.addonName}\n${candidate.providerName}`,
    title: [title, `🌐 ${candidate.label}`, candidate.description]
      .filter(Boolean)
      .join("\n"),
    externalUrl: candidate.url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: candidate.bingeGroup,
    },
  };
}

function toDirectStream(candidate, media, title, baseUrl) {
  const headers = {
    Referer: `${candidate.origin}/`,
    Origin: candidate.origin,
    "User-Agent": config.userAgent,
  };

  const url =
    config.proxyEnabled && baseUrl
      ? buildProxyUrl(baseUrl, media.url, headers)
      : media.url;

  const quality = media.quality || "Auto";
  return {
    name: `${config.addonName}\n${candidate.providerName}`,
    title: [title, `▶️ ${quality} · ${media.kind.toUpperCase()}`, candidate.description]
      .filter(Boolean)
      .join("\n"),
    url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: candidate.bingeGroup,
      // Útil para los clientes que sí lo respetan y no usan el proxy.
      proxyHeaders: { request: headers },
    },
  };
}

/**
 * @param {"movie"|"series"|"anime"} type
 * @param {string} rawId
 * @param {{baseUrl?: string}} ctx
 */
export async function getStreams(type, rawId, ctx = {}) {
  const parsed = parseStreamId(type, rawId);
  if (!parsed) {
    log("debug", `id no reconocido: ${type}/${rawId}`);
    return { streams: [] };
  }

  const cacheKey = `streams:${parsed.type}:${parsed.raw}:${config.providers.join("+")}:${
    config.resolveDirect ? "d" : "e"
  }:${ctx.baseUrl || ""}`;
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
    const deadline = Date.now() + config.resolveTimeoutMs;
    const resolved = await Promise.all(
      candidates.map(async (candidate) => {
        const remaining = deadline - Date.now();
        if (remaining <= 500) return { candidate, media: [] };
        try {
          const media = await resolveCandidate(candidate, { timeoutMs: remaining });
          return { candidate, media };
        } catch {
          return { candidate, media: [] };
        }
      }),
    );

    for (const { candidate, media } of resolved) {
      for (const item of media.slice(0, 3)) {
        streams.push(toDirectStream(candidate, item, title, ctx.baseUrl));
      }
    }
  }

  // El enlace externo siempre se ofrece: es el que nunca falla.
  for (const candidate of candidates) {
    streams.push(toExternalStream(candidate, title));
  }

  const payload = { streams };
  streamCache.set(cacheKey, payload);
  log("info", `${streams.length} stream(s) para ${type}/${parsed.raw}`);
  return payload;
}
