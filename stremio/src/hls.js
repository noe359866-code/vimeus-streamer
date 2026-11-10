/**
 * Utilidades HLS: análisis de playlists maestras, reescritura para el proxy,
 * descifrado de manifiestos ofuscados y desempaquetado de segmentos.
 *
 * Todo lo de este módulo es puro (texto/bytes dentro, texto/bytes fuera), así
 * que se puede probar sin red.
 */

/* ------------------------------------------------------------------ */
/* Análisis de playlists                                               */
/* ------------------------------------------------------------------ */

export function isPlaylistText(text) {
  return typeof text === "string" && text.trimStart().startsWith("#EXTM3U");
}

export function isMasterPlaylist(text) {
  return isPlaylistText(text) && text.includes("#EXT-X-STREAM-INF:");
}

function parseAttributes(line) {
  const attrs = {};
  // Clave=valor separados por comas, respetando las comillas.
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi;
  for (const match of line.matchAll(re)) {
    attrs[match[1].toUpperCase()] = match[3] ?? match[4] ?? "";
  }
  return attrs;
}

/** Etiqueta legible de calidad a partir de la altura en píxeles. */
export function qualityLabel(height, bandwidth) {
  if (Number.isFinite(height) && height > 0) {
    if (height >= 2000) return "4K";
    return `${height}p`;
  }
  if (Number.isFinite(bandwidth) && bandwidth > 0) {
    return `${Math.round(bandwidth / 1000)} kbps`;
  }
  return "Auto";
}

/**
 * Extrae las variantes de una playlist maestra.
 * @returns {Array<{uri:string,bandwidth:number,width:number|null,height:number|null,codecs:string|null,label:string}>}
 */
