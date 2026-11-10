import test from "node:test";
import assert from "node:assert/strict";

import { buildProxyUrl, decodeContext, encodeContext, sign } from "../src/proxy.js";
import { TtlCache } from "../src/cache.js";

test("el contexto del proxy sobrevive al ida y vuelta", () => {
  const context = {
    url: "https://cdn.test/v/master.m3u8?t=1",
    headers: { Referer: "https://vidcore.org/", Origin: "https://vidcore.org" },
    key: "YWJjZA==",
    unwrap: "image",
  };
  const decoded = decodeContext(encodeContext(context));
  assert.deepEqual(decoded, context);
});

test("decodeContext rechaza tokens corruptos", () => {
  assert.equal(decodeContext("no-es-base64-json"), null);
  assert.equal(decodeContext(Buffer.from('{"x":1}').toString("base64url")), null);
});

test("las URLs del proxy van firmadas con HMAC", () => {
  const url = buildProxyUrl("https://addon.test", {
    url: "https://cdn.test/v/master.m3u8",
    headers: { Referer: "https://vidcore.org/" },
  });

  const match = url.match(/^https:\/\/addon\.test\/px\/([a-f0-9]{32})\/(.+)$/);
  assert.ok(match, "formato /px/<firma>/<token>");
  assert.equal(sign(match[2]), match[1]);
  assert.notEqual(sign(`${match[2]}x`), match[1], "la firma depende del token");
});

test("la firma cambia si cambia el destino", () => {
  const a = buildProxyUrl("https://addon.test", { url: "https://cdn.test/a.m3u8" });
  const b = buildProxyUrl("https://addon.test", { url: "https://cdn.test/b.m3u8" });
  assert.notEqual(a, b);
});

test("el contexto conserva la clave del manifiesto y el modo de desempaquetado", () => {
  const url = buildProxyUrl("https://addon.test", {
    url: "https://cdn.test/seg.png",
    headers: {},
    key: "a2V5",
    unwrap: "image",
  });
  const token = url.split("/").pop();
  const context = decodeContext(token);
  assert.equal(context.key, "a2V5");
  assert.equal(context.unwrap, "image");
});

test("la caché respeta el TTL y el límite de entradas", async () => {
  const cache = new TtlCache({ ttlMs: 20, maxEntries: 2 });
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cache.get("a"), undefined, "expira por TTL");

  const big = new TtlCache({ ttlMs: 1000, maxEntries: 2 });
  big.set("a", 1);
  big.set("b", 2);
  big.set("c", 3);
  assert.equal(big.size, 2);
  assert.equal(big.get("a"), undefined, "se descarta la más antigua");
  assert.equal(big.get("c"), 3);
});

test("wrap memoiza y evita llamadas duplicadas en paralelo", async () => {
  const cache = new TtlCache({ ttlMs: 1000, maxEntries: 10 });
  let calls = 0;
  const producer = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "valor";
  };
  const [a, b] = await Promise.all([cache.wrap("k", producer), cache.wrap("k", producer)]);
  assert.equal(a, "valor");
  assert.equal(b, "valor");
  assert.equal(calls, 1);
});
