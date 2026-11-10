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

## Escalar a +12.000 usuarios: el ancho de banda es el problema

Si el servicio retransmite el vídeo, **la factura te arruina antes que la CPU**.
En abril de 2026 Render recortó el ancho de banda incluido de 100 GB a **5 GB**
(Hobby) y de 500 GB a **25 GB** (Pro), con excedente a **$0,15/GB**.

Una película de 2 h en 1080p son unos **4,4 GB**. Con 12.000 usuarios viendo
2 películas al mes:

| `PROXY_MODE` | Qué atraviesa el servicio | Por película | 12.000 × 2/mes | Excedente en Render |
| --- | --- | --- | --- | --- |
| `full` | Playlists + claves + **todos los segmentos** | ~4,4 GB | **~103 TB** | **~$15.800/mes** |
| `playlist` | Solo playlists y claves | ~0,15 MB | ~3,6 GB | **$0** |
| **`auto`** *(por defecto)* | Nada, o solo playlists si hace falta | 0 – 0,15 MB | 0 – 3,6 GB | **$0** |
| `off` | Nada | 0 | 0 | **$0** |

### ¿HLS directo, sin proxy?

Sí, y es la vía más barata: Stremio puede inyectar las cabeceras por su cuenta
con `behaviorHints.proxyHeaders`, de modo que el vídeo va del CDN al
reproductor sin tocar tu servidor. Otro addon que hizo este cambio pasó de
50 GB+ a prácticamente cero.

Pero `off` a secas **rompe en silencio** en tres casos:

| Qué | Por qué |
| --- | --- |
| **Stremio Web** | El navegador no deja fijar `Referer` (es una cabecera prohibida), así que `proxyHeaders` se ignora. Es una limitación del navegador, no un fallo de Stremio. Las apps de escritorio y Android sí lo respetan. |
| **Manifiestos cifrados** | Si la fuente devuelve el `.m3u8` en Base64+XOR (el caso de FlixCloud), el reproductor recibe un churro en vez de `#EXTM3U`. Ningún reproductor lo descifra. |
| **Segmentos camuflados** | Los segmentos con cabecera PNG/WebP necesitan desenvolverse antes de reproducirse. Tampoco lo hace ningún reproductor. |

A eso se suma que muchos CDN no mandan `Access-Control-Allow-Origin`, lo que
vuelve a dejar fuera a Stremio Web.

### Por eso el modo por defecto es `auto`

En vez de elegir a ciegas entre "gratis pero frágil" y "robusto pero caro",
`auto` decide **por cada fuente**:

La entrega directa exige que se cumpla **todo** esto. Basta que falle una para
que la fuente pase por el proxy:

| Comprobación | Si falla | Por qué |
| --- | --- | --- |
| El manifiesto no va cifrado y los segmentos no van envueltos | proxy | Sin transformar no se reproduce en ningún cliente. |
| La URL es `https://` | proxy | Un `http://` lo bloquea el navegador por contenido mixto y lo rechazan algunos clientes. El proxy sirve por HTTPS. |
| El CDN responde `200` a una petición **sin `Referer`** | proxy | Si responde `403`, solo el proxy puede añadir la cabecera. |
| El CDN envía `Access-Control-Allow-Origin` | proxy | Sin CORS el navegador no puede ni leer el manifiesto. |

El resultado de la sonda se guarda **por host** durante 6 h: una petición extra
la primera vez que aparece un CDN y gratis a partir de ahí.

La comprobación de CORS se puede desactivar con `PROBE_REQUIRE_CORS=false`. Solo
tiene sentido si **ningún** usuario tuyo usa Stremio Web, porque entonces se
entregan directo también los CDN sin CORS. Ahorra algo de tráfico y rompe el
navegador.

### Dónde sigue siendo frágil

Dos cosas que `auto` no puede resolver, y conviene saberlas:

- **La sonda mira el host del manifiesto, no el de los segmentos.** Si una fuente
  sirve el `.m3u8` desde un host abierto y los `.ts` desde otro con `Referer`
  obligatorio, `auto` entregará directo y la reproducción morirá al arrancar.
  Si ves ese patrón en una fuente, fuerza `PROXY_MODE=playlist`.
- **En Stremio Web, `playlist` tampoco basta** si el CDN no manda CORS: el
  navegador también descarga los segmentos y vuelve a chocar con CORS. Para un
  CDN así, en Web lo único que funciona es `full`, y `full` cuesta ~$15.800/mes
  a esta escala. Dicho de otro modo: **una audiencia mayoritariamente de Stremio
  Web sobre CDN sin CORS no sale a cuenta**; lo sostenible es que la fuente
  tenga CORS, y ahí `auto` ya entrega directo y gratis.

