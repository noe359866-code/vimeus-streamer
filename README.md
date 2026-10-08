# Vimeus Streamer

Backend para Stremio y Kodi como Cloudflare Worker. Publica el manifiesto de Stremio y endpoints de streams, consulta Cinemeta de forma opcional, obtiene el embed de Vimeus (directamente o mediante `PROXY_URL`) y extrae el primer enlace HLS encontrado.

## Endpoints

- `GET /manifest.json` — manifiesto instalable de Stremio.
- `GET /stream/movie/:id.json` — streams de películas para Stremio.
- `GET /stream/series/:id.json` — streams de series. Los IDs pueden ser IMDb (`tt...:temporada:episodio`) o TMDb (`tmdb:ID:temporada:episodio`).
- `GET /kodi/stream?type=movie&imdb=tt0133093` — respuesta JSON para el cliente de Kodi.
- `GET /kodi/stream?type=series&imdb=tt0944947&se=1&ep=2` — respuesta JSON para episodios; también se acepta `tmdb`.

El stream de Stremio incluye `Referer: https://vimeus.com/` y el User-Agent requerido. La propiedad `url` de Kodi agrega Referer y User-Agent en formato pipe-header; `raw_hls` contiene el enlace HLS sin modificar.

## Configuración

- `VIEW_KEY` — secreto opcional de Cloudflare que reemplaza la clave predeterminada del proyecto. Configúralo con `npx wrangler secret put VIEW_KEY`.
- `PROXY_URL` — proxy HTTP(S) opcional. El Worker añade el embed como parámetro `url` y conserva los demás parámetros existentes del proxy. Configúralo como variable o secreto de Worker, no en el repositorio.

Sin `PROXY_URL`, el Worker intenta obtener directamente el embed de Vimeus. La consulta a Cinemeta es opcional: si falla, todavía puede devolverse el stream con un título genérico.

## Desarrollo y pruebas

Se recomienda Node.js 20 o posterior. Las pruebas usan respuestas simuladas, por lo que no llaman a Vimeus ni a Cinemeta.

```sh
npm test
npx wrangler dev --ip 0.0.0.0
npx wrangler deploy
```

### Complemento de Kodi

El cliente instalable está en `kodi/plugin.video.vimeus.streamer`. Genera el ZIP desde la raíz:

```sh
cd kodi
zip -r ../plugin.video.vimeus.streamer-1.0.0.zip plugin.video.vimeus.streamer
```

Instala el archivo ZIP desde Kodi (**Ajustes → Sistema → Add-ons → Instalar desde un archivo ZIP**). El complemento permite introducir un IMDb o TMDb ID y, para series, temporada y episodio. En los ajustes, configura la URL base del Worker. El ZIP preparado para esta sesión tiene el preview temporal como valor inicial; cámbialo por el dominio permanente al desplegar.

El preview local sirve para comprobar el manifiesto y el cableado de los endpoints. Para reproducción real, el Worker debe poder llegar a Cinemeta y Vimeus y el dispositivo cliente debe poder acceder al Worker. La clave predeterminada está en el código según la especificación; en producción, es preferible reemplazarla con el secreto `VIEW_KEY`.
