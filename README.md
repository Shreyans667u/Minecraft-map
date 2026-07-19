# Cartograph — Blocky Navigator 🗺️

A real, working turn-by-turn navigation map — search, route, geolocate — reskinned to look
like a Minecraft map item: parchment tint, wood-and-leather frame, pixel font, and a
rotating red arrow for your position. It's a installable web app (PWA), so it can live
on a phone's home screen like a native app, and it needs no backend — just static files.

**What it uses (all free, no API keys):**
- [Leaflet.js](https://leafletjs.com/) + OpenStreetMap tiles for the map itself
- [Nominatim](https://nominatim.org/) for place search
- [OSRM](http://project-osrm.org/) public demo server for walking/cycling/driving routes
- A service worker + manifest for offline app-shell caching and "Add to Home Screen"

## Run it locally

Any static file server works, e.g.:

```bash
cd mc-nav-map
python3 -m http.server 8080
```

Then open `http://localhost:8080`. (Opening `index.html` directly via `file://` will break
the service worker and geolocation in most browsers — always serve it over http/https.)

## Deploy to GitHub Pages

1. Create a new GitHub repo and push this folder's contents to the `main` branch:
   ```bash
   cd mc-nav-map
   git init
   git add .
   git commit -m "Cartograph: blocky map navigator"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
2. In the repo on GitHub, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**. The included workflow at
   `.github/workflows/deploy.yml` will build and publish automatically on every
   push to `main`.
3. After the first workflow run finishes (check the **Actions** tab), your app is live at:
   `https://<your-username>.github.io/<your-repo>/`

That's it — no build step, no server to maintain.

## Install it on mobile

Once it's hosted (GitHub Pages gives you HTTPS, which PWAs require):

- **Android (Chrome):** open the site, tap the **⋮** menu → **Add to Home screen** — or
  tap the in-app "Craft this into an app" banner that pops up automatically.
- **iPhone (Safari):** open the site, tap the **Share** icon → **Add to Home Screen**.
  (iOS doesn't support the automatic install prompt, so this manual step is required there.)

Once installed it opens full-screen with its own icon, no browser chrome — same idea as
"installing a mod."

## Project structure

```
mc-nav-map/
├── index.html            # app shell / layout
├── style.css              # the Minecraft-map skin (frame, buttons, filters)
├── app.js                  # map, search, routing, geolocation, install logic
├── manifest.json           # PWA metadata (name, icons, colors)
├── service-worker.js       # offline caching
├── icons/                  # generated app icons (192px, 512px)
└── .github/workflows/deploy.yml   # auto-deploy to GitHub Pages
```

## Notes & limits

- Nominatim and the public OSRM server are free community services with modest rate
  limits — fine for personal/demo use, but swap in your own hosted instance (or a paid
  provider like Mapbox/OpenRouteService) if you expect real traffic.
- The "pixel" look is a CSS re-skin (filters + pixel grid + parchment frame) layered over
  real OpenStreetMap tiles, not literal Minecraft assets — so there's no licensing issue
  with Mojang/Microsoft's actual game textures.
- Geolocation and "Add to Home Screen" both require HTTPS, which GitHub Pages provides
  automatically.
