import test from "node:test";
import assert from "node:assert/strict";

import { hostOf, mustProxy } from "../src/probe.js";

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
