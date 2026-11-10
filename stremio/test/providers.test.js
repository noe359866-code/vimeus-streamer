import test from "node:test";
import assert from "node:assert/strict";

import * as vidcore from "../src/providers/vidcore.js";
import * as chillflix from "../src/providers/chillflix.js";
import * as nekowatch from "../src/providers/nekowatch.js";
import { buildManifest } from "../src/manifest.js";
import { activeProviders } from "../src/providers/index.js";

test("VidCore construye las rutas documentadas", () => {
  assert.equal(
    vidcore.buildUrl({ tmdbId: 603, type: "movie" }),
    "https://vidcore.org/embed/movie/603",
  );
  assert.equal(
    vidcore.buildUrl({ tmdbId: 1396, type: "series", season: 2, episode: 7 }),
    "https://vidcore.org/embed/tv/1396/2/7",
  );
});

test("Chillflix usa el host del reproductor y los flags correctos", () => {
  const url = new URL(chillflix.buildUrl({ tmdbId: 315162, type: "movie" }));
  assert.equal(url.origin, "https://www.chillflix.pw");
  assert.equal(url.pathname, "/embed/movie/315162");
  assert.equal(url.searchParams.get("autoplay"), "true");
  assert.equal(url.searchParams.get("watchparty"), "false");
  assert.equal(url.searchParams.get("title"), "false");
});

test("Chillflix añade season/episode y autonext en series", () => {
  const url = new URL(
    chillflix.buildUrl({ tmdbId: 1396, type: "series", season: 1, episode: 1 }),
  );
  assert.equal(url.pathname, "/embed/tv/1396/1/1");
  assert.equal(url.searchParams.get("autonext"), "true");
});

test("Chillflix propaga parent_origin cuando se conoce", () => {
  const url = new URL(
    chillflix.buildUrl({
      tmdbId: 550,
      type: "movie",
      parentOrigin: "https://ejemplo.onrender.com",
    }),
  );
  assert.equal(url.searchParams.get("parent_origin"), "https://ejemplo.onrender.com");
});

test("NekoWatch indexa por AniList y omite ?ep en el primer episodio", () => {
  assert.equal(
    nekowatch.buildUrl({ anilistId: 195604, episode: 1 }),
    "https://nekowatch.xyz/watch/195604",
  );
  assert.equal(
    nekowatch.buildUrl({ anilistId: 195604, episode: 12 }),
    "https://nekowatch.xyz/watch/195604?ep=12",
  );
  assert.equal(
    nekowatch.buildUrl({ anilistId: 21, episode: null }),
    "https://nekowatch.xyz/watch/21",
  );
});

test("los proveedores declaran qué identificador necesitan", () => {
  assert.equal(vidcore.needs, "tmdb");
  assert.equal(chillflix.needs, "tmdb");
  assert.equal(nekowatch.needs, "anilist");
});

test("por defecto se activan los tres proveedores", () => {
  const ids = activeProviders().map((provider) => provider.id);
  assert.deepEqual(ids, ["vidcore", "chillflix", "nekowatch"]);
});

test("el manifiesto solo expone el recurso stream", () => {
  const manifest = buildManifest();
  assert.deepEqual(manifest.resources, ["stream"]);
  assert.deepEqual(manifest.catalogs, []);
  assert.ok(manifest.types.includes("movie"));
  assert.ok(manifest.types.includes("series"));
  assert.ok(manifest.idPrefixes.includes("tt"));
  assert.ok(manifest.idPrefixes.includes("kitsu:"));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});
