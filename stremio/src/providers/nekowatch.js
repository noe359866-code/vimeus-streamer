/**
 * NekoWatch — https://nekowatch.xyz
 *
 * Catálogo de anime indexado por AniList:
 *   /watch/{anilistId}         primer episodio
 *   /watch/{anilistId}?ep=N    episodio N
 *   /anime/{anilistId}         ficha
 *
 * No publica una ruta /embed, así que usamos la página de reproducción.
 */

import { config } from "../config.js";
import { resolveAnilistId } from "../meta.js";

export const id = "nekowatch";
export const name = "NekoWatch";
export const needs = "anilist";

export function buildUrl({ anilistId, episode }) {
  const base = config.nekowatch.base;
  const url = `${base}/watch/${anilistId}`;
  return episode && episode > 1 ? `${url}?ep=${episode}` : url;
}

export async function getCandidates(parsed) {
  const anilistId = await resolveAnilistId(parsed);
  if (!anilistId) return [];

  // Los catálogos de anime numeran en absoluto dentro de cada entrada de
  // AniList, que es justo lo que espera NekoWatch en ?ep=
  const episode = parsed.type === "movie" ? null : parsed.episode ?? 1;
  const url = buildUrl({ anilistId, episode });

  return [
    {
      provider: id,
      providerName: name,
      url,
      origin: config.nekowatch.base,
      label: episode ? `Episodio ${episode} · SUB/DUB` : "Película · SUB/DUB",
      description: "Anime vía AniList · subtítulos y pistas de audio múltiples",
      bingeGroup: `vimeus-nekowatch`,
    },
  ];
}
