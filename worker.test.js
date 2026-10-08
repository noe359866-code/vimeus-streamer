import assert from "node:assert/strict";
import test from "node:test";
import worker, { buildEmbedUrl, formatDynamicTitle, parseId } from "./worker.js";

const HLS_URL = "https://cdn.vimeus.test/video/master.m3u8?token=abc&expires=42";

async function withFetch(mockFetch, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function responseWithJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function escapedHtml(url) {
  return `<script>const playlist = ${JSON.stringify(url).replaceAll("/", "\\/")};</script>`;
}

test("serves a Stremio manifest and CORS preflight", async () => {
  const manifestResponse = await worker.fetch(
    new Request("https://addon.test/manifest.json"),
  );
  const manifest = await manifestResponse.json();

  assert.equal(manifest.id, "com.vimeus.streamer");
  assert.equal(manifest.name, "Vimeus Streamer");
  assert.deepEqual(manifest.resources, ["stream"]);
  assert.deepEqual(manifest.types, ["movie", "series"]);
  assert.equal(
    manifestResponse.headers.get("access-control-allow-origin"),
    "*",
  );
  assert.match(
    manifestResponse.headers.get("content-type"),
    /application\/json/i,
  );

  const optionsResponse = await worker.fetch(
    new Request("https://addon.test/manifest.json", { method: "OPTIONS" }),
  );
  assert.equal(optionsResponse.status, 200);
  assert.equal(optionsResponse.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});

test("parses Stremio ids and builds Vimeus embed URLs", () => {
  assert.deepEqual(parseId("tt0944947:1:2"), {
    imdb: "tt0944947",
    season: "1",
    episode: "2",
  });
  assert.deepEqual(parseId("tmdb%3A1429%3A2%3A3"), {
    tmdb: "1429",
    season: "2",
    episode: "3",
  });

  const embedUrl = new URL(
    buildEmbedUrl(
      "series",
      { tmdb: "1429", season: "2", episode: "3" },
      "test-view-key",
    ),
  );
  assert.equal(embedUrl.origin, "https://vimeus.com");
  assert.equal(embedUrl.pathname, "/e/serie");
  assert.equal(embedUrl.searchParams.get("tmdb"), "1429");
  assert.equal(embedUrl.searchParams.get("se"), "2");
  assert.equal(embedUrl.searchParams.get("ep"), "3");
  assert.equal(embedUrl.searchParams.get("view_key"), "test-view-key");
  assert.equal(formatDynamicTitle("Attack on Titan", "series", { season: "1", episode: "1" }), "Attack on Titan T1-Cap1");
  assert.equal(formatDynamicTitle("Fight Club", "movie", {}), "Fight Club • Full HD");
});

test("returns a Stremio movie stream, with proxy, metadata and Vimeus headers", async () => {
  const calls = [];
  await withFetch(async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    if (url.hostname === "v3-cinemeta.strem.fun") {
      assert.equal(url.pathname, "/meta/movie/tt0133093.json");
      return responseWithJson({ meta: { name: "Fight Club" } });
    }

    assert.equal(url.hostname, "proxy.example");
    assert.equal(url.pathname, "/fetch");
    assert.equal(url.searchParams.get("token"), "proxy-token");
    assert.equal(new Headers(init.headers).get("referer"), "https://vimeus.com/");
    assert.match(new Headers(init.headers).get("user-agent"), /Mozilla\/5\.0/);
    return new Response(escapedHtml(HLS_URL));
  }, async () => {
    const response = await worker.fetch(
      new Request("https://addon.test/stream/movie/tt0133093.json"),
      {
        VIEW_KEY: "test-view-key",
        PROXY_URL: "https://proxy.example/fetch?token=proxy-token",
      },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.streams.length, 1);
    assert.equal(body.streams[0].name, "Vimeus Streamer");
    assert.equal(body.streams[0].title, "Fight Club • Full HD");
    assert.equal(body.streams[0].url, HLS_URL);
    assert.equal(body.streams[0].behaviorHints.notSupported, false);
    assert.deepEqual(body.streams[0].behaviorHints.requestHeaders, {
      Referer: "https://vimeus.com/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });

    const proxyCall = calls.find(({ url }) => url.hostname === "proxy.example");
    const embedUrl = new URL(proxyCall.url.searchParams.get("url"));
    assert.equal(embedUrl.pathname, "/e/movie");
    assert.equal(embedUrl.searchParams.get("imdb"), "tt0133093");
    assert.equal(embedUrl.searchParams.get("view_key"), "test-view-key");
  });
});

test("returns a Stremio series stream for a TMDb id", async () => {
  let embedUrl;
  await withFetch(async (input) => {
    const url = new URL(input);
    if (url.hostname === "v3-cinemeta.strem.fun") {
      assert.equal(url.pathname, "/meta/series/1429.json");
      return responseWithJson({ meta: { name: "Attack on Titan" } });
    }

    embedUrl = url;
    return new Response(escapedHtml(HLS_URL));
  }, async () => {
    const response = await worker.fetch(
      new Request("https://addon.test/stream/series/tmdb%3A1429%3A2%3A3.json"),
    );
    const body = await response.json();

    assert.equal(body.streams[0].title, "Attack on Titan T2-Cap3");
    assert.equal(body.streams[0].url, HLS_URL);
    assert.equal(embedUrl.pathname, "/e/serie");
    assert.equal(embedUrl.searchParams.get("tmdb"), "1429");
    assert.equal(embedUrl.searchParams.get("se"), "2");
    assert.equal(embedUrl.searchParams.get("ep"), "3");
  });
});

test("returns an empty stream list when no HLS playlist is found", async () => {
  await withFetch(async (input) => {
    const url = new URL(input);
    if (url.hostname === "v3-cinemeta.strem.fun") {
      return responseWithJson({ meta: { name: "Unknown film" } });
    }
    return new Response("<html>No playable source</html>");
  }, async () => {
    const response = await worker.fetch(
      new Request("https://addon.test/stream/movie/tt0000001.json"),
    );
    assert.deepEqual(await response.json(), { streams: [] });
  });
});

test("serves the Kodi stream format and validates Kodi parameters", async () => {
  await withFetch(async (input) => {
    const url = new URL(input);
    if (url.hostname === "v3-cinemeta.strem.fun") {
      return responseWithJson({ meta: { name: "Attack on Titan" } });
    }
    return new Response(escapedHtml(HLS_URL));
  }, async () => {
    const response = await worker.fetch(
      new Request(
        "https://addon.test/kodi/stream?type=series&imdb=tt0944947&se=1&ep=2",
      ),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.title, "Attack on Titan T1-Cap2");
    assert.equal(body.raw_hls, HLS_URL);
    assert.equal(
      body.url,
      `${HLS_URL}|Referer=https://vimeus.com/&User-Agent=Mozilla/5.0`,
    );

    const missingId = await worker.fetch(
      new Request("https://addon.test/kodi/stream?type=movie"),
    );
    assert.equal(missingId.status, 400);
    const invalidType = await worker.fetch(
      new Request("https://addon.test/kodi/stream?type=anime&imdb=tt1234567"),
    );
    assert.equal(invalidType.status, 400);
  });
});

test("reports upstream playback errors without leaking a failed stream", async () => {
  await withFetch(async (input) => {
    const url = new URL(input);
    if (url.hostname === "v3-cinemeta.strem.fun") {
      return responseWithJson({ meta: { name: "Test" } });
    }
    return new Response("upstream unavailable", { status: 502 });
  }, async () => {
    const response = await worker.fetch(
      new Request("https://addon.test/stream/movie/tt1234567.json"),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      streams: [],
      error: "Error en el servidor de reproducción (502)",
    });
  });
});
