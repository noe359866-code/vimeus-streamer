# -*- coding: utf-8 -*-
"""Kodi client for the Vimeus Streamer Cloudflare Worker."""

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

import xbmcgui
import xbmcplugin
import xbmcaddon


HANDLE = int(sys.argv[1])
ADDON = xbmcaddon.Addon()
ADDON_URL = sys.argv[0]


def _worker_url():
    value = ADDON.getSetting("worker_url").strip().rstrip("/")
    if not value.startswith(("https://", "http://")):
        raise ValueError("Configura una URL HTTP(S) del Worker en los ajustes del complemento.")
    return value


def _show_error(message):
    xbmcgui.Dialog().ok("Vimeus Streamer", message)
    xbmcplugin.setResolvedUrl(HANDLE, False, xbmcgui.ListItem())


def _request_stream(params):
    url = _worker_url() + "/kodi/stream?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
            return None, payload.get("error", "El Worker rechazó la solicitud.")
        except (ValueError, UnicodeDecodeError):
            return None, "El Worker respondió con el estado HTTP %s." % error.code
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        return None, "No se pudo contactar el Worker: %s" % error

    stream_url = payload.get("url")
    if not stream_url:
        return None, payload.get("error", "No hay un stream disponible para este título.")
    return payload, None


def _id_parameter(raw_id):
    value = raw_id.strip()
    if value.lower().startswith("tmdb:"):
        tmdb_id = value.split(":", 1)[1].strip()
        if not tmdb_id.isdigit():
            raise ValueError("El ID TMDb debe tener el formato tmdb:12345.")
        return "tmdb", tmdb_id
    if not re.match(r"^tt\d+$", value, re.IGNORECASE):
        raise ValueError("Usa un ID IMDb (tt1234567) o TMDb (tmdb:12345).")
    return "imdb", value


def _play(params):
    try:
        payload, error = _request_stream(params)
    except ValueError as error:
        _show_error(str(error))
        return
    if error:
        _show_error(error)
        return

    item = xbmcgui.ListItem(label=payload.get("title", "Vimeus Streamer"), path=payload["url"])
    item.setProperty("IsPlayable", "true")
    item.setMimeType("application/vnd.apple.mpegurl")
    item.setContentLookup(False)
    xbmcplugin.setResolvedUrl(HANDLE, True, item)


def _prompt_play(kind):
    dialog = xbmcgui.Dialog()
    raw_id = dialog.input("ID IMDb (tt1234567) o TMDb (tmdb:12345)")
    if not raw_id.strip():
        xbmcplugin.setResolvedUrl(HANDLE, False, xbmcgui.ListItem())
        return

    try:
        id_name, id_value = _id_parameter(raw_id)
    except ValueError as error:
        _show_error(str(error))
        return

    params = {"type": kind, id_name: id_value}
    if kind == "series":
        season = dialog.numeric(xbmcgui.INPUT_NUMERIC, "Temporada")
        if not season:
            xbmcplugin.setResolvedUrl(HANDLE, False, xbmcgui.ListItem())
            return
        episode = dialog.numeric(xbmcgui.INPUT_NUMERIC, "Episodio")
        if not episode:
            xbmcplugin.setResolvedUrl(HANDLE, False, xbmcgui.ListItem())
            return
        params.update({"se": season, "ep": episode})

    _play(params)


def _add_action(label, action):
    query = urllib.parse.urlencode({"action": action})
    item = xbmcgui.ListItem(label=label)
    item.setProperty("IsPlayable", "true")
    xbmcplugin.addDirectoryItem(
        handle=HANDLE,
        url=ADDON_URL + "?" + query,
        listitem=item,
        isFolder=False,
    )


def _root():
    xbmcplugin.setContent(HANDLE, "videos")
    _add_action("Buscar película por ID", "movie")
    _add_action("Reproducir episodio por ID", "series")
    xbmcplugin.endOfDirectory(HANDLE)


def _query_params():
    if len(sys.argv) < 3 or not sys.argv[2]:
        return {}
    return {
        key: values[0]
        for key, values in urllib.parse.parse_qs(
            sys.argv[2].lstrip("?"), keep_blank_values=True
        ).items()
    }


def main():
    params = _query_params()
    action = params.get("action")
    if action == "movie":
        _prompt_play("movie")
    elif action == "series":
        _prompt_play("series")
    else:
        _root()


if __name__ == "__main__":
    main()
