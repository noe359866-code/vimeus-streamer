import { config } from "./config.js";
import { registry } from "./providers/index.js";

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);

/** Página simple con el botón de instalación y el estado del servicio. */
export function landingPage(baseUrl) {
  const manifestUrl = `${baseUrl || ""}/manifest.json`;
  const deepLink = manifestUrl.replace(/^https?:\/\//, "stremio://");

  const providerCards = config.providers
    .map((key) => {
      const provider = registry[key];
      if (!provider) return "";
      const needs = provider.needs === "anilist" ? "AniList" : "TMDB";
      return `<li><strong>${esc(provider.name)}</strong><span>id ${esc(needs)}</span></li>`;
    })
    .join("");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.addonName)} · Addon de Stremio</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 20px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(1000px 600px at 20% -10%, #2b1b4d, #0d0b14 60%); color: #ece9f5;
  }
  .card {
    width: min(620px, 100%); background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.1);
    border-radius: 20px; padding: 34px; backdrop-filter: blur(12px);
    box-shadow: 0 24px 60px rgba(0,0,0,.45);
  }
  h1 { margin: 0 0 6px; font-size: 1.75rem; letter-spacing: -.02em; }
  .version { color: #a79fc4; font-size: .85rem; margin-bottom: 20px; }
  p { color: #c5bedd; line-height: 1.6; margin: 0 0 20px; }
  ul { list-style: none; margin: 0 0 24px; padding: 0; display: grid; gap: 8px; }
  li {
    display: flex; justify-content: space-between; align-items: center; gap: 12px;
    padding: 11px 14px; border-radius: 11px; background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.07); font-size: .92rem;
  }
  li span { color: #9d94bd; font-size: .78rem; font-variant: all-small-caps; letter-spacing: .06em; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
  a.btn, button.btn {
    flex: 1 1 180px; text-align: center; cursor: pointer; font: inherit; font-weight: 600;
    padding: 13px 18px; border-radius: 12px; text-decoration: none; border: 1px solid transparent;
    transition: transform .12s ease, filter .12s ease;
  }
  a.btn:hover, button.btn:hover { transform: translateY(-1px); filter: brightness(1.08); }
  .primary { background: linear-gradient(135deg, #7b5cff, #b14dff); color: #fff; }
  .ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.14); color: #ece9f5; }
  code {
    display: block; padding: 12px 14px; border-radius: 10px; background: #07060c;
    border: 1px solid rgba(255,255,255,.08); font-size: .82rem; word-break: break-all; color: #b9aaff;
  }
  footer { margin-top: 22px; font-size: .78rem; color: #8b83a8; line-height: 1.55; }
</style>
</head>
<body>
  <main class="card">
    <h1>${esc(config.addonName)}</h1>
    <div class="version">v${esc(config.addonVersion)} · solo streams, sin catálogos</div>
    <p>Addon de Stremio que añade fuentes de reproducción para películas, series y anime.</p>
    <ul>${providerCards}</ul>
    <div class="actions">
      <a class="btn primary" href="${esc(deepLink)}">Instalar en Stremio</a>
      <button class="btn ghost" id="copy">Copiar manifiesto</button>
    </div>
    <code id="manifest">${esc(manifestUrl)}</code>
    <footer>
      Resolución directa: <strong>${config.resolveDirect ? "activada" : "desactivada"}</strong> ·
      Proxy: <strong>${config.proxyEnabled ? "activado" : "desactivado"}</strong><br>
      Si el botón no abre la app, copia la URL y pégala en Stremio →
      Addons → <em>Install via URL</em>.
    </footer>
  </main>
<script>
  document.getElementById('copy').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(document.getElementById('manifest').textContent.trim());
      button.textContent = '¡Copiado!';
    } catch {
      button.textContent = 'Copia manual';
    }
    setTimeout(() => { button.textContent = 'Copiar manifiesto'; }, 1800);
  });
</script>
</body>
</html>`;
}
