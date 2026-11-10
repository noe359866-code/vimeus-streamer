/**
 * Proxy HLS/MP4.
 *
 * Es la pieza que hace que un .m3u8 de un CDN ajeno se pueda reproducir dentro
 * de Stremio. Se encarga de:
 *
 *  - reenviar Referer/Origin/User-Agent (los CDN rechazan peticiones sin ellos),
 *  - reescribir playlists para que segmentos, claves AES y mapas de
 *    inicialización vuelvan a pasar por aquí,
 *  - descifrar manifiestos ofuscados con Base64+XOR,
 *  - desenvolver segmentos MPEG-TS camuflados como PNG/WebP,
 *  - propagar Range para que funcione el salto en la línea de tiempo.
 *
 * Las URLs van firmadas con HMAC: sin firma válida el proxy no reenvía nada,
 * así que no se puede usar como proxy abierto.
 */

import crypto from "node:crypto";
import { config } from "./config.js";
import { fetchWithTimeout, log } from "./http.js";
import {
  decryptManifest,
  isPlaylistText,
  looksLikeImageSegment,
  rewritePlaylist,
  shouldProxyKind,
  unwrapImageSegment,
} from "./hls.js";
import { bump } from "./metrics.js";
import { upstreamSemaphore } from "./limits.js";

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/** Clave XOR usada por los segmentos camuflados como imagen. */
const IMAGE_XOR_KEY = Buffer.from([
  157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197,
]);

export function sign(payload) {
  return crypto
    .createHmac("sha256", config.proxySecret)
    .update(payload)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Contexto que viaja dentro del token:
 *   u = URL destino, h = cabeceras, k = clave XOR del manifiesto,
 *   w = modo de desempaquetado de segmentos
 */
export function encodeContext({ url, headers = {}, key = "", unwrap = "", expiresAt = 0 }) {
  return Buffer.from(
    JSON.stringify({ u: url, h: headers, k: key, w: unwrap, e: expiresAt || 0 }),
    "utf8",
  ).toString("base64url");
}

export function decodeContext(token) {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.u !== "string") return null;
    return {
      url: parsed.u,
      headers: parsed.h && typeof parsed.h === "object" ? parsed.h : {},
      key: typeof parsed.k === "string" ? parsed.k : "",
      unwrap: typeof parsed.w === "string" ? parsed.w : "",
      expiresAt: Number.isFinite(parsed.e) ? parsed.e : 0,
    };
  } catch {
    return null;
  }
}

/**
 * URL pública y firmada del proxy.
 *
 * Lleva caducidad: una URL filtrada no debe servir indefinidamente como
 * relay hacia ese destino.
 */
export function buildProxyUrl(baseUrl, context) {
  const token = encodeContext({
    ...context,
    expiresAt: context.expiresAt ?? Date.now() + config.proxyUrlTtlMs,
  });
  return `${baseUrl}/px/${sign(token)}/${token}`;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

function shouldTreatAsPlaylist(url, contentType) {
  return (
    /\.m3u8(\?|$)/i.test(url) ||
    /mpegurl/i.test(contentType || "") ||
    /application\/x-mpegurl/i.test(contentType || "")
  );
}

/**
 * Atiende GET /px/:firma/:token
 * @returns {Promise<boolean>} true si la ruta fue gestionada aquí.
 */
export async function handleProxy(req, res, { pathname, baseUrl }) {
  const match = pathname.match(/^\/px\/([a-f0-9]{32})\/(.+)$/);
  if (!match) return false;

  if (!config.proxyEnabled) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Proxy desactivado");
    return true;
  }

  bump("proxyRequests");

  const [, signature, token] = match;
  if (!timingSafeEqual(sign(token), signature)) {
    bump("proxyRejected");
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Firma no válida");
    return true;
  }

  const context = decodeContext(token);
  if (!context) {
    bump("proxyRejected");
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Token no válido");
    return true;
  }

  if (context.expiresAt && Date.now() > context.expiresAt) {
    bump("proxyRejected");
    res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Enlace caducado; vuelve a abrir el título en Stremio");
    return true;
  }

  const wantsImageUnwrap = context.unwrap === "image";

  try {
    const upstream = await upstreamSemaphore.run(() =>
      fetchWithTimeout(context.url, {
        headers: {
          ...context.headers,
          // Con desempaquetado de imagen necesitamos el objeto entero.
          ...(req.headers.range && !wantsImageUnwrap ? { Range: req.headers.range } : {}),
        },
        timeoutMs: config.fetchTimeoutMs,
      }),
    );

    const contentType = upstream.headers.get("content-type") || "";

    /* --- Playlists: descifrar si hace falta y reescribir --- */
    if (shouldTreatAsPlaylist(context.url, contentType)) {
      const raw = await readLimitedText(upstream, MAX_MANIFEST_BYTES);
      const { text } = decryptManifest(raw, context.key);

      if (!isPlaylistText(text)) {
        log("warn", `respuesta no es una playlist: ${context.url}`);
        res.writeHead(502, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
        res.end("El origen no devolvió una playlist válida");
        return true;
      }

      bump("proxyPlaylists");

      // Aquí se decide el coste: en modo "playlist" los segmentos salen
      // apuntando al CDN y no consumen ancho de banda del servicio.
      const rewritten = rewritePlaylist(text, context.url, (absolute, kind) => {
        if (!shouldProxyKind(kind, config.proxyMode)) return absolute;
        return buildProxyUrl(baseUrl, {
          url: absolute,
          headers: context.headers,
          key: context.key,
          unwrap: context.unwrap,
          expiresAt: context.expiresAt,
        });
      });

      const body = Buffer.from(rewritten, "utf8");
      bump("proxyBytes", body.length);
      res.writeHead(upstream.status === 206 ? 200 : upstream.status, {
        ...corsHeaders(),
        "Content-Type": "application/vnd.apple.mpegurl",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      res.end(body);
      return true;
    }

    /* --- Segmentos camuflados como imagen --- */
    if (wantsImageUnwrap && looksLikeImageSegment(context.url, contentType)) {
      bump("proxySegments");
      const wrapped = Buffer.from(await upstream.arrayBuffer());
      const unwrapped = unwrapImageSegment(wrapped, IMAGE_XOR_KEY);
      const body = unwrapped || wrapped;
      bump("proxyBytes", body.length);
      res.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": unwrapped ? "video/mp2t" : contentType || "application/octet-stream",
        "Content-Length": body.length,
      });
      res.end(body);
      return true;
    }

    /* --- Resto: reenvío en streaming --- */
    const outHeaders = { ...corsHeaders() };
    for (const [key, value] of upstream.headers) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
    }
    res.writeHead(upstream.status, outHeaders);

    if (req.method === "HEAD" || !upstream.body) {
      res.end();
      return true;
    }

    bump("proxySegments");
    await pumpBody(upstream.body, req, res);
    res.end();
    return true;
  } catch (error) {
    log("warn", `error en el proxy (${context.url}): ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
      res.end("Error al contactar con el origen");
    } else {
      res.end();
    }
    return true;
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Accept-Ranges": "bytes",
  };
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function readLimitedText(response, limit) {
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.subarray(0, limit).toString("utf8");
}

async function pumpBody(body, req, res) {
  const reader = body.getReader();
  let cancelled = false;
  req.on("close", () => {
    cancelled = true;
    reader.cancel().catch(() => {});
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done || cancelled) break;
    bump("proxyBytes", value.byteLength);
    if (!res.write(Buffer.from(value))) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
  }
}
