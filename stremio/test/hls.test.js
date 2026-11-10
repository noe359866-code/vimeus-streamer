import test from "node:test";
import assert from "node:assert/strict";

import {
  decryptManifest,
  isMasterPlaylist,
  isPlaylistText,
  parseMasterVariants,
  qualityLabel,
  rewritePlaylist,
  unwrapImageSegment,
} from "../src/hls.js";

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480
480/index.m3u8`;

test("reconoce playlists y maestras", () => {
  assert.ok(isPlaylistText(MASTER));
  assert.ok(isMasterPlaylist(MASTER));
  assert.ok(!isMasterPlaylist("#EXTM3U\n#EXTINF:6,\nseg.ts"));
  assert.ok(!isPlaylistText("<html>nope</html>"));
});

test("parseMasterVariants extrae calidades y las ordena de mayor a menor", () => {
  const variants = parseMasterVariants(MASTER, "https://cdn.test/v/master.m3u8");
  assert.equal(variants.length, 3);
  assert.deepEqual(
    variants.map((v) => v.label),
    ["1080p", "720p", "480p"],
  );
  assert.equal(variants[0].uri, "https://cdn.test/v/1080/index.m3u8");
  assert.equal(variants[0].bandwidth, 5000000);
  assert.equal(variants[0].height, 1080);
  assert.equal(variants[0].codecs, "avc1.640028");
});

test("parseMasterVariants deduplica alturas repetidas quedándose con el mejor bitrate", () => {
  const dup = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080
a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
b.m3u8`;
  const variants = parseMasterVariants(dup, "https://cdn.test/master.m3u8");
  assert.equal(variants.length, 1);
  assert.equal(variants[0].bandwidth, 6000000);
});

test("parseMasterVariants devuelve vacío si no es una maestra", () => {
  assert.deepEqual(parseMasterVariants("#EXTM3U\n#EXTINF:6,\nseg.ts", "https://x.test/a.m3u8"), []);
});

test("qualityLabel traduce alturas y bitrates", () => {
  assert.equal(qualityLabel(2160), "4K");
  assert.equal(qualityLabel(1080), "1080p");
  assert.equal(qualityLabel(null, 1500000), "1500 kbps");
  assert.equal(qualityLabel(null, null), "Auto");
});

test("rewritePlaylist redirige segmentos, claves y mapas", () => {
  const media = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
seg1.ts
#EXTINF:6.0,
https://otro.test/seg2.ts`;

  const output = rewritePlaylist(media, "https://cdn.test/v/index.m3u8", (url) => `P(${url})`);

  assert.match(output, /URI="P\(https:\/\/cdn\.test\/v\/key\.bin\)"/);
  assert.match(output, /URI="P\(https:\/\/cdn\.test\/v\/init\.mp4\)"/);
  assert.match(output, /^P\(https:\/\/cdn\.test\/v\/seg1\.ts\)$/m);
  assert.match(output, /^P\(https:\/\/otro\.test\/seg2\.ts\)$/m);
  assert.ok(output.startsWith("#EXTM3U"));
});

test("rewritePlaylist conserva las líneas que no son URLs", () => {
  const input = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST";
  assert.equal(rewritePlaylist(input, "https://cdn.test/a.m3u8", () => "NOPE"), input);
});

test("decryptManifest deja pasar el texto plano", () => {
  const { text, decrypted } = decryptManifest("#EXTM3U\nhola", "");
  assert.equal(decrypted, false);
  assert.equal(text, "#EXTM3U\nhola");
});

test("decryptManifest descifra Base64 + XOR con la clave correcta", () => {
  const plain = "#EXTM3U\n#EXT-X-VERSION:3\nseg.ts";
  const key = Buffer.from([0x11, 0x7a, 0x3c, 0x5d]);
  const payload = Buffer.from(plain, "utf8");
  const encrypted = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    encrypted[i] = payload[i] ^ key[i % key.length];
  }

  const { text, decrypted } = decryptManifest(
    encrypted.toString("base64"),
    key.toString("base64"),
  );
  assert.equal(decrypted, true);
  assert.equal(text, plain);
});

test("decryptManifest no rompe con una clave equivocada", () => {
  const { decrypted } = decryptManifest("Zm9vYmFy", Buffer.from([1, 2]).toString("base64"));
  assert.equal(decrypted, false);
});

test("unwrapImageSegment quita la cabecera PNG y devuelve el transport stream", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ts = Buffer.from([0x47, 0x40, 0x11, 0x10, 0x00]);
  const out = unwrapImageSegment(Buffer.concat([png, ts]));
  assert.ok(out);
  assert.equal(out[0], 0x47);
  assert.deepEqual([...out], [...ts]);
});

test("unwrapImageSegment quita la cabecera WebP", () => {
  const riff = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const ts = Buffer.from([0x47, 0x01, 0x02]);
  const out = unwrapImageSegment(Buffer.concat([riff, ts]));
  assert.deepEqual([...out], [...ts]);
});

test("unwrapImageSegment deshace el XOR cuando hace falta", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const key = Buffer.from([0x9d, 0x2a, 0xf1]);
  const ts = Buffer.from([0x47, 0x40, 0x11, 0x10]);
  const masked = Buffer.from(ts.map((byte, i) => byte ^ key[i % key.length]));

  const out = unwrapImageSegment(Buffer.concat([png, masked]), key);
  assert.deepEqual([...out], [...ts]);
});

test("unwrapImageSegment devuelve null si no era una imagen envuelta", () => {
  assert.equal(unwrapImageSegment(Buffer.from([0x47, 0x00, 0x01])), null);
  assert.equal(unwrapImageSegment(Buffer.from("texto plano")), null);
});
