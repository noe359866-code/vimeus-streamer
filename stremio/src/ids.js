/**
 * Parseo de los IDs que envía Stremio en /stream/:type/:id.json
 *
 * Formatos habituales:
 *   tt0133093                 Película (Cinemeta)
 *   tt0944947:1:2             Serie, temporada 1 episodio 2 (Cinemeta)
 *   tmdb:550 / tmdb:1396:1:1  Addons basados en TMDB
 *   kitsu:12345 / kitsu:12345:7   Anime (addon Kitsu) — episodio absoluto
 *   mal:5114:3 / anilist:21:1050 / anidb:4563:2
 */

const SOURCES = {
  tt: "imdb",
  tmdb: "tmdb",
  themoviedb: "tmdb",
  kitsu: "kitsu",
  mal: "mal",
  myanimelist: "mal",
  anilist: "anilist",
  al: "anilist",
  anidb: "anidb",
};

/** Fuentes que identifican anime y no sirven para proveedores basados en TMDB. */
export const ANIME_SOURCES = new Set(["kitsu", "mal", "anilist", "anidb"]);

function toPositiveInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * @param {"movie"|"series"|"anime"} type
 * @param {string} rawId id tal y como llega en la ruta (ya sin ".json")
 * @returns {{source:string,id:string,season:number|null,episode:number|null,type:string,raw:string}|null}
 */
export function parseStreamId(type, rawId) {
  if (!rawId) return null;

  let decoded = String(rawId).trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Un id con "%" suelto no es motivo para rechazar la petición.
  }
  decoded = decoded.replace(/\.json$/i, "").trim();
  if (!decoded) return null;

  const normalizedType = type === "anime" ? "series" : type;
  const parts = decoded.split(":").filter((part) => part !== "");
  if (!parts.length) return null;

  // Caso IMDb: "tt0944947", "tt0944947:1:2"
  if (/^tt\d+$/i.test(parts[0])) {
    return {
      source: "imdb",
      id: parts[0].toLowerCase(),
      season: toPositiveInt(parts[1]),
      episode: toPositiveInt(parts[2]),
      type: normalizedType,
      raw: decoded,
    };
  }

  const prefix = parts[0].toLowerCase();
  const source = SOURCES[prefix];
  if (!source) return null;

  const id = parts[1];
  if (!id) return null;

  // Los catálogos de anime numeran episodios en absoluto: "kitsu:12345:7"
  // no lleva temporada. Los de TMDB sí: "tmdb:1396:1:1".
  if (ANIME_SOURCES.has(source)) {
    const third = toPositiveInt(parts[2]);
    const fourth = toPositiveInt(parts[3]);
    return {
      source,
      id: String(id),
      // Si vienen cuatro segmentos lo tratamos como temporada:episodio.
      season: fourth !== null ? third : null,
      episode: fourth !== null ? fourth : third,
      type: normalizedType,
      raw: decoded,
    };
  }

  return {
    source,
    id: String(id),
    season: toPositiveInt(parts[2]),
    episode: toPositiveInt(parts[3]),
    type: normalizedType,
    raw: decoded,
  };
}

/** Temporada/episodio efectivos para proveedores que los exigen. */
export function seasonEpisode(parsed) {
  if (!parsed || parsed.type !== "series") return { season: null, episode: null };
  return {
    season: parsed.season ?? 1,
    episode: parsed.episode ?? 1,
  };
}

export function describeId(parsed) {
  if (!parsed) return "desconocido";
  const { season, episode } = parsed;
  if (season && episode) return `${parsed.source}:${parsed.id} T${season}E${episode}`;
  if (episode) return `${parsed.source}:${parsed.id} E${episode}`;
  return `${parsed.source}:${parsed.id}`;
}