export function parseMasterVariants(text, baseUrl) {
  if (!isMasterPlaylist(text)) return [];

  const lines = text.split(/\r?\n/);
  const variants = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    // La URI es la primera línea no vacía y no comentada que sigue.
    let uri = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].trim();
      if (!next) continue;
      if (next.startsWith("#")) break;
      uri = next;
      break;
    }
    if (!uri) continue;

    const attrs = parseAttributes(line);
    const bandwidth = Number.parseInt(attrs.BANDWIDTH || attrs["AVERAGE-BANDWIDTH"] || "0", 10) || 0;
    const resolution = String(attrs.RESOLUTION || "");
    const [width, height] = resolution.includes("x")
      ? resolution.split("x").map((value) => Number.parseInt(value, 10) || null)
      : [null, null];

    variants.push({
      uri: absolutize(uri, baseUrl) || uri,
      bandwidth,
      width: width || null,
      height: height || null,
      codecs: attrs.CODECS || null,
      label: qualityLabel(height, bandwidth),
    });
  }

  // De mayor a menor calidad: es el orden que espera ver el usuario.
  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);

  // Una misma altura puede repetirse con varios bitrates; nos quedamos con el mejor.
  const seen = new Set();
  return variants.filter((variant) => {
    const key = variant.height ? `h${variant.height}` : `b${variant.bandwidth}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function absolutize(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Reescritura para el proxy                                           */
/* ------------------------------------------------------------------ */

/**
 * Clasifica una URL dentro de una playlist. Permite decidir qué pasa por el
 * proxy y qué va directo al CDN, que es de donde sale todo el ahorro de
 * ancho de banda: los segmentos son el 99,9 % de los bytes.
 *
 * @returns {"playlist"|"key"|"map"|"segment"}
 */
export function classifyUri(uri, tag = "") {
  const upperTag = tag.toUpperCase();
  if (upperTag.includes("EXT-X-KEY") || upperTag.includes("EXT-X-SESSION-KEY")) return "key";
  if (upperTag.includes("EXT-X-MAP")) return "map";

  let pathname = uri;
  try {
    pathname = new URL(uri, "http://x.invalid").pathname;
  } catch {
    // Si no parsea nos quedamos con la cadena tal cual.
  }
  if (/\.m3u8$/i.test(pathname)) return "playlist";
  if (upperTag.includes("EXT-X-MEDIA") || upperTag.includes("I-FRAME-STREAM-INF")) {
    return "playlist";
  }
  return "segment";
}

/**
 * Reescribe una playlist.
 *
 * @param {string} text     contenido de la playlist
 * @param {string} baseUrl  URL real de la playlist, para resolver relativos
 * @param {(absoluteUrl:string, kind:string)=>string} toProxy
 *        Devuelve la URL que debe quedar escrita. Si devuelve la propia URL
 *        recibida, ese recurso irá directo al CDN.
 */
export function rewritePlaylist(text, baseUrl, toProxy) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        // #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA y #EXT-X-I-FRAME-STREAM-INF
        // llevan la URL en un atributo URI="...".
        const tag = trimmed.split(":")[0];
        return line.replace(
          /\b(URI)=("([^"]*)"|'([^']*)')/gi,
          (full, name, quoted, dq, sq) => {
            const value = dq ?? sq ?? "";
            const absolute = absolutize(value, baseUrl);
            if (!absolute) return full;
            const quote = quoted[0];
            return `${name}=${quote}${toProxy(absolute, classifyUri(absolute, tag))}${quote}`;
          },
        );
      }

      const absolute = absolutize(trimmed, baseUrl);
      return absolute ? toProxy(absolute, classifyUri(absolute)) : line;
    })
    .join("\n");
}

/**
 * ¿Debe pasar este recurso por el proxy, según el modo configurado?
 *
 *   full      todo
 *   playlist  playlists, claves y mapas de inicialización (pequeños y casi
 *             siempre exigen Referer); los segmentos van directos
 *   off       nada
 */
export function shouldProxyKind(kind, mode) {
  if (mode === "off") return false;
  if (mode === "full") return true;
  return kind !== "segment";
}

/* ------------------------------------------------------------------ */
/* Manifiestos ofuscados                                               */
/* ------------------------------------------------------------------ */

/**
 * Algunos CDN devuelven el manifiesto como Base64 cifrado con XOR en vez de
 * texto plano. Con la clave correcta se recupera el `#EXTM3U`.
 *
 * @param {string} text  cuerpo recibido
 * @param {string} key   clave en Base64
 */
export function decryptManifest(text, key) {
  if (isPlaylistText(text)) return { text, decrypted: false };
  if (!key) return { text, decrypted: false };

  try {
    const keyBytes = Buffer.from(key, "base64");
    const payload = Buffer.from(String(text).trim(), "base64");
    if (!keyBytes.length || !payload.length) return { text, decrypted: false };

    const out = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      out[i] = payload[i] ^ keyBytes[i % keyBytes.length];
    }

    const decoded = out.toString("utf8");
    if (isPlaylistText(decoded)) return { text: decoded, decrypted: true };
  } catch {
    // Si no descifra, devolvemos el original y que decida quien llama.
  }

  return { text, decrypted: false };
}

/* ------------------------------------------------------------------ */
/* Segmentos disfrazados de imagen                                     */
/* ------------------------------------------------------------------ */

const TS_SYNC_BYTE = 0x47;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes, magic, offset = 0) {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Ciertos servidores envuelven los segmentos MPEG-TS en una cabecera PNG/WebP
 * para que parezcan imágenes. Quitamos la cabecera y, si hace falta, deshacemos
 * un XOR, hasta encontrar el byte de sincronismo 0x47 del transport stream.
 *
 * @param {Buffer} bytes
 * @param {Buffer|null} xorKey  clave opcional
 * @returns {Buffer|null} los bytes del TS, o null si no era un segmento envuelto
 */
export function unwrapImageSegment(bytes, xorKey = null) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  let offset = 0;
  if (startsWith(buffer, RIFF) && startsWith(buffer, WEBP, 8)) offset = 12;
  else if (startsWith(buffer, PNG_MAGIC)) offset = 8;
  if (!offset) return null;

  let body = buffer.subarray(offset);
  if (body[0] === TS_SYNC_BYTE) return body;

  if (xorKey && xorKey.length) {
    const out = Buffer.allocUnsafe(body.length);
    for (let i = 0; i < body.length; i += 1) {
      out[i] = body[i] ^ xorKey[i % xorKey.length];
    }
    body = out;
  }

  return body[0] === TS_SYNC_BYTE ? body : null;
}

export function looksLikeImageSegment(url, contentType) {
  return (
    /\.(png|webp)(\?|$)/i.test(url) || /image\/(png|webp)/i.test(contentType || "")
  );
}
