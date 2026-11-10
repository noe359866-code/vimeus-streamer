/**
 * Sonda de capacidades del CDN.
 *
 * La pregunta que decide si podemos servir HLS sin proxy es una sola:
 * ¿acepta este CDN una petición SIN Referer?
 *
 * No se puede adivinar, pero sí preguntarlo: se hace una petición de prueba
 * sin cabeceras y se guarda el resultado por host. A partir de ahí, todas las
 * reproducciones de ese CDN ya saben la respuesta.
 */

import { config } from "./config.js";
import { TtlCache } from "./cache.js";
import { fetchWithTimeout, log } from "./http.js";
import { upstreamSemaphore } from "./limits.js";

// El comportamiento de un CDN no cambia de un minuto a otro: TTL largo.
const probeCache = new TtlCache({ ttlMs: config.probeTtlMs, maxEntries: 500 });

/** Un medio que hay que transformar NO puede ir directo, da igual el CDN. */
export function mustProxy(media) {
  if (!media) return false;
  // Manifiesto cifrado con Base64+XOR: el reproductor vería un churro, no #EXTM3U.
  if (media.playlistKey) return true;
  // Segmentos camuflados como PNG/WebP: ningún reproductor los desenvuelve.
  if (media.unwrap) return true;
  return false;
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * ¿Sirve este CDN el recurso sin Referer ni Origin?
 *
 * @returns {Promise<{direct:boolean, reason:string, cors:boolean}>}
 */
export async function probeDirect(url) {
  const host = hostOf(url);
  if (!host) return { direct: false, reason: "URL no válida", cors: false };

  if (!config.probeEnabled) {
    return { direct: false, reason: "sonda desactivada", cors: false };
  }

  return probeCache.wrap(`probe:${host}`, async () => {
    try {
      const response = await upstreamSemaphore.run(() =>
        fetchWithTimeout(url, {
          // Deliberadamente SIN Referer ni Origin: es justo lo que se mide.
          headers: { Range: "bytes=0-1" },
          timeoutMs: config.probeTimeoutMs,
        }),
      );

      // Cerramos el cuerpo: solo nos interesaba el código de estado.
      response.body?.cancel().catch(() => {});

      const cors = response.headers.get("access-control-allow-origin") === "*";
      const direct = response.status >= 200 && response.status < 300;

      log(
        "info",
        `sonda ${host}: ${direct ? "acepta" : "rechaza"} sin Referer ` +
          `(HTTP ${response.status}${cors ? ", con CORS" : ""})`,
      );

      return {
        direct,
        cors,
        reason: direct
          ? `el CDN responde ${response.status} sin Referer`
          : `el CDN responde ${response.status} sin Referer`,
      };
    } catch (error) {
      log("debug", `sonda ${host} falló: ${error.message}`);
      // Ante la duda, proxy: es peor entregar algo que no reproduce.
      return { direct: false, cors: false, reason: `la sonda falló (${error.message})` };
    }
  });
}

/**
 * Decide cómo entregar un medio concreto.
 * @returns {Promise<{viaProxy:boolean, reason:string}>}
 */
export async function decideDelivery(media, { proxyAvailable }) {
  if (!proxyAvailable) {
    return { viaProxy: false, reason: "no hay proxy disponible" };
  }

  switch (config.proxyMode) {
    case "off":
      return { viaProxy: false, reason: "PROXY_MODE=off" };
    case "full":
      return { viaProxy: true, reason: "PROXY_MODE=full" };
    case "playlist":
      return { viaProxy: true, reason: "PROXY_MODE=playlist" };
    default:
      break;
  }

  // Modo auto: proxy solo cuando es técnicamente imprescindible.
  if (mustProxy(media)) {
    return {
      viaProxy: true,
      reason: media.playlistKey ? "manifiesto cifrado" : "segmentos envueltos en imagen",
    };
  }

  const probe = await probeDirect(media.url);
  return { viaProxy: !probe.direct, reason: probe.reason };
}

export function probeStats() {
  return { hostsConocidos: probeCache.size };
}

export { probeCache };
