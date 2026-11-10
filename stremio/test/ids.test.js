import test from "node:test";
import assert from "node:assert/strict";

import { parseStreamId, seasonEpisode, describeId } from "../src/ids.js";

test("parsea un id de IMDb de película", () => {
  const parsed = parseStreamId("movie", "tt0133093");
  assert.equal(parsed.source, "imdb");
  assert.equal(parsed.id, "tt0133093");
  assert.equal(parsed.season, null);
  assert.equal(parsed.episode, null);
  assert.equal(parsed.type, "movie");
});

test("parsea un id de IMDb con temporada y episodio", () => {
  const parsed = parseStreamId("series", "tt0944947:2:9");
  assert.equal(parsed.source, "imdb");
  assert.equal(parsed.id, "tt0944947");
  assert.equal(parsed.season, 2);
  assert.equal(parsed.episode, 9);
});

test("acepta el sufijo .json y los valores codificados", () => {
  const parsed = parseStreamId("series", encodeURIComponent("tt0944947:1:1") + ".json");
  assert.equal(parsed.id, "tt0944947");
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 1);
});

test("parsea ids de TMDB", () => {
  assert.equal(parseStreamId("movie", "tmdb:550").id, "550");
  const serie = parseStreamId("series", "tmdb:1396:5:14");
  assert.equal(serie.source, "tmdb");
  assert.equal(serie.season, 5);
  assert.equal(serie.episode, 14);
});

test("los ids de anime usan numeración absoluta de episodio", () => {
  const parsed = parseStreamId("series", "kitsu:12345:7");
  assert.equal(parsed.source, "kitsu");
  assert.equal(parsed.id, "12345");
  assert.equal(parsed.season, null, "kitsu no envía temporada");
  assert.equal(parsed.episode, 7);
});

test("un id de anime con cuatro segmentos sí trae temporada", () => {
  const parsed = parseStreamId("series", "anilist:21:2:5");
  assert.equal(parsed.season, 2);
  assert.equal(parsed.episode, 5);
});

test("normaliza el tipo anime a series", () => {
  assert.equal(parseStreamId("anime", "kitsu:1:1").type, "series");
});

test("acepta alias de prefijos conocidos", () => {
  assert.equal(parseStreamId("series", "myanimelist:5114:3").source, "mal");
  assert.equal(parseStreamId("movie", "al:21").source, "anilist");
});

test("rechaza ids vacíos o desconocidos", () => {
  assert.equal(parseStreamId("movie", ""), null);
  assert.equal(parseStreamId("movie", "loquesea:123"), null);
  assert.equal(parseStreamId("movie", "tmdb:"), null);
});

test("seasonEpisode aplica valores por defecto solo en series", () => {
  assert.deepEqual(seasonEpisode(parseStreamId("series", "tt1:")), { season: 1, episode: 1 });
  assert.deepEqual(seasonEpisode(parseStreamId("series", "tt1:3:4")), { season: 3, episode: 4 });
  assert.deepEqual(seasonEpisode(parseStreamId("movie", "tt1")), {
    season: null,
    episode: null,
  });
});

test("describeId produce texto legible", () => {
  assert.equal(describeId(parseStreamId("series", "tt1:2:3")), "imdb:tt1 T2E3");
  assert.equal(describeId(parseStreamId("series", "kitsu:9:4")), "kitsu:9 E4");
  assert.equal(describeId(parseStreamId("movie", "tmdb:550")), "tmdb:550");
});
