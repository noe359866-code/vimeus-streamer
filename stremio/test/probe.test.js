import test from "node:test";
import assert from "node:assert/strict";

import { hostOf, mustProxy, isInsecure, decideDelivery } from "../src/probe.js";

test("mustProxy: un manifiesto cifrado no puede ir directo", () => {
  assert.equal(mustProxy({ url: "https://cdn.test/a.m3u8", playlistKey: "a2V5" }), true);
});

test("mustProxy: los segmentos envueltos en imagen tampoco", () => {
  assert.equal(mustProxy({ url: "https://cdn.test/a.m3u8", unwrap: "flixcloud-hd2" }), true);
});

test("mustProxy: un HLS normal sí puede ir directo", () => {
  assert.equal(mustProxy({ url: "https://cdn.test/a.m3u8" }), false);
  assert.equal(mustProxy({ url: "https://cdn.test/a.m3u8", playlistKey: "", unwrap: "" }), false);
});

test("mustProxy tolera entradas vacías", () => {
  assert.equal(mustProxy(null), false);
  assert.equal(mustProxy(undefined), false);
});

test("hostOf extrae el host y descarta basura", () => {
  assert.equal(hostOf("https://cdn.test:8443/v/a.m3u8?x=1"), "cdn.test:8443");
  assert.equal(hostOf("no-es-una-url"), null);
});

test("isInsecure: un http:// público no es apto para entrega directa", () => {
  assert.equal(isInsecure("http://cdn.ejemplo.com/master.m3u8"), true);
  assert.equal(isInsecure("https://cdn.ejemplo.com/master.m3u8"), false);
  // El bucle local es contexto seguro para el navegador: no estorba en desarrollo.
  assert.equal(isInsecure("http://127.0.0.1:7999/master.m3u8"), false);
  assert.equal(isInsecure("http://localhost:7999/master.m3u8"), false);
});

test("auto: un CDN sin HTTPS va por el proxy sin llegar a sondear", async () => {
  const decision = await decideDelivery(
    { url: "http://cdn.ejemplo.com/master.m3u8" },
    { proxyAvailable: true },
  );
  assert.equal(decision.viaProxy, true);
  assert.equal(decision.reason, "el CDN no usa HTTPS");
});

test("sin proxy disponible nunca se promete un proxy", async () => {
  const decision = await decideDelivery(
    { url: "https://cdn.ejemplo.com/master.m3u8", playlistKey: "abc" },
    { proxyAvailable: false },
  );
  assert.equal(decision.viaProxy, false);
});
