import test from "node:test";
import assert from "node:assert/strict";

import { extractMediaUrls, guessQuality, unescapeEmbedded } from "../src/extractors/generic.js";
import { expandTemplate, normalizeResolverPayload } from "../src/extractors/bridge.js";

/* --------------------------- extractor genérico --------------------------- */

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

test("guessQuality reconoce 4K", () => {
  assert.equal(guessQuality("https://x.test/2160p/a.m3u8"), "4K");
  assert.equal(guessQuality("https://x.test/720p/a.m3u8"), "720p");
  assert.equal(guessQuality("https://x.test/master.m3u8"), "Auto");
});

/* ------------------------- puente al resolvedor --------------------------- */

test("expandTemplate sustituye los marcadores y codifica", () => {
  const url = expandTemplate(
    "https://r.test/api?type={type}&tmdb={tmdb}&s={season}&e={episode}&t={title}",
    { type: "series", tmdb: 1396, season: 1, episode: 2, title: "Breaking Bad" },
  );
  assert.equal(url, "https://r.test/api?type=series&tmdb=1396&s=1&e=2&t=Breaking%20Bad");
});

test("expandTemplate deja vacíos los marcadores sin valor", () => {
  assert.equal(
    expandTemplate("https://r.test/?a={anilist}&b={tmdb}", { tmdb: 5 }),
    "https://r.test/?a=&b=5",
  );
});

test("normaliza una respuesta plana {url}", () => {
  const media = normalizeResolverPayload({ url: "https://cdn.test/master.m3u8" });
  assert.equal(media.length, 1);
  assert.equal(media[0].kind, "hls");
  assert.equal(media[0].url, "https://cdn.test/master.m3u8");
});

test("normaliza {sources:[...]} con calidad y cabeceras", () => {
  const media = normalizeResolverPayload({
    referer: "https://flixcloud.cc/",
    sources: [
      { url: "https://cdn.test/1080.m3u8", quality: "1080p", type: "hls" },
      { file: "https://cdn.test/720.mp4", label: "720p" },
    ],
  });

  assert.equal(media.length, 2);
  assert.equal(media[0].quality, "1080p");
  assert.equal(media[0].headers.Referer, "https://flixcloud.cc/");
  assert.equal(media[0].headers.Origin, "https://flixcloud.cc");
  assert.equal(media[1].kind, "mp4");
  assert.equal(media[1].quality, "720p");
});

test("normaliza {data:{sources:[...]}} anidado", () => {
  const media = normalizeResolverPayload({
    data: { sources: [{ link: "https://cdn.test/a.m3u8" }] },
  });
  assert.equal(media.length, 1);
  assert.equal(media[0].url, "https://cdn.test/a.m3u8");
});

test("recoge playlist_key, unwrap y subtítulos", () => {
  const media = normalizeResolverPayload({
    sources: [{ url: "https://cdn.test/a.m3u8", playlist_key: "a2V5", unwrap: "flixcloud-hd2" }],
    subtitles: [
      { url: "https://cdn.test/es.vtt", lang: "spa" },
      "https://cdn.test/en.vtt",
    ],
  });

  assert.equal(media[0].playlistKey, "a2V5");
  assert.equal(media[0].unwrap, "flixcloud-hd2");
  assert.equal(media[0].subtitles.length, 2);
  assert.equal(media[0].subtitles[0].lang, "spa");
  assert.equal(media[0].subtitles[1].lang, "und");
});

test("ignora entradas sin URL utilizable", () => {
  assert.deepEqual(normalizeResolverPayload({ sources: [{ quality: "1080p" }] }), []);
  assert.deepEqual(normalizeResolverPayload({ error: "not found" }), []);
  assert.deepEqual(normalizeResolverPayload(null), []);
});

test("rechaza URLs que no son http(s)", () => {
  assert.deepEqual(normalizeResolverPayload({ url: "javascript:alert(1)" }), []);
  assert.deepEqual(normalizeResolverPayload({ url: "blob:https://flixcloud.cc/abc" }), []);
});
