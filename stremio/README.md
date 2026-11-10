# Addon de Stremio — VidCore · Chillflix · NekoWatch

Addon de Stremio que **solo entrega streams** (sin catálogos ni metadatos) a partir de tres
fuentes que publican su propia API de reproductor:

| Fuente | Identificador | Rutas usadas |
| --- | --- | --- |
| [VidCore](https://vidcore.org/movie-embed-api) | TMDB | `/embed/movie/{id}` · `/embed/tv/{id}/{s}/{e}` |
| [Chillflix](https://www.chillflix.lol/player-api) | TMDB | `/embed/movie/{id}` · `/embed/tv/{id}/{s}/{e}` (host del reproductor: `chillflix.pw`) |
| [NekoWatch](https://nekowatch.xyz/) | AniList | `/watch/{id}` · `/watch/{id}?ep=N` |

Sin dependencias de npm: solo Node.js 20+ y sus módulos nativos.

---

## Cómo funciona

Stremio pide `GET /stream/{tipo}/{id}.json`. El addon traduce el id que recibe al que
necesita cada fuente:

```
tt0944947:2:9   →  Cinemeta  →  TMDB 1399 T2E9   →  VidCore + Chillflix
tmdb:550        →  (directo) →  TMDB 550         →  VidCore + Chillflix
kitsu:12345:7   →  relations/Kitsu → AniList ... →  NekoWatch
tt… (anime)     →  Cinemeta + AniList            →  NekoWatch
```

- **IMDb → TMDB**: se usa el campo `moviedb_id` de Cinemeta. Si falta y hay `TMDB_API_KEY`,
  se consulta `/3/find` de TMDB.
- **Kitsu/MAL/AniDB → AniList**: `relations.yuna.moe`, con respaldo en los *mappings* de
  Kitsu y en la búsqueda por título de AniList.
- **IMDb → AniList**: solo si Cinemeta marca el título como animación japonesa
  (controlado por `NEKOWATCH_IMDB_LOOKUP`).

Cada respuesta se cachea en memoria para no repetir las conversiones.

### Enlace externo frente a enlace directo

Las tres fuentes sirven **reproductores HTML**, no ficheros de vídeo. Por eso el addon
devuelve por defecto `externalUrl`: Stremio abre el reproductor web, que es lo que siempre
funciona.

Con `RESOLVE_DIRECT=true` el addon intenta además localizar un `.m3u8`/`.mp4` dentro del
reproductor para que se vea dentro de Stremio. Es un intento con presupuesto de tiempo
acotado: si no encuentra nada, el enlace externo sigue ahí. Los enlaces directos que sí se
resuelvan pasan por `/px/...`, un proxy firmado con HMAC que reenvía `Referer`/`Origin` y
reescribe las listas HLS (útil en Stremio Web y en TV, que ignoran `proxyHeaders`).

---

## Desplegar en Render

### Opción A — Blueprint (recomendada)

El repositorio incluye [`render.yaml`](../render.yaml) en la raíz.

1. Entra en [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
2. Conecta este repositorio y selecciona la rama.
3. Render lee `render.yaml` y crea el servicio web con `rootDir: stremio`.
4. **Apply**. Al terminar tendrás `https://<nombre>.onrender.com`.

### Opción B — Servicio web manual

**New** → **Web Service**, conecta el repositorio y usa:

| Campo | Valor |
| --- | --- |
| Root Directory | `stremio` |
| Runtime | Node |
| Build Command | `npm install --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

> No definas `PORT` a mano: Render lo inyecta y el servidor ya escucha en `0.0.0.0`.

### Después del primer despliegue

1. Copia la URL del servicio y ponla en `PUBLIC_URL`
   (p. ej. `https://vimeus-stremio-addon.onrender.com`). Es opcional —si la dejas vacía se
   deduce de las cabeceras `X-Forwarded-*`— pero fija el valor evita sorpresas.
2. Abre la raíz del servicio en el navegador y pulsa **Instalar en Stremio**, o pega
   `https://<tu-servicio>.onrender.com/manifest.json` en
   **Stremio → Addons → Install via URL**.

> En el plan gratuito Render duerme el servicio tras ~15 min de inactividad; la primera
> petición puede tardar unos 30 s. Un *cron job* externo que llame a `/health` lo mantiene
> despierto, o pasa al plan de pago.

---

## Variables de entorno

| Variable | Por defecto | Qué hace |
| --- | --- | --- |
| `PORT` | `7000` | Lo inyecta Render. |
| `PUBLIC_URL` | *(auto)* | URL pública. Si falta se deduce de `X-Forwarded-*`. |
| `PROVIDERS` | `vidcore,chillflix,nekowatch` | Fuentes activas y su orden en la lista. |
| `RESOLVE_DIRECT` | `false` | Intentar extraer `.m3u8`/`.mp4` del reproductor. |
| `RESOLVE_TIMEOUT_MS` | `6000` | Presupuesto total de la resolución directa. |
| `PROXY_ENABLED` | `true` | Habilita `/px/...` para los enlaces directos. |
| `PROXY_SECRET` | *(aleatorio)* | Clave HMAC del proxy. Fíjala para que las URLs sobrevivan a un reinicio. |
| `TMDB_API_KEY` | — | Respaldo para IMDb → TMDB cuando Cinemeta no trae el id. |
| `NEKOWATCH_IMDB_LOOKUP` | `true` | Buscar en AniList desde un id de IMDb si parece anime. |
| `VIDCORE_BASE` | `https://vidcore.org` | Host de VidCore. |
| `VIDCORE_TV_PATH` | `tv` | Segmento de series (`tv` o `series`). |
| `CHILLFLIX_BASE` | `https://www.chillflix.pw` | Host del reproductor de Chillflix. |
| `CHILLFLIX_PREFER_4K` | `true` | Añade `prefer4k=1`. |
| `CHILLFLIX_AUTOPLAY` | `true` | Añade `autoplay`. |
| `CHILLFLIX_AUTONEXT` | `true` | Añade `autonext` en series. |
| `CHILLFLIX_TITLE` | `false` | Barra de título del reproductor. |
| `NEKOWATCH_BASE` | `https://nekowatch.xyz` | Host de NekoWatch. |
| `ADDON_ID` / `ADDON_NAME` / `ADDON_VERSION` | `com.vimeus.streamer.multisource` / `Vimeus Streamer` / `1.0.0` | Identidad del manifiesto. |
| `CACHE_TTL_MS` | `21600000` | TTL de la caché de metadatos (6 h). |
| `STREAM_CACHE_TTL_MS` | `600000` | TTL de la caché de streams (10 min). |
| `FETCH_TIMEOUT_MS` | `8000` | Timeout de cada petición saliente. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` o `debug`. |

---

## Endpoints

| Ruta | Descripción |
| --- | --- |
| `GET /` | Página de instalación con enlace `stremio://`. |
| `GET /health` | Healthcheck (lo usa Render). |
| `GET /manifest.json` | Manifiesto del addon. |
| `GET /stream/:type/:id.json` | Streams. `type` ∈ `movie`, `series`, `anime`. |
| `GET /px/:firma/:token` | Proxy de medios firmado. |

---

## Desarrollo local

```sh
cd stremio
npm start                 # http://localhost:7000
npm test                  # 27 pruebas, sin red
```

Pruebas rápidas:

```sh
curl localhost:7000/manifest.json
curl "localhost:7000/stream/movie/tmdb:550.json"
curl "localhost:7000/stream/series/tmdb:1396:4:5.json"
curl "localhost:7000/stream/series/anilist:195604:2.json"
```

---

## Limitaciones conocidas

- **Disponibilidad**: el addon construye las URLs documentadas por cada fuente, pero no
  puede garantizar que un título concreto exista en ellas. Stremio mostrará la entrada y el
  reproductor dirá si no hay nada.
- **Temporadas en anime**: AniList trata cada temporada como una entrada distinta. El mapeo
  desde IMDb es aproximado para temporadas posteriores a la primera; los ids `kitsu:` y
  `anilist:` son mucho más fiables.
- **Resolución directa**: depende de cómo cargue cada reproductor sus fuentes y puede dejar
  de funcionar si cambian su implementación. Por eso está desactivada por defecto.
- Si una fuente cambia sus rutas, ajusta `VIDCORE_BASE`, `VIDCORE_TV_PATH`,
  `CHILLFLIX_BASE` o `NEKOWATCH_BASE` sin tocar el código.
