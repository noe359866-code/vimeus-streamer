/**
 * Proxy HLS/MP4 con cabeceras.
 *
 * Algunos clientes (Stremio Web, ciertas TV) ignoran behaviorHints.proxyHeaders,
 * así que ofrecemos una ruta propia que reenvía Referer/Origin y reescribe las
 * listas .m3u8 para que los segmentos pasen también por aquí.
 *
 * Las URLs van firmadas con HMAC para que esto no se convierta en un proxy
 * abierto que cualquiera pueda usar.
 */

import crypto from "node:crypto";
import { config } from "./config.js";
import { fetchWithTimeout, log } from "./http.js";

export function sign(payload) {
  return crypto
    .createHmac("sha256", config.proxySecret)
    .update(payload)
    .digest("hex")
    .slice(0, 32);
}

function encodePayload(targetUrl, headers) {
  return Buffer.from(JSON.stringify({ u: targetUrl, h: headers || {} }), "utf8").toString(
    "base64url",
  );
}

function decodePayload(token) {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.u !== "string") return null;
    return { url: parsed.u, headers: parsed.h && typeof parsed.h === "object" ? parsed.h : {} };
  } catch {
    return null;
  }
}

/** Construye la URL pública del proxy para un enlace de medios. */
export function buildProxyUrl(baseUrl, targetUrl, headers) {
  const token = encodePayload(targetUrl, headers);
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

function isPlaylist(targetUrl, contentType) {
  return (
    /\.m3u8(\?|$)/i.test(targetUrl) ||
    /mpegurl/i.test(contentType || "")
  );
}

/** Reescribe un .m3u8 para que segmentos y sub-listas pasen por el proxy. */
export function rewritePlaylist(body, targetUrl, headers, baseUrl) {
  const lines = body.split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        // Claves y mapas de inicialización también necesitan cabeceras.
        return line.replace(/URI="([^"]+)"/gi, (full, uri) => {
          const absolute = safeAbsolute(uri, targetUrl);
          return absolute ? `URI="${buildProxyUrl(baseUrl, absolute, headers)}"` : full;
        });
      }

      const absolute = safeAbsolute(trimmed, targetUrl);
      return absolute ? buildProxyUrl(baseUrl, absolute, headers) : line;
    })
    .join("\n");
}

function safeAbsolute(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Maneja GET /px/:sig/:token
 * @returns {Promise<boolean>} true si la ruta fue atendida.
 */
export async function handleProxy(req, res, { pathname, baseUrl }) {
  const match = pathname.match(/^\/px\/([a-f0-9]{32})\/(.+)$/);
  if (!match) return false;

  if (!config.proxyEnabled) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Proxy desactivado");
    return true;
  }

  const [, signature, token] = match;
  if (sign(token) !== signature) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Firma no válida");
    return true;
  }

  const payload = decodePayload(token);
  if (!payload) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Token no válido");
    return true;
  }

  try {
    const upstream = await fetchWithTimeout(payload.url, {
      headers: {
        ...payload.headers,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      timeoutMs: config.fetchTimeoutMs,
    });

    const contentType = upstream.headers.get("content-type") || "";

    if (isPlaylist(payload.url, contentType)) {
      const body = await upstream.text();
      const rewritten = rewritePlaylist(body, payload.url, payload.headers, baseUrl);
      res.writeHead(upstream.status, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end(rewritten);
      return true;
    }

    const outHeaders = { "Access-Control-Allow-Origin": "*" };
    for (const [key, value] of upstream.headers) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
    }
    res.writeHead(upstream.status, outHeaders);

    if (!upstream.body) {
      res.end();
      return true;
    }

    const reader = upstream.body.getReader();
    const pump = async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    };
    req.on("close", () => reader.cancel().catch(() => {}));
    await pump();
    res.end();
    return true;
  } catch (error) {
    log("warn", "error en el proxy:", error.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("Error al contactar con el origen");
    return true;
  }
}
