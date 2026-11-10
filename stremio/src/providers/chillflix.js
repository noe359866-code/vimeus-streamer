/**
 * Chillflix — https://www.chillflix.lol/player-api
 *
 * El catálogo está en chillflix.lol, pero el reproductor se sirve siempre
 * desde https://www.chillflix.pw (así lo indica su documentación):
 *   /embed/movie/{tmdbId}
 *   /embed/tv/{tmdbId}/{season}/{episode}
 *
 * Flags soportados: autoplay, startAt, title, watchparty, party, autonext,
 * prefer4k, runtime, parent_origin.
 */

import { config } from "../config.js";
import { seasonEpisode } from "../ids.js";
import { resolveTmdbId } from "../meta.js";

export const id = "chillflix";
export const name = "Chillflix";
export const needs = "tmdb";

export function buildUrl({ tmdbId, type, season, episode, parentOrigin }) {
  const base = config.chillflix.base;
  const path =
    type === "movie"
      ? `/embed/movie/${tmdbId}`
      : `/embed/tv/${tmdbId}/${season}/${episode}`;

  const params = new URLSearchParams();
  params.set("autoplay", config.chillflix.autoplay ? "true" : "false");
  // La barra de título estorba dentro de Stremio; por defecto la ocultamos.
  params.set("title", config.chillflix.showTitle ? "true" : "false");
  // Sin watch party: el addon solo entrega el stream.
  params.set("watchparty", "false");
  if (type !== "movie" && config.chillflix.autonext) params.set("autonext", "true");
  if (config.chillflix.prefer4k) params.set("prefer4k", "1");
  if (parentOrigin) params.set("parent_origin", parentOrigin);

  return `${base}${path}?${params.toString()}`;
}

export async function getCandidates(parsed, ctx = {}) {
  const tmdbId = await resolveTmdbId(parsed);
  if (!tmdbId) return [];

  const { season, episode } = seasonEpisode(parsed);
  const url = buildUrl({
    tmdbId,
    type: parsed.type,
    season,
    episode,
    parentOrigin: ctx.publicUrl || undefined,
  });

  return [
    {
      provider: id,
      providerName: name,
      url,
      origin: config.chillflix.base,
      label:
        parsed.type === "movie"
          ? `Auto${config.chillflix.prefer4k ? " · 4K preferente" : ""}`
          : `T${season}E${episode} · Auto`,
      description: "Reproductor Chillflix con autoplay y auto-next",
      bingeGroup: `vimeus-chillflix-${parsed.type}`,
    },
  ];
}
