# Complemento para Kodi

El complemento `plugin.video.vimeus.streamer` es un cliente ligero del endpoint `/kodi/stream` del Worker. Permite ingresar un ID de IMDb (`tt1234567`) o TMDb (`tmdb:12345`), y, para series, seleccionar temporada y episodio.

## Crear el ZIP para instalar

Desde la raíz del repositorio:

```sh
cd kodi
zip -r ../plugin.video.vimeus.streamer-1.0.0.zip plugin.video.vimeus.streamer
```

Después, en Kodi, activa **Ajustes → Sistema → Add-ons → Orígenes desconocidos**, selecciona **Instalar desde un archivo ZIP** y elige el archivo. En los ajustes del complemento, verifica **URL del Worker**. Para esta sesión el valor inicial apunta al preview temporal; al desplegar, reemplázalo por el dominio estable del Worker.

El complemento necesita Kodi 19 o posterior (Python 3). El Worker debe estar publicado y accesible desde el dispositivo Kodi para que la búsqueda y reproducción funcionen.
