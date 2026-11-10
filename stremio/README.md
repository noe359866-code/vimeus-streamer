# Addon de Stremio — VidCore · Chillflix · NekoWatch

Addon de Stremio que **solo entrega streams** (sin catálogos) y que reproduce
**HLS dentro de Stremio** en lugar de abrir un reproductor web.

| Fuente | Identificador | Rutas |
| --- | --- | --- |
| [VidCore](https://vidcore.org/movie-embed-api) | TMDB | `/embed/movie/{id}` · `/embed/tv/{id}/{s}/{e}` |
| [Chillflix](https://www.chillflix.lol/player-api) | TMDB | `/embed/movie/{id}` · `/embed/tv/{id}/{s}/{e}` (reproductor en `chillflix.pw`) |
| [NekoWatch](https://nekowatch.xyz/) | AniList | `/watch/{id}?ep=N` |

Sin dependencias de npm: Node.js 20+ y módulos nativos.

---

## ⚠️ Lee esto antes: cómo se consigue el HLS

Las tres fuentes **cifran deliberadamente la resolución del stream**. No hay un
`.m3u8` en el HTML que se pueda sacar con una expresión regular:

- **VidCore** extrae un token de sesión del HTML, lo *sella* con AES-256-GCM
  usando constantes que recupera en caliente de su propio bundle de JavaScript,
  lo envía a endpoints de catálogo opacos y descifra la respuesta.
- **NekoWatch** reproduce a través de **FlixCloud**, que usa un binario WASM
  distinto en cada carga de página, con token de un solo uso y material de clave
  nuevo. Además, el manifiesto llega como Base64 + XOR y algunos segmentos van
  camuflados con cabecera PNG/WebP.
- **Chillflix** sirve varios servidores con nombre (Miami, Boise·4K, Atlanta,
  Seattle) detrás de una API de selección propia.

Esas constantes **rotan**, así que un extractor fijo deja de funcionar solo. Por
eso este addon **no** incrusta esa criptografía: la delega en un **resolvedor
externo** que tú eliges y despliegas. Así, cuando una fuente cambie su esquema,
actualizas el resolvedor y el addon sigue igual.

### Las dos piezas

```
Stremio ──▶ este addon ──▶ resolvedor externo ──▶ .m3u8 del CDN
                │                                      │
                └──────────── proxy HLS ───────────────┘
                     (Referer/Origin, descifrado,
                      reescritura, desempaquetado)
```

1. **El addon** (esto) traduce identificadores, pide el stream, descompone la
   playlist maestra en calidades y sirve todo por un proxy firmado.
2. **El resolvedor** (externo) hace el trabajo criptográfico contra cada fuente.

Sin resolvedor configurado el addon sigue funcionando, pero solo entrega el
enlace al reproductor web (`externalUrl`).

### Configurar el resolvedor

```sh
# Uno para todo
RESOLVER_URL=https://mi-resolvedor.onrender.com/api/resolve?provider={provider}&type={type}&tmdb={tmdb}&anilist={anilist}&season={season}&episode={episode}

# O uno distinto por fuente (tiene prioridad sobre el anterior)
VIDCORE_RESOLVER_URL=https://mi-vidcore.onrender.com/api/resolve?tmdb={tmdb}&type={type}&season={season}&episode={episode}
NEKOWATCH_RESOLVER_URL=https://mi-anime.onrender.com/watch?anilist={anilist}&ep={episode}
```

Marcadores disponibles: `{provider}` `{type}` `{tmdb}` `{imdb}` `{anilist}`
`{season}` `{episode}` `{title}`. Si el resolvedor pide autenticación, usa
`RESOLVER_TOKEN` (se envía como `Authorization: Bearer …`).

### Formatos de respuesta aceptados

El puente es tolerante a propósito, porque cada proyecto devuelve una forma
distinta. Todas estas valen:

```jsonc
{ "url": "https://cdn.../master.m3u8" }

{ "sources": [ { "url": "...", "quality": "1080p", "type": "hls" } ] }

{ "data": { "sources": [ { "file": "..." } ] } }

{ "streams": [ { "url": "...", "headers": { "Referer": "..." } } ] }
```

Campos opcionales que se aprovechan si vienen:

| Campo | Para qué |
| --- | --- |
| `headers` / `referer` | Cabeceras que el CDN exige |
| `playlist_key` / `key` | Clave Base64 para descifrar manifiestos XOR |
| `unwrap: "flixcloud-hd2"` | Segmentos camuflados como PNG/WebP |
| `subtitles` / `tracks` | Subtítulos, que se adjuntan al stream |

Proyectos de código abierto que implementan este tipo de resolución y encajan
con el contrato: busca en GitHub por `vidcore stream resolver`,
`ReAnime API` o `flixcloud extractor`. Despliega el que prefieras (también en
Render) y apunta `RESOLVER_URL` a su endpoint.

---

## Qué hace el proxy HLS

Es la pieza que convierte un `.m3u8` ajeno en algo que Stremio reproduce:

- **Reenvía `Referer`/`Origin`/`User-Agent`** — sin ellos los CDN responden 403.
- **Reescribe las playlists** para que segmentos, claves `EXT-X-KEY`, mapas
  `EXT-X-MAP` y pistas `EXT-X-MEDIA` vuelvan a pasar por el proxy.
- **Descifra manifiestos** en Base64 + XOR cuando hay `playlist_key`.
- **Desenvuelve segmentos** MPEG-TS camuflados con cabecera PNG/WebP.
- **Propaga `Range`**, para que el salto en la línea de tiempo funcione.
- **Firma cada URL con HMAC**: sin firma válida no reenvía nada, así que no se
  puede usar como proxy abierto.

Además, al abrir la playlist maestra el addon ofrece **una entrada por calidad**
(1080p, 720p, 480p…) más una entrada *Auto (ABR)*, en lugar de un único enlace.

---

## Traducción de identificadores

Stremio envía IMDb o Kitsu; las fuentes hablan TMDB o AniList:

```
tt0944947:2:9   →  Cinemeta            →  TMDB 1399 T2E9  →  VidCore + Chillflix
tmdb:550        →  (directo)           →  TMDB 550        →  VidCore + Chillflix
kitsu:12345:7   →  relations / Kitsu   →  AniList         →  NekoWatch
tt… (anime)     →  Cinemeta + AniList  →  AniList         →  NekoWatch
```

- **IMDb → TMDB**: campo `moviedb_id` de Cinemeta; con `TMDB_API_KEY` se usa
  `/3/find` de TMDB como respaldo.
- **Kitsu/MAL/AniDB → AniList**: `relations.yuna.moe`, con respaldo en los
  *mappings* de Kitsu y en la búsqueda por título de AniList.
- **IMDb → AniList**: solo si Cinemeta marca el título como animación japonesa.

---

## Desplegar en Render

### Opción A — Blueprint (recomendada)

El repositorio incluye [`render.yaml`](../render.yaml) en la raíz.

1. [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
2. Conecta este repositorio y selecciona la rama.
3. Render lee `render.yaml` y crea el servicio con `rootDir: stremio`.
4. **Apply**.

### Opción B — Servicio web manual

| Campo | Valor |
| --- | --- |
| Root Directory | `stremio` |
| Runtime | Node |
| Build Command | `npm install --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

> No definas `PORT`: Render lo inyecta y el servidor escucha en `0.0.0.0`.

### Después del primer despliegue

1. Pon la URL del servicio en `PUBLIC_URL`
   (p. ej. `https://vimeus-stremio-addon.onrender.com`). Es opcional —si falta
   se deduce de `X-Forwarded-*`— pero fijarla evita sorpresas.
2. Configura `RESOLVER_URL` si quieres HLS (ver arriba).
3. Abre la raíz del servicio y pulsa **Instalar en Stremio**, o pega
   `https://<tu-servicio>.onrender.com/manifest.json` en
   **Stremio → Addons → Install via URL**.

> En el plan gratuito Render duerme el servicio tras ~15 min; la primera
> petición puede tardar ~30 s. Un cron externo que llame a `/health` lo
> mantiene despierto.

---

## Variables de entorno

| Variable | Por defecto | Qué hace |
| --- | --- | --- |
| `PORT` | `7000` | Lo inyecta Render. |
| `PUBLIC_URL` | *(auto)* | URL pública; si falta se deduce de `X-Forwarded-*`. |
| `PROVIDERS` | `vidcore,chillflix,nekowatch` | Fuentes activas y su orden. |
| **`RESOLVER_URL`** | — | **Resolvedor externo. Sin esto no hay HLS.** |
| `VIDCORE_RESOLVER_URL` | — | Resolvedor solo para VidCore. |
| `CHILLFLIX_RESOLVER_URL` | — | Resolvedor solo para Chillflix. |
| `NEKOWATCH_RESOLVER_URL` | — | Resolvedor solo para NekoWatch. |
| `RESOLVER_TOKEN` | — | Se envía como `Authorization: Bearer …`. |
| `RESOLVE_DIRECT` | `true` | Entregar HLS. En `false` solo da enlaces web. |
| `RESOLVE_TIMEOUT_MS` | `9000` | Presupuesto total de resolución. |
| `EXPAND_QUALITIES` | `true` | Una entrada por calidad desde la maestra. |
| `INCLUDE_EXTERNAL` | `true` | Mantener el enlace web como alternativa. |
| `GENERIC_EXTRACTOR` | `true` | Rascar el HTML buscando `.m3u8` (inútil si está cifrado). |
| `PROXY_ENABLED` | `true` | Proxy HLS. Desactivarlo rompe casi todos los CDN. |
| `PROXY_SECRET` | *(aleatorio)* | Clave HMAC. Fíjala para que las URLs sobrevivan a un reinicio. |
| `TMDB_API_KEY` | — | Respaldo para IMDb → TMDB. |
| `NEKOWATCH_IMDB_LOOKUP` | `true` | Buscar en AniList desde IMDb si parece anime. |
| `VIDCORE_BASE` / `VIDCORE_TV_PATH` | `https://vidcore.org` / `tv` | Host y segmento de series. |
| `CHILLFLIX_BASE` | `https://www.chillflix.pw` | Host del reproductor. |
| `CHILLFLIX_PREFER_4K` / `_AUTOPLAY` / `_AUTONEXT` / `_TITLE` | `true`/`true`/`true`/`false` | Flags del reproductor. |
| `NEKOWATCH_BASE` | `https://nekowatch.xyz` | Host de NekoWatch. |
| `ADDON_ID` / `ADDON_NAME` / `ADDON_VERSION` | ver `config.js` | Identidad del manifiesto. |
| `CACHE_TTL_MS` / `STREAM_CACHE_TTL_MS` | `21600000` / `600000` | TTL de cachés. |
| `FETCH_TIMEOUT_MS` | `8000` | Timeout de cada petición saliente. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`. |

---

## Endpoints

| Ruta | Descripción |
| --- | --- |
| `GET /` | Página de instalación con enlace `stremio://`. |
| `GET /health` | Healthcheck (lo usa Render). |
| `GET /manifest.json` | Manifiesto del addon. |
| `GET /stream/:type/:id.json` | Streams. `type` ∈ `movie`, `series`, `anime`. |
| `GET /px/:firma/:token` | Proxy HLS/MP4 firmado. |

---

## Desarrollo local

```sh
cd stremio
npm start        # http://localhost:7000
npm test         # 52 pruebas, sin red
```

### Probar el pipeline HLS sin depender de las fuentes reales

Levanta un resolvedor y un CDN de mentira y apunta el addon ahí:

```sh
VIDCORE_RESOLVER_URL="http://127.0.0.1:7999/api/resolve?tmdb={tmdb}" \
PROVIDERS=vidcore npm start

curl "localhost:7000/stream/movie/tmdb:550.json"
```

Debe devolver una entrada por calidad, y las URLs `/px/…` deben servir la
playlist ya reescrita.

---

## Limitaciones conocidas

- **Sin resolvedor no hay HLS.** Es la limitación principal y es deliberada:
  ver la sección de arriba.
- **Disponibilidad**: el addon construye las URLs documentadas, pero no puede
  garantizar que un título exista en una fuente concreta.
- **Temporadas de anime**: AniList trata cada temporada como una entrada
  distinta. El mapeo desde IMDb es aproximado a partir de la segunda temporada;
  los ids `kitsu:` y `anilist:` son mucho más fiables.
- **Plan gratuito de Render**: el proxy retransmite todo el vídeo, así que
  consume ancho de banda y CPU del servicio. Para uso continuado, considera un
  plan de pago.
