/**
 * Resolución de metadatos y conversión de identificadores.
 *
 * VidCore y Chillflix hablan TMDB. NekoWatch habla AniList. Stremio casi
 * siempre envía IMDb (Cinemeta) o Kitsu (addons de anime), así que aquí está
 * el pegamento entre unos y otros.
 */

import { config } from "./config.js";
import { metaCache } from "./cache.js";
import { fetchJson, tryJson, log } from "./http.js";
import { ANIME_SOURCES } from "./ids.js";

const ANIME_GENRES = ["animation", "anime"];
const JAPANESE_HINTS = ["japan", "japanese", "jp", "ja"];

/* ------------------------------------------------------------------ */
/* Cinemeta                                                            */
/* ------------------------------------------------------------------ */

/** Metadatos de Cinemeta: nombre, año, géneros y a menudo el id de TMDB. */
export async function getCinemetaMeta(type, imdbId) {
  if (!imdbId) return null;
  const kind = type === "movie" ? "movie" : "series";
  const key = `cinemeta:${kind}:${imdbId}`;

  return metaCache.wrap(key, async () => {
    const url = `${config.cinemetaBase}/meta/${kind}/${encodeURIComponent(imdbId)}.json`;
    const data = await tryJson(url);
    const meta = data?.meta;
    if (!meta || typeof meta !== "object") return null;
    return {
      name: typeof meta.name === "string" ? meta.name.trim() : null,
      year: parseYear(meta.year ?? meta.releaseInfo),
      genres: normalizeList(meta.genres),
      country: String(meta.country ?? "").toLowerCase(),
      language: String(meta.language ?? "").toLowerCase(),
      tmdbId: pickTmdbId(meta),
      poster: typeof meta.poster === "string" ? meta.poster : null,
      runtime: typeof meta.runtime === "string" ? meta.runtime : null,
    };
  });
}

