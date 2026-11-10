/**
 * Pipeline de extracción: candidato (página de reproductor) -> medios HLS/MP4.
 *
 * Orden de intentos por proveedor:
 *   1. Resolvedor externo (si está configurado). Es el único capaz de superar
 *      el cifrado de VidCore / Chillflix / FlixCloud.
 *   2. Extractor genérico sobre el HTML del reproductor.
 *
 * Si ninguno devuelve nada, streams.js recurre al enlace externo.
 */

import { config } from "./../config.js";
import { log } from "./../http.js";
import { resolveViaBridge, resolverUrlFor } from "./bridge.js";
import { extractFromEmbed } from "./generic.js";

/** ¿Hay alguna vía de resolución directa disponible para este proveedor? */
export function canResolve(providerId) {
  return Boolean(resolverUrlFor(providerId)) || config.genericExtractor;
}

/**
 * @param {object} candidate  entrada construida por el proveedor
 * @param {object} vars       variables para la plantilla del resolvedor
 * @param {{timeoutMs:number}} options
 * @returns {Promise<Array>} medios normalizados
 */
export async function extractMedia(candidate, vars, { timeoutMs = config.resolveTimeoutMs } = {}) {
  const started = Date.now();
  const remaining = () => timeoutMs - (Date.now() - started);

  // 1. Resolvedor externo.
  if (resolverUrlFor(candidate.provider)) {
    const viaBridge = await resolveViaBridge(candidate.provider, vars);
    if (viaBridge.length) return viaBridge;
  }

  // 2. Extractor genérico.
  if (config.genericExtractor && remaining() > 800) {
    const viaGeneric = await extractFromEmbed(candidate, { timeoutMs: remaining() });
    if (viaGeneric.length) return viaGeneric;
    log("debug", `sin medios directos para ${candidate.provider}`);
  }

  return [];
}

export { resolveViaBridge, resolverUrlFor } from "./bridge.js";
export { extractFromEmbed, extractMediaUrls, unescapeEmbedded, guessQuality } from "./generic.js";
