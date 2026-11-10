import { config } from "./config.js";
import { registry } from "./providers/index.js";

/** Manifiesto de Stremio. Solo exponemos el recurso `stream`. */
export function buildManifest() {
  const names = config.providers.map((key) => registry[key]?.name || key);

  return {
    id: config.addonId,
    version: config.addonVersion,
    name: config.addonName,
    description:
      `Streams de ${names.join(", ")} para películas, series y anime. ` +
      "Sin catálogos: el addon solo añade fuentes de reproducción.",
    logo: "https://dl.strem.io/addon-logo.png",
    background: "https://dl.strem.io/addon-background.jpg",
    resources: ["stream"],
    types: ["movie", "series", "anime"],
    idPrefixes: ["tt", "tmdb:", "kitsu:", "mal:", "anilist:", "anidb:"],
    catalogs: [],
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
      p2p: false,
    },
  };
}