function pickTmdbId(meta) {
  const candidates = [meta.moviedb_id, meta.moviedbId, meta.tmdb_id, meta.tmdbId];
  for (const candidate of candidates) {
    const parsed = Number.parseInt(String(candidate ?? ""), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function parseYear(value) {
  const match = String(value ?? "").match(/\d{4}/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).toLowerCase().trim()).filter(Boolean);
}

/** Heurística barata para saber si un título de Cinemeta es anime. */
export function looksLikeAnime(meta) {
  if (!meta) return false;
  const hasAnimation = meta.genres.some((genre) => ANIME_GENRES.includes(genre));
  if (!hasAnimation) return false;
  const haystack = `${meta.country} ${meta.language}`;
  return JAPANESE_HINTS.some((hint) => haystack.includes(hint));
}

/* ------------------------------------------------------------------ */
/* TMDB                                                                */
/* ------------------------------------------------------------------ */

/** Devuelve el id numérico de TMDB para el contenido pedido, o null. */
export async function resolveTmdbId(parsed) {
  if (!parsed) return null;
  if (parsed.source === "tmdb") {
    const direct = Number.parseInt(parsed.id, 10);
    return Number.isInteger(direct) && direct > 0 ? direct : null;
  }
  if (parsed.source !== "imdb") return null;

  const key = `tmdb:${parsed.type}:${parsed.id}`;
  return metaCache.wrap(key, async () => {
    const meta = await getCinemetaMeta(parsed.type, parsed.id);
    if (meta?.tmdbId) return meta.tmdbId;
    return findTmdbIdByImdb(parsed.type, parsed.id);
  });
}

/** Fallback con la API oficial de TMDB (requiere TMDB_API_KEY). */
async function findTmdbIdByImdb(type, imdbId) {
  if (!config.tmdbApiKey) return null;
  const url =
    `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}` +
    `?api_key=${encodeURIComponent(config.tmdbApiKey)}&external_source=imdb_id`;
  const data = await tryJson(url);
  if (!data) return null;
  const bucket = type === "movie" ? data.movie_results : data.tv_results;
  const first = Array.isArray(bucket) ? bucket[0] : null;
  const id = Number.parseInt(String(first?.id ?? ""), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/* ------------------------------------------------------------------ */
/* AniList                                                             */
/* ------------------------------------------------------------------ */

/** Devuelve el id de AniList para el contenido pedido, o null. */
export async function resolveAnilistId(parsed) {
  if (!parsed) return null;

  if (parsed.source === "anilist") {
    const direct = Number.parseInt(parsed.id, 10);
    return Number.isInteger(direct) && direct > 0 ? direct : null;
  }

  if (ANIME_SOURCES.has(parsed.source)) {
    return metaCache.wrap(`anilist:${parsed.source}:${parsed.id}`, () =>
      mapExternalToAnilist(parsed.source, parsed.id),
    );
  }

  if (parsed.source === "imdb" && config.nekowatch.imdbLookup) {
    const meta = await getCinemetaMeta(parsed.type, parsed.id);
    if (!looksLikeAnime(meta) || !meta?.name) return null;
    const query = parsed.season && parsed.season > 1
      ? `${meta.name} Season ${parsed.season}`
      : meta.name;
    return metaCache.wrap(`anilist:search:${query}:${meta.year ?? ""}`, () =>
      searchAnilist(query, meta.year, parsed.type),
    );
  }

  return null;
}

/** kitsu/mal/anidb -> anilist usando relations.yuna.moe y, si falla, Kitsu. */
async function mapExternalToAnilist(source, id) {
  const relations = await tryJson(
    `${config.relationsBase}/api/ids?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`,
  );
  const fromRelations = Number.parseInt(String(relations?.anilist ?? ""), 10);
  if (Number.isInteger(fromRelations) && fromRelations > 0) return fromRelations;

  if (source === "kitsu") {
    const viaKitsu = await anilistIdFromKitsu(id);
    if (viaKitsu) return viaKitsu;
  }

  if (source === "mal") {
    const viaGraphql = await anilistIdByMalId(id);
    if (viaGraphql) return viaGraphql;
  }

  return null;
}

async function anilistIdFromKitsu(kitsuId) {
  const data = await tryJson(
    `${config.kitsuBase}/anime/${encodeURIComponent(kitsuId)}/mappings?page[limit]=40`,
  );
  const items = Array.isArray(data?.data) ? data.data : [];
  for (const item of items) {
    const site = String(item?.attributes?.externalSite ?? "").toLowerCase();
    if (site.includes("anilist")) {
      const value = Number.parseInt(String(item?.attributes?.externalId ?? ""), 10);
      if (Number.isInteger(value) && value > 0) return value;
    }
  }
  // Último recurso: buscar en AniList por el título canónico de Kitsu.
  const anime = await tryJson(`${config.kitsuBase}/anime/${encodeURIComponent(kitsuId)}`);
  const titles = anime?.data?.attributes;
  const name = titles?.canonicalTitle || titles?.titles?.en || titles?.titles?.en_jp;
  if (!name) return null;
  const year = parseYear(titles?.startDate);
  return searchAnilist(name, year, "series");
}

async function anilistIdByMalId(malId) {
  const result = await anilistGraphql(
    `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { id } }`,
    { idMal: Number.parseInt(malId, 10) },
  );
  const id = Number.parseInt(String(result?.data?.Media?.id ?? ""), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function searchAnilist(search, year, type) {
  const format = type === "movie" ? "MOVIE" : null;
  const result = await anilistGraphql(
    `query ($search: String, $year: Int, $format: MediaFormat) {
       Page(perPage: 5) {
         media(search: $search, type: ANIME, format: $format, seasonYear: $year, sort: SEARCH_MATCH) {
           id
           seasonYear
           format
           title { romaji english }
         }
       }
     }`,
    { search, year: Number.isInteger(year) ? year : null, format },
  );

  let media = result?.data?.Page?.media;
  if (!Array.isArray(media) || !media.length) {
    // Reintento sin filtrar por año: AniList y IMDb no siempre coinciden.
    const retry = await anilistGraphql(
      `query ($search: String) {
         Page(perPage: 5) {
           media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id seasonYear format }
         }
       }`,
      { search },
    );
    media = retry?.data?.Page?.media;
  }

  const first = Array.isArray(media) ? media[0] : null;
  const id = Number.parseInt(String(first?.id ?? ""), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function anilistGraphql(query, variables) {
  try {
    return await fetchJson(config.anilistBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    log("debug", "AniList GraphQL falló:", error.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Título legible para la UI                                           */
/* ------------------------------------------------------------------ */

export async function resolveDisplayTitle(parsed) {
  if (parsed?.source === "imdb") {
    const meta = await getCinemetaMeta(parsed.type, parsed.id);
    if (meta?.name) return meta.year ? `${meta.name} (${meta.year})` : meta.name;
  }
  return null;
}