### `notWebReady` según cómo se entregue

Un detalle que rompe la reproducción si se hace mal, y que el addon ya maneja:

| Entrega | `notWebReady` | `proxyHeaders` | Por qué |
| --- | --- | --- | --- |
| **Directa** | `true` | sí | `proxyHeaders` **solo surte efecto** con `notWebReady: true`. |
| **Por el proxy** | *ausente* | no | El proxy ya inyecta las cabeceras, sirve por HTTPS y añade CORS: el stream **es** web-ready. Marcarlo `notWebReady` haría que Stremio 5 lo desviara a su conversor HLS local sin necesidad. |

### Lo demás que hace falta a ese volumen

El servicio ya incluye las piezas que evitan que un pico se convierta en una caída:

| Pieza | Qué evita |
| --- | --- |
| **Agrupación de peticiones** | Si 500 usuarios abren el mismo estreno a la vez, el resolvedor recibe **1** llamada, no 500. |
| **Cortocircuito** | Si el resolvedor se cae, se deja de llamar durante `BREAKER_RESET_MS` en vez de que cada usuario espere 9 s. |
| **Semáforo de salida** | Tope de peticiones salientes simultáneas (`MAX_CONCURRENT_UPSTREAM`); sin él, un pico agota sockets y memoria. |
| **Límite por IP** | 120 peticiones/min por IP sobre `/stream`. El proxy **no** se limita: la reproducción hace muchas peticiones legítimas. |
| **URLs con caducidad** | Una URL de proxy filtrada deja de servir como relay pasadas 8 h (`PROXY_URL_TTL_MS`). |
| **Métricas en `/health`** | Aciertos de caché, bytes retransmitidos, fallos del resolvedor, estado de los cortocircuitos. |

### ⚠️ `PROXY_SECRET` es obligatorio con más de una instancia

Si no lo defines, cada instancia genera uno aleatorio al arrancar. Con
autoescalado, una URL firmada por la instancia A la **rechaza** la B, y cada
despliegue invalida las que estén en uso. El `render.yaml` lo genera con
`generateValue: true` (estable); si configuras el servicio a mano, fíjalo tú.
El servidor avisa por log al arrancar si falta.

### Dimensionar el servicio

En modo `playlist` el servicio solo sirve JSON y playlists de pocos KB:

- **Instancia**: Starter ($7) basta para empezar; Standard ($25, 1 vCPU / 2 GB)
  si quieres margen. El trabajo pesado lo hace el resolvedor, no esto.
- **Plan**: Pro ($25/mes) si necesitas **autoescalado horizontal** — en Hobby no
  está disponible.
- **Caché entre instancias**: cada instancia tiene su caché en memoria, así que
  con N instancias el acierto baja. Con la agrupación de peticiones y un TTL de
  6 h en los mapeos de identificadores aguanta bien hasta unas pocas instancias.
  Más allá, conviene una caché compartida (Render Key Value o Upstash).
- **El cuello de botella real es el resolvedor**, no este addon. Dimensiónalo a
  él y vigila `resolverFailures` y `breakers` en `/health`.

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
| **`PROXY_MODE`** | `auto` | `auto` \| `playlist` \| `full` \| `off`. **Decide la factura** (ver arriba). |
| `PROBE_ENABLED` | `true` | Sonda que pregunta al CDN si acepta peticiones sin `Referer` (solo en `auto`). |
| `PROBE_TIMEOUT_MS` / `PROBE_TTL_MS` | `4000` / `21600000` | Timeout de la sonda y cuánto se recuerda por host. |
| `PROBE_REQUIRE_CORS` | `true` | Exige CORS para entregar directo. Ponlo en `false` solo si nadie usa Stremio Web. |
| **`PROXY_SECRET`** | *(aleatorio)* | Clave HMAC. **Obligatoria con más de una instancia.** |
| `PROXY_URL_TTL_MS` | `28800000` | Caducidad de las URLs firmadas (8 h). |
| `MAX_CONCURRENT_UPSTREAM` | `64` | Tope de peticiones salientes simultáneas. |
| `BREAKER_THRESHOLD` | `5` | Fallos seguidos antes de cortocircuitar el resolvedor. |
| `BREAKER_RESET_MS` | `30000` | Pausa del cortocircuito. |
| `RATE_LIMIT_ENABLED` | `true` | Límite por IP sobre `/stream`. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `120` | Ventana y máximo por IP. |
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
