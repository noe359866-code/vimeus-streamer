/**
 * VidCore — https://vidcore.org/movie-embed-api
 *
 * Rutas documentadas (REST, por id de TMDB):
 *   GET /embed/movie/{id}
 *   GET /embed/tv/{id}/{season}/{episode}
 */

import { config } from "../config.js";
import { seasonEpisode } from "../ids.js";
import { resolveTmdbId } from "../meta.js";

export const id = "vidcore";
export const name = "VidCore";
export const needs = "tmdb";

export function buildUrl({ tmdbId, type, season, episode }) {
  const base = config.vidcore.base;
  if (type === "movie") return `${base}/embed/movie/${tmdbId}`;
  return `${base}/embed/${config.vidcore.tvPath}/${tmdbId}/${season}/${episode}`;
}

export async function getCandidates(parsed) {
  const tmdbId = await resolveTmdbId(parsed);
  if (!tmdbId) return [];

  const { season, episode } = seasonEpisode(parsed);
  const url = buildUrl({ tmdbId, type: parsed.type, season, episode });

  return [
    {
      provider: id,
      providerName: name,
      url,
      origin: config.vidcore.base,
      label: parsed.type === "movie" ? "Auto · hasta 4K" : `T${season}E${episode} · Auto`,
      description: "Reproductor adaptativo con subtítulos automáticos",
      bingeGroup: `vimeus-vidcore-${parsed.type}`,
    },
  ];
}
