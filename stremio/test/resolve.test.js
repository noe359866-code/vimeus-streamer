import test from "node:test";
import assert from "node:assert/strict";

import { extractMediaUrls, unescapeEmbedded } from "../src/resolve.js";
import { sign, buildProxyUrl, rewritePlaylist } from "../src/proxy.js";
import { TtlCache } from "../src/cache.js";

test("deshace los escapes típicos de JS embebido", () => {
  assert.equal(unescapeEmbedded("https:\\/\\/a.test\\/b"), "https://a.test/b");
  assert.equal(unescapeEmbedded("a.test?x=1\\u0026y=2"), "a.test?x=1&y=2");
  assert.equal(unescapeEmbedded("a.test?x=1&amp;y=2"), "a.test?x=1&y=2");
});

test("extrae HLS y MP4 de HTML arbitrario", () => {
  const html = `<script>var s={file:"https:\\/\\/cdn.test\\/v\\/master.m3u8?t=1"};</script>
                <source src="https://cdn.test/v/1080.mp4">`;
  const media = extractMediaUrls(html);
  const urls = media.map((item) => item.url);
  assert.ok(urls.includes("https://cdn.test/v/master.m3u8?t=1"));
  assert.ok(urls.includes("https://cdn.test/v/1080.mp4"));
  assert.equal(media.find((item) => item.kind === "hls").quality, "Auto");
  assert.equal(media.find((item) => item.kind === "mp4").quality, "1080p");
});

test("descarta anuncios y duplicados", () => {
  const html = `
    "https://cdn.test/ads/preroll.mp4"
    "https://cdn.test/v/master.m3u8"
    "https://cdn.test/v/master.m3u8"
    "https://cdn.test/trailer/x.mp4"`;
  const media = extractMediaUrls(html);
  assert.equal(media.length, 1);
  assert.equal(media[0].url, "https://cdn.test/v/master.m3u8");
});

test("ignora texto sin medios", () => {
  assert.deepEqual(extractMediaUrls("<html><body>sin vídeo</body></html>"), []);
});

test("las URLs del proxy van firmadas", () => {
  const url = buildProxyUrl("https://addon.test", "https://cdn.test/v/master.m3u8", {
    Referer: "https://vidcore.org/",
  });
  const match = url.match(/^https:\/\/addon\.test\/px\/([a-f0-9]{32})\/(.+)$/);
  assert.ok(match, "formato /px/<firma>/<token>");
  assert.equal(sign(match[2]), match[1]);
  assert.notEqual(sign(`${match[2]}x`), match[1]);
});

test("rewritePlaylist redirige segmentos y claves al proxy", () => {
  const playlist = [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    "#EXTINF:6.0,",
    "seg1.ts",
    "#EXTINF:6.0,",
    "https://otro.test/seg2.ts",
  ].join("\n");

  const output = rewritePlaylist(
    playlist,
    "https://cdn.test/v/master.m3u8",
    { Referer: "https://vidcore.org/" },
    "https://addon.test",
  );

  assert.ok(output.startsWith("#EXTM3U"));
  assert.match(output, /URI="https:\/\/addon\.test\/px\//);
  const lines = output.split("\n").filter((line) => !line.startsWith("#"));
  assert.ok(lines.every((line) => line.startsWith("https://addon.test/px/")));
  assert.equal(lines.length, 2);
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
  assert.equal(await cache.wrap("k", producer), "valor");
  assert.equal(calls, 1);
});
