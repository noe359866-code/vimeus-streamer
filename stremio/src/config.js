/**
 * Configuración central del addon.
 *
 * Todo se controla con variables de entorno para que el mismo build sirva en
 * local y en Render sin tocar código.
 */

import crypto from "node:crypto";

function bool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|y|on|si|sí)$/i.test(String(value).trim());
}

function int(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function list(value, fallback) {
  if (!value) return fallback;
  const items = String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function trimSlash(value, fallback) {
  const raw = String(value ?? "").trim() || fallback;
  return raw.replace(/\/+$/, "");
}

export const ALL_PROVIDERS = ["vidcore", "chillflix", "nekowatch"];

export const config = {
  // --- Servidor -----------------------------------------------------------
  // Render inyecta PORT; hay que escuchar en 0.0.0.0 para que el proxy lo vea.
  port: int(process.env.PORT, 7000, { min: 1, max: 65535 }),
  host: process.env.HOST || "0.0.0.0",

  // URL pública (https://tu-servicio.onrender.com). Si falta, se deduce de los
  // headers de cada petición, que es lo normal detrás del proxy de Render.
  publicUrl: trimSlash(process.env.PUBLIC_URL, ""),

  // --- Identidad del addon ------------------------------------------------
  addonId: process.env.ADDON_ID || "com.vimeus.streamer.multisource",
  addonName: process.env.ADDON_NAME || "Vimeus Streamer",
  addonVersion: process.env.ADDON_VERSION || "1.0.0",

  // --- Proveedores --------------------------------------------------------
  providers: list(process.env.PROVIDERS, ALL_PROVIDERS).filter((p) =>
    ALL_PROVIDERS.includes(p),
  ),

  vidcore: {
    base: trimSlash(process.env.VIDCORE_BASE, "https://vidcore.org"),
    // La documentación usa /embed/tv/{id}/{s}/{e}; su ejemplo en React usa
    // /embed/series/. Configurable por si cambian de ruta.
    tvPath: (process.env.VIDCORE_TV_PATH || "tv").replace(/^\/+|\/+$/g, ""),
  },

  chillflix: {
    // Ojo: el catálogo vive en chillflix.lol pero el reproductor SIEMPRE
    // se sirve desde chillflix.pw (lo dice su propia documentación).
    base: trimSlash(process.env.CHILLFLIX_BASE, "https://www.chillflix.pw"),
    autoplay: bool(process.env.CHILLFLIX_AUTOPLAY, true),
    autonext: bool(process.env.CHILLFLIX_AUTONEXT, true),
    prefer4k: bool(process.env.CHILLFLIX_PREFER_4K, true),
    showTitle: bool(process.env.CHILLFLIX_TITLE, false),
  },

  nekowatch: {
    base: trimSlash(process.env.NEKOWATCH_BASE, "https://nekowatch.xyz"),
    // Buscar en AniList a partir de un ID de IMDb cuando Cinemeta detecta que
    // el contenido es anime. Desactívalo si quieres respuestas más rápidas.
    imdbLookup: bool(process.env.NEKOWATCH_IMDB_LOOKUP, true),
  },

  // --- Metadatos ----------------------------------------------------------
  cinemetaBase: trimSlash(process.env.CINEMETA_BASE, "https://v3-cinemeta.strem.io"),
  anilistBase: trimSlash(process.env.ANILIST_BASE, "https://graphql.anilist.co"),
  relationsBase: trimSlash(process.env.RELATIONS_BASE, "https://relations.yuna.moe"),
  kitsuBase: trimSlash(process.env.KITSU_BASE, "https://kitsu.io/api/edge"),
  // Opcional. Mejora la conversión IMDb -> TMDB cuando Cinemeta no trae el id.
  tmdbApiKey: (process.env.TMDB_API_KEY || "").trim(),

  // --- Resolución a HLS ---------------------------------------------------
  // Entrega enlaces .m3u8/.mp4 reproducibles dentro de Stremio en lugar de
  // abrir el reproductor web. Activado por defecto.
  resolveDirect: bool(process.env.RESOLVE_DIRECT, true),
  resolveTimeoutMs: int(process.env.RESOLVE_TIMEOUT_MS, 9000, { min: 1000, max: 25000 }),

  // Extractor genérico sobre el HTML del reproductor. Barato pero inútil
  // contra reproductores que cifran la fuente.
  genericExtractor: bool(process.env.GENERIC_EXTRACTOR, true),

  // Abrir el .m3u8 maestro para ofrecer una entrada por calidad (1080p, 720p…)
  // en vez de una sola entrada "Auto".
  expandQualities: bool(process.env.EXPAND_QUALITIES, true),

  // Mantener el enlace al reproductor web como última alternativa.
  includeExternal: bool(process.env.INCLUDE_EXTERNAL, true),

  // --- Resolvedores externos ----------------------------------------------
  // Los tres proveedores cifran la resolución del stream. Aquí puedes apuntar
  // a un servicio que ya la implemente. Admite los marcadores
  // {provider} {type} {tmdb} {imdb} {anilist} {season} {episode} {title}
  resolvers: {
    default: (process.env.RESOLVER_URL || "").trim(),
    vidcore: (process.env.VIDCORE_RESOLVER_URL || "").trim(),
    chillflix: (process.env.CHILLFLIX_RESOLVER_URL || "").trim(),
    nekowatch: (process.env.NEKOWATCH_RESOLVER_URL || "").trim(),
  },
  resolverToken: (process.env.RESOLVER_TOKEN || "").trim(),

  // --- Proxy HLS ----------------------------------------------------------
  // Reenvía Referer/Origin a los segmentos para clientes que no respetan
  // behaviorHints.proxyHeaders (Stremio Web, algunas TV).
  proxyEnabled: bool(process.env.PROXY_ENABLED, true),
  proxySecret:
    (process.env.PROXY_SECRET || "").trim() || crypto.randomBytes(24).toString("hex"),

  // --- Red / caché --------------------------------------------------------
  fetchTimeoutMs: int(process.env.FETCH_TIMEOUT_MS, 8000, { min: 1000, max: 30000 }),
  cacheTtlMs: int(process.env.CACHE_TTL_MS, 6 * 60 * 60 * 1000, { min: 0 }),
  cacheMaxEntries: int(process.env.CACHE_MAX_ENTRIES, 2000, { min: 16 }),
  streamCacheTtlMs: int(process.env.STREAM_CACHE_TTL_MS, 10 * 60 * 1000, { min: 0 }),

  userAgent:
    process.env.USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",

  logLevel: (process.env.LOG_LEVEL || "info").toLowerCase(),
};

export function isProviderEnabled(name) {
  return config.providers.includes(name);
}

export const helpers = { bool, int, list, trimSlash };
