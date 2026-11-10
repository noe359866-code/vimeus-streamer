/**
 * Servidor HTTP del addon (sin dependencias externas).
 *
 * Rutas:
 *   GET /                          página de instalación
 *   GET /health                    healthcheck para Render
 *   GET /manifest.json             manifiesto de Stremio
 *   GET /stream/:type/:id.json     streams
 *   GET /px/:sig/:token            proxy HLS/MP4 con cabeceras
 */

import http from "node:http";
import { config } from "./config.js";
import { buildManifest } from "./manifest.js";
import { getStreams } from "./streams.js";
import { handleProxy } from "./proxy.js";
import { log } from "./http.js";
import { landingPage } from "./landing.js";
import { snapshot, bump } from "./metrics.js";
import { breakerStates, clientIp, streamRateLimiter, upstreamSemaphore } from "./limits.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function sendJson(res, payload, status = 200, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    ...CORS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

/** URL pública real: respeta PUBLIC_URL y, si no, los headers del proxy. */
export function resolveBaseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  if (!host) return "";
  return `${proto}://${host}`;
}

export async function handleRequest(req, res) {
  const started = Date.now();

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, { error: "Método no permitido" }, 405, { Allow: "GET, HEAD, OPTIONS" });
    return;
  }

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    sendJson(res, { error: "URL no válida" }, 400);
    return;
  }

  const pathname = decodeURI(url.pathname).replace(/\/{2,}/g, "/");
  const baseUrl = resolveBaseUrl(req);

  try {
    // --- Proxy de medios -------------------------------------------------
    if (pathname.startsWith("/px/")) {
      const handled = await handleProxy(req, res, { pathname: url.pathname, baseUrl });
      if (handled) return;
    }

    // --- Healthcheck -----------------------------------------------------
    if (pathname === "/health" || pathname === "/healthz") {
      const memory = process.memoryUsage();
      sendJson(res, {
        ok: true,
        name: config.addonName,
        version: config.addonVersion,
        providers: config.providers,
        resolveDirect: config.resolveDirect,
        proxyMode: config.proxyMode,
        resolvers: Object.fromEntries(
          Object.entries(config.resolvers).map(([key, value]) => [key, Boolean(value)]),
        ),
        metrics: snapshot(),
        breakers: breakerStates(),
        upstream: { active: upstreamSemaphore.active, pending: upstreamSemaphore.pending },
        rateLimitTracked: streamRateLimiter.size,
        memoryMb: Math.round(memory.rss / 1024 / 1024),
        uptime: Math.round(process.uptime()),
      });
      return;
    }

    // --- Manifiesto ------------------------------------------------------
    if (pathname === "/manifest.json") {
      sendJson(res, buildManifest(), 200, { "Cache-Control": "public, max-age=600" });
      return;
    }

    // --- Streams ---------------------------------------------------------
    const streamMatch = pathname.match(
      /^\/stream\/(movie|series|anime|tv)\/(.+?)\.json$/i,
    );
    if (streamMatch) {
      if (config.rateLimitEnabled) {
        const { allowed, retryAfter } = streamRateLimiter.check(clientIp(req));
        if (!allowed) {
          bump("rateLimited");
          sendJson(res, { streams: [] }, 429, { "Retry-After": String(retryAfter) });
          return;
        }
      }
      const type = streamMatch[1].toLowerCase() === "tv" ? "series" : streamMatch[1].toLowerCase();
      const payload = await getStreams(type, streamMatch[2], { baseUrl });
      sendJson(res, payload, 200, { "Cache-Control": "public, max-age=300" });
      log(
        "debug",
        `${req.method} ${pathname} -> ${payload.streams.length} streams (${Date.now() - started}ms)`,
      );
      return;
    }

    // --- Página de inicio ------------------------------------------------
    if (pathname === "/" || pathname === "/index.html" || pathname === "/configure") {
      sendHtml(res, landingPage(baseUrl));
      return;
    }

    sendJson(res, { error: "No encontrado" }, 404);
  } catch (error) {
    bump("errors");
    log("error", `fallo en ${pathname}:`, error);
    if (!res.headersSent) sendJson(res, { streams: [], error: "Error interno" }, 500);
    else res.end();
  }
}

export function createServer() {
  const server = http.createServer(handleRequest);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  return server;
}

// Arranque solo cuando se ejecuta como entrypoint (no al importarlo en tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    log("info", `${config.addonName} v${config.addonVersion} escuchando en ${config.host}:${config.port}`);
    log("info", `Proveedores activos: ${config.providers.join(", ") || "ninguno"}`);
    log("info", `Resolución directa: ${config.resolveDirect ? "activada" : "desactivada"}`);
    log("info", `Modo de proxy: ${config.proxyMode}`);
    if (config.proxyMode === "full") {
      log(
        "warn",
        "PROXY_MODE=full retransmite TODO el vídeo por este servicio " +
          "(~2,2 GB por hora y espectador en 1080p). Usa 'playlist' si tienes tráfico real.",
      );
    }
    if (config.proxySecretIsEphemeral) {
      log(
        "warn",
        "PROXY_SECRET no está definido: se generó uno aleatorio. Con más de una " +
          "instancia las URLs firmadas por una serán rechazadas por las demás, y " +
          "cada reinicio invalida las que ya estén en uso.",
      );
    }
    if (config.publicUrl) log("info", `URL pública: ${config.publicUrl}/manifest.json`);
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      log("info", `${signal} recibido, cerrando...`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
