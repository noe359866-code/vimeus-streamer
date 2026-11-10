import test from "node:test";
import assert from "node:assert/strict";

import { CircuitBreaker, RateLimiter, Semaphore, clientIp } from "../src/limits.js";
import { classifyUri, rewritePlaylist, shouldProxyKind } from "../src/hls.js";

/* ----------------------- clasificación de recursos ----------------------- */

test("classifyUri distingue playlists, claves, mapas y segmentos", () => {
  assert.equal(classifyUri("https://cdn.test/v/1080/index.m3u8"), "playlist");
  assert.equal(classifyUri("seg0001.ts"), "segment");
  assert.equal(classifyUri("frag.m4s"), "segment");
  assert.equal(classifyUri("key.bin", "#EXT-X-KEY"), "key");
  assert.equal(classifyUri("init.mp4", "#EXT-X-MAP"), "map");
  assert.equal(classifyUri("audio/en.m3u8", "#EXT-X-MEDIA"), "playlist");
});

test("shouldProxyKind implementa los tres modos", () => {
  // full: todo pasa por el servicio
  for (const kind of ["playlist", "key", "map", "segment"]) {
    assert.equal(shouldProxyKind(kind, "full"), true);
  }
  // playlist: todo menos los segmentos, que son el 99,9 % de los bytes
  assert.equal(shouldProxyKind("playlist", "playlist"), true);
  assert.equal(shouldProxyKind("key", "playlist"), true);
  assert.equal(shouldProxyKind("map", "playlist"), true);
  assert.equal(shouldProxyKind("segment", "playlist"), false);
  // off: nada
  for (const kind of ["playlist", "key", "map", "segment"]) {
    assert.equal(shouldProxyKind(kind, "off"), false);
  }
});

test("en modo playlist los segmentos salen apuntando al CDN y las claves no", () => {
  const input = [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    "#EXTINF:6.0,",
    "seg1.ts",
    "#EXTINF:6.0,",
    "seg2.ts",
  ].join("\n");

  const output = rewritePlaylist(input, "https://cdn.test/v/index.m3u8", (url, kind) =>
    shouldProxyKind(kind, "playlist") ? `PROXY(${url})` : url,
  );

  assert.match(output, /URI="PROXY\(https:\/\/cdn\.test\/v\/key\.bin\)"/, "la clave sí");
  assert.match(output, /^https:\/\/cdn\.test\/v\/seg1\.ts$/m, "el segmento va directo");
  assert.match(output, /^https:\/\/cdn\.test\/v\/seg2\.ts$/m);
  assert.ok(!output.includes("PROXY(https://cdn.test/v/seg"), "ningún segmento proxificado");
});

test("en modo full todo pasa por el proxy", () => {
  const input = "#EXTM3U\n#EXTINF:6.0,\nseg1.ts";
  const output = rewritePlaylist(input, "https://cdn.test/v/index.m3u8", (url, kind) =>
    shouldProxyKind(kind, "full") ? `PROXY(${url})` : url,
  );
  assert.match(output, /^PROXY\(https:\/\/cdn\.test\/v\/seg1\.ts\)$/m);
});

/* ------------------------------- semáforo -------------------------------- */

test("el semáforo limita la concurrencia", async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 10 }, () =>
      semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    ),
  );

  assert.equal(peak, 2, "nunca más de 2 a la vez");
  assert.equal(semaphore.active, 0, "se liberan todas las plazas");
});

test("el semáforo libera la plaza aunque la tarea falle", async () => {
  const semaphore = new Semaphore(1);
  await assert.rejects(() => semaphore.run(async () => { throw new Error("boom"); }));
  assert.equal(semaphore.active, 0);
  assert.equal(await semaphore.run(async () => "ok"), "ok");
});

/* ----------------------------- cortocircuito ----------------------------- */

test("el cortocircuito se abre tras N fallos y deja de permitir intentos", () => {
  const breaker = new CircuitBreaker({ threshold: 3, resetMs: 10_000, name: "prueba" });
  assert.equal(breaker.allow(), true);

  breaker.onFailure();
  breaker.onFailure();
  assert.equal(breaker.allow(), true, "aún por debajo del umbral");

  breaker.onFailure();
  assert.equal(breaker.isOpen, true);
  assert.equal(breaker.allow(), false, "abierto: no se intenta");
});

test("un éxito reinicia el contador de fallos", () => {
  const breaker = new CircuitBreaker({ threshold: 2, resetMs: 10_000 });
  breaker.onFailure();
  breaker.onSuccess();
  breaker.onFailure();
  assert.equal(breaker.allow(), true, "el éxito borró el fallo anterior");
});

test("tras el tiempo de reposo deja pasar una petición de prueba", async () => {
  const breaker = new CircuitBreaker({ threshold: 1, resetMs: 20 });
  breaker.onFailure();
  assert.equal(breaker.allow(), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(breaker.allow(), true, "medio abierto");
});

/* ------------------------------ límite por IP ---------------------------- */

test("el limitador corta al superar el máximo en la ventana", () => {
  const limiter = new RateLimiter({ windowMs: 10_000, max: 3 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.check("1.2.3.4").allowed, true, `petición ${i + 1}`);
  }
  const blocked = limiter.check("1.2.3.4");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0);
});

test("el limitador cuenta cada IP por separado", () => {
  const limiter = new RateLimiter({ windowMs: 10_000, max: 1 });
  assert.equal(limiter.check("1.1.1.1").allowed, true);
  assert.equal(limiter.check("1.1.1.1").allowed, false);
  assert.equal(limiter.check("2.2.2.2").allowed, true, "otra IP no se ve afectada");
});

test("la ventana se reinicia al expirar", async () => {
  const limiter = new RateLimiter({ windowMs: 20, max: 1 });
  assert.equal(limiter.check("x").allowed, true);
  assert.equal(limiter.check("x").allowed, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(limiter.check("x").allowed, true);
});

test("clientIp respeta X-Forwarded-For (Render va detrás de un proxy)", () => {
  assert.equal(
    clientIp({ headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, socket: {} }),
    "203.0.113.7",
  );
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "10.1.2.3" } }), "10.1.2.3");
});
