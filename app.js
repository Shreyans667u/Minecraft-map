// ===== Cartograph app logic =====

const els = {
  loading: document.getElementById('loading'),
  searchForm: document.getElementById('searchForm'),
  searchInput: document.getElementById('searchInput'),
  results: document.getElementById('results'),
  routeCard: document.getElementById('routeCard'),
  routeDist: document.getElementById('routeDist'),
  routeTime: document.getElementById('routeTime'),
  routeSteps: document.getElementById('routeSteps'),
  closeRoute: document.getElementById('closeRoute'),
  locateBtn: document.getElementById('locateBtn'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  coordReadout: document.getElementById('coordReadout'),
  installBanner: document.getElementById('installBanner'),
  installBtn: document.getElementById('installBtn'),
  dismissInstall: document.getElementById('dismissInstall'),
  modeBtns: Array.from(document.querySelectorAll('.mode')),
  dropWaypointBtn: document.getElementById('dropWaypointBtn'),
  waypointsBtn: document.getElementById('waypointsBtn'),
  waypointsList: document.getElementById('waypointsList'),
  themeBtn: document.getElementById('themeBtn'),
  shareBtn: document.getElementById('shareBtn'),
};

let map, userMarker, routeLine, destMarker;
let userLatLng = null;
let travelMode = 'foot'; // foot | bike | driving (maps to OSRM profiles)

function showLoading(msg) {
  els.loading.textContent = msg || 'Loading chunks…';
  els.loading.classList.remove('hidden');
}
function hideLoading() { els.loading.classList.add('hidden'); }

// ===== Minecraft-texture-pack renderer for REAL map tiles =====
// Nothing here invents geography. Every block's position, road, building
// and shoreline comes straight from the source OpenStreetMap/CARTO tile —
// we only classify each small block's real average color into a category
// and repaint it with a quantized Minecraft palette + ordered dithering.
// Labels are rendered as a separate, un-pixelated overlay so place names
// stay legible.

function hash(x, y) {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = (n ^ (n >> 13)) * 1274126177;
  n = (n ^ (n >> 16)) >>> 0;
  return n / 4294967295;
}
function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// 4x4 Bayer ordered-dither matrix, normalized 0..1
const BAYER4 = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

// palettes, each sorted dark -> light (as given, plus a couple of derived
// tones so water gets its requested 4-6 shade range)
const MC_PALETTES = {
  overworld: {
    grass: ['#4E812B', '#5F9834', '#6BAF3A', '#79C246'].map(hexToRgb),
    water: ['#1F4A96', '#2D63C5', '#3B74D8', '#4E8EF0', '#7FB0FA'].map(hexToRgb),
    road: ['#7A7A7A', '#8E8E8E', '#A2A2A2', '#B6B6B6'].map(hexToRgb),
    building: ['#C4B48C', '#D8C9A3', '#E4D7B0', '#EDE1BE'].map(hexToRgb),
    forest: ['#1F3D16', '#2E5A22', '#396B2A', '#457A33'].map(hexToRgb),
    sand: ['#C9AE78', '#D9C08C', '#E6CE9E'].map(hexToRgb),
  },
  nether: {
    grass: ['#5A140F', '#7C2018', '#9C2E22', '#B84430'].map(hexToRgb),
    water: ['#7A1E00', '#A62E00', '#D14400', '#EC6A1A', '#F5934D'].map(hexToRgb),
    road: ['#2E2430', '#3E323F', '#4E404E', '#5E4E5E'].map(hexToRgb),
    building: ['#4A2C34', '#5E3A42', '#6E4650', '#7C525E'].map(hexToRgb),
    forest: ['#3A0F2E', '#4E1740', '#601E4F', '#742760'].map(hexToRgb),
    sand: ['#4A3A38', '#5C4846', '#6C5654'].map(hexToRgb),
  },
};
let THEME = 'overworld';

// pick a shade from a dark->light array using the block's real sampled
// brightness plus an ordered-dither jitter (no generative noise involved)
function ditheredShade(arr, level01, bx, by) {
  const bayer = BAYER4[by % 4][bx % 4];
  const n = arr.length;
  let pos = level01 * (n - 1) + (bayer - 0.5) * 1.1;
  pos = Math.max(0, Math.min(n - 1, Math.round(pos)));
  return arr[pos];
}
// tiny deterministic per-block grain so flat fills don't look flat
function grain(rgb, tileX, tileY, bx, by) {
  const h = hash(tileX * 1000 + bx, tileY * 1000 + by);
  const d = Math.round((h - 0.5) * 14);
  return [clamp255(rgb[0] + d), clamp255(rgb[1] + d), clamp255(rgb[2] + d)];
}
function luminance(r, g, b) { return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }

// Reference swatches from the source (labels-free) tile's flat colors —
// used only to classify each block, never drawn directly.
const BIOME_REFS = [
  { rgb: [170, 211, 223], biome: 'water' },
  { rgb: [200, 222, 187], biome: 'forest' },
  { rgb: [242, 239, 233], biome: 'grass' },
  { rgb: [255, 255, 255], biome: 'road' },
  { rgb: [247, 220, 124], biome: 'road' },
  { rgb: [224, 223, 220], biome: 'building' },
];
function classifyBiome(r, g, b) {
  let best = 'grass', bestDist = Infinity;
  for (const ref of BIOME_REFS) {
    const d = (r - ref.rgb[0]) ** 2 + (g - ref.rgb[1]) ** 2 + (b - ref.rgb[2]) ** 2;
    if (d < bestDist) { bestDist = d; best = ref.biome; }
  }
  return best;
}

const GRID = 16; // 256px tile / 16 = 16px blocks, matching Minecraft's map-pixel scale

function renderPixelatedTile(img, ctx, tileX, tileY) {
  const small = document.createElement('canvas');
  small.width = GRID; small.height = GRID;
  const sctx = small.getContext('2d');
  sctx.drawImage(img, 0, 0, GRID, GRID); // real tile, averaged down per block
  const src = sctx.getImageData(0, 0, GRID, GRID).data;
  const P = MC_PALETTES[THEME];

  const biome = new Array(GRID * GRID);
  for (let by = 0; by < GRID; by++) {
    for (let bx = 0; bx < GRID; bx++) {
      const i = (by * GRID + bx) * 4;
      biome[by * GRID + bx] = classifyBiome(src[i], src[i + 1], src[i + 2]);
    }
  }

  const out = ctx.createImageData(GRID, GRID);
  for (let by = 0; by < GRID; by++) {
    for (let bx = 0; bx < GRID; bx++) {
      const idx = by * GRID + bx;
      const i = idx * 4;
      const b = biome[idx];
      const lum = luminance(src[i], src[i + 1], src[i + 2]);
      let rgb;

      if (b === 'water') {
        let waterN = 0, total = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const wx = bx + dx, wy = by + dy;
          if (wx < 0 || wy < 0 || wx >= GRID || wy >= GRID) continue;
          total++;
          if (biome[wy * GRID + wx] === 'water') waterN++;
        }
        const depth = total ? waterN / total : 1; // 1 = deep, 0 = shoreline
        rgb = ditheredShade(P.water, 1 - depth, bx, by);
      } else if (b === 'forest') {
        rgb = grain(ditheredShade(P.forest, lum, bx, by), tileX, tileY, bx, by);
      } else if (b === 'road') {
        rgb = ditheredShade(P.road, lum, bx, by);
      } else if (b === 'building') {
        rgb = ditheredShade(P.building, lum, bx, by);
      } else {
        let nearWater = false;
        for (let dy = -1; dy <= 1 && !nearWater; dy++) for (let dx = -1; dx <= 1; dx++) {
          const wx = bx + dx, wy = by + dy;
          if (wx < 0 || wy < 0 || wx >= GRID || wy >= GRID) continue;
          if (biome[wy * GRID + wx] === 'water') { nearWater = true; break; }
        }
        rgb = nearWater
          ? ditheredShade(P.sand, lum, bx, by)
          : grain(ditheredShade(P.grass, lum, bx, by), tileX, tileY, bx, by);
      }

      out.data[i] = rgb[0]; out.data[i + 1] = rgb[1]; out.data[i + 2] = rgb[2]; out.data[i + 3] = 255;
    }
  }
  sctx.putImageData(out, 0, 0);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, GRID, GRID, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

let pixelLayer = null;

const PixelTileLayer = L.TileLayer.extend({
  createTile: function (coords, done) {
    const tile = document.createElement('canvas');
    tile.width = 256; tile.height = 256;
    tile.className = 'leaflet-tile mc-pixel-tile';
    const ctx = tile.getContext('2d');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        renderPixelatedTile(img, ctx, coords.x, coords.y);
        done(null, tile);
      } catch (err) {
        done(err, tile);
      }
    };
    img.onerror = () => done(new Error('tile load failed'), tile);
    img.src = this.getTileUrl(coords);
    return tile;
  }
});

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    center: [20, 0],
    zoom: 3,
  });

  // base terrain: real CARTO/OSM tiles, repainted with the Minecraft palette
  pixelLayer = new PixelTileLayer(
    'https://basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
    { maxZoom: 19, minZoom: 2 }
  ).addTo(map);

  // labels overlay: same real CARTO data, rendered crisp (never pixelated)
  // so street/place names stay readable
  L.tileLayer(
    'https://basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png',
    { maxZoom: 19, minZoom: 2, className: 'mc-labels-tile' }
  ).addTo(map);

  map.on('moveend zoomend', updateCoordReadout);
  updateCoordReadout();
  hideLoading();
  locateUser(true);
  renderWaypointMarkers();
}

// Minecraft-map-item pointer icon (rotates like the in-game map arrow)
function arrowIcon(heading) {
  const rot = heading || 0;
  return L.divIcon({
    className: '',
    html: `<div class="player-marker" style="transform: rotate(${rot}deg); transition: transform .2s;">
      <svg viewBox="0 0 24 24" width="22" height="22">
        <polygon points="12,2 20,20 12,15 4,20" fill="#c42a22" stroke="#2b2113" stroke-width="1.5"/>
      </svg>
    </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function locateUser(silent) {
  if (!navigator.geolocation) {
    if (!silent) alert('This device has no compass (geolocation unavailable).');
    return;
  }
  showLoading('Finding your coordinates…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      hideLoading();
      userLatLng = [pos.coords.latitude, pos.coords.longitude];
      if (!userMarker) {
        userMarker = L.marker(userLatLng, { icon: arrowIcon(pos.coords.heading) }).addTo(map);
      } else {
        userMarker.setLatLng(userLatLng);
        userMarker.setIcon(arrowIcon(pos.coords.heading));
      }
      map.setView(userLatLng, 16);
    },
    (err) => {
      hideLoading();
      if (!silent) alert('Could not find you: ' + err.message);
      map.setView([20, 0], 3);
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function updateCoordReadout() {
  const c = map.getCenter();
  els.coordReadout.textContent =
    `XYZ: ${c.lat.toFixed(3)}, ${map.getZoom()}, ${c.lng.toFixed(3)}`;
}

// ===== Waypoints (saved markers, like planting a banner) =====
const WP_KEY = 'cartograph_waypoints';
let waypointMarkers = [];

function loadWaypoints() {
  try { return JSON.parse(localStorage.getItem(WP_KEY)) || []; }
  catch { return []; }
}
function saveWaypoints(list) {
  localStorage.setItem(WP_KEY, JSON.stringify(list));
}

function waypointIcon() {
  return L.divIcon({
    className: '',
    html: '<div class="waypoint-marker"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function renderWaypointMarkers() {
  waypointMarkers.forEach((m) => map.removeLayer(m));
  waypointMarkers = [];
  loadWaypoints().forEach((wp) => {
    const m = L.marker([wp.lat, wp.lng], { icon: waypointIcon() }).addTo(map);
    waypointMarkers.push(m);
  });
}

els.dropWaypointBtn.addEventListener('click', () => {
  const c = map.getCenter();
  const name = prompt('Name this marker:', `Waypoint ${loadWaypoints().length + 1}`);
  if (name === null) return;
  const list = loadWaypoints();
  list.push({ name: name || 'Unnamed', lat: c.lat, lng: c.lng });
  saveWaypoints(list);
  renderWaypointMarkers();
});

els.waypointsBtn.addEventListener('click', () => {
  renderWaypointsPanel();
  els.waypointsList.classList.toggle('hidden');
});

function renderWaypointsPanel() {
  const list = loadWaypoints();
  els.waypointsList.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No markers planted yet — drop one with 📍';
    els.waypointsList.appendChild(li);
    return;
  }
  list.forEach((wp, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = wp.name;
    span.addEventListener('click', () => {
      map.setView([wp.lat, wp.lng], 16);
      els.waypointsList.classList.add('hidden');
      if (userLatLng) routeTo(userLatLng, [wp.lat, wp.lng]);
    });
    const del = document.createElement('button');
    del.className = 'mc-btn small';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const updated = loadWaypoints();
      updated.splice(i, 1);
      saveWaypoints(updated);
      renderWaypointMarkers();
      renderWaypointsPanel();
    });
    li.appendChild(span);
    li.appendChild(del);
    els.waypointsList.appendChild(li);
  });
}

// ===== Theme toggle (Overworld / Nether) =====
function applyTheme(theme) {
  document.body.classList.toggle('nether', theme === 'nether');
  els.themeBtn.textContent = theme === 'nether' ? '🔥' : '🌍';
  THEME = theme === 'nether' ? 'nether' : 'overworld';
  if (pixelLayer) pixelLayer.redraw();
}
const savedTheme = localStorage.getItem('cartograph_theme') || 'overworld';
applyTheme(savedTheme);
els.themeBtn.addEventListener('click', () => {
  const next = document.body.classList.contains('nether') ? 'overworld' : 'nether';
  applyTheme(next);
  localStorage.setItem('cartograph_theme', next);
});

// ===== Share / copy coordinates =====
async function copyCoords() {
  const c = map.getCenter();
  const text = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
  try {
    await navigator.clipboard.writeText(text);
    flashCoordReadout('Copied!');
  } catch {
    flashCoordReadout(text);
  }
}
function flashCoordReadout(msg) {
  const original = els.coordReadout.textContent;
  els.coordReadout.textContent = msg;
  setTimeout(() => updateCoordReadout(), 1200);
}
els.shareBtn.addEventListener('click', copyCoords);
els.coordReadout.addEventListener('click', copyCoords);

// ===== Search (Nominatim) =====
const RECENT_KEY = 'cartograph_recent_searches';
function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
  catch { return []; }
}
function saveRecent(item) {
  const list = loadRecent().filter((r) => r.display_name !== item.display_name);
  list.unshift({ display_name: item.display_name, lat: item.lat, lon: item.lon });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)));
}

let searchTimer = null;
els.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = els.searchInput.value.trim();
  if (q.length < 3) { els.results.classList.add('hidden'); return; }
  searchTimer = setTimeout(() => runSearch(q), 400);
});
els.searchInput.addEventListener('focus', () => {
  if (els.searchInput.value.trim()) return;
  const recent = loadRecent();
  if (recent.length) renderResults(recent, true);
});

els.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = els.searchInput.value.trim();
  if (q) runSearch(q);
});

async function runSearch(q) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=6`;
    const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
    const data = await res.json();
    renderResults(data);
  } catch (e) {
    console.error(e);
  }
}

function renderResults(items, isRecent) {
  els.results.innerHTML = '';
  if (!items.length) { els.results.classList.add('hidden'); return; }
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = (isRecent ? '🕐 ' : '') + item.display_name;
    li.addEventListener('click', () => selectDestination(item));
    els.results.appendChild(li);
  });
  els.results.classList.remove('hidden');
}

function selectDestination(item) {
  els.results.classList.add('hidden');
  els.searchInput.value = item.display_name.split(',')[0];
  saveRecent(item);
  const latlng = [parseFloat(item.lat), parseFloat(item.lon)];

  if (destMarker) map.removeLayer(destMarker);
  destMarker = L.marker(latlng).addTo(map);
  map.setView(latlng, 15);

  if (userLatLng) {
    routeTo(userLatLng, latlng);
  } else {
    showLoading('No starting point — tap ◎ to find yourself first.');
    setTimeout(hideLoading, 1800);
  }
}

// ===== Routing (OSRM public demo server) =====
const OSRM_PROFILE = { foot: 'foot', bike: 'bike', driving: 'driving' };

async function routeTo(from, to) {
  showLoading('Charting the path…');
  const profile = OSRM_PROFILE[travelMode];
  const url = `https://router.project-osrm.org/route/v1/${profile}/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    hideLoading();
    if (!data.routes || !data.routes.length) {
      alert('No path found through this terrain.');
      return;
    }
    drawRoute(data.routes[0]);
  } catch (e) {
    hideLoading();
    console.error(e);
    alert('The map spirits could not find a route right now.');
  }
}

function drawRoute(route) {
  if (routeLine) map.removeLayer(routeLine);
  const coords = route.geometry.coordinates.map((c) => [c[1], c[0]]);
  routeLine = L.polyline(coords, {
    color: '#c42a22',
    weight: 5,
    opacity: 0.9,
    dashArray: '1 10',
    lineCap: 'square',
  }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });

  const km = (route.distance / 1000).toFixed(1);
  const mins = Math.round(route.duration / 60);
  els.routeDist.textContent = `${km} km`;
  els.routeTime.textContent = `${mins} min`;

  els.routeSteps.innerHTML = '';
  route.legs[0].steps.forEach((step) => {
    const div = document.createElement('div');
    const instr = step.maneuver && step.maneuver.type ? describeStep(step) : step.name;
    div.textContent = instr;
    els.routeSteps.appendChild(div);
  });

  els.routeCard.classList.remove('hidden');
}

function describeStep(step) {
  const m = step.maneuver;
  const road = step.name || 'the path';
  const dist = step.distance > 950 ? `${(step.distance / 1000).toFixed(1)} km` : `${Math.round(step.distance)} m`;
  const verbs = {
    depart: 'Head out',
    arrive: 'Arrive at',
    turn: `Turn ${m.modifier || ''}`,
    'new name': 'Continue',
    continue: 'Continue',
    merge: 'Merge',
    roundabout: 'Take the roundabout',
    fork: `Bear ${m.modifier || ''}`,
  };
  const verb = verbs[m.type] || 'Continue';
  return `${verb} on ${road} — ${dist}`;
}

els.closeRoute.addEventListener('click', () => {
  els.routeCard.classList.add('hidden');
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
});

els.modeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    els.modeBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    travelMode = btn.dataset.mode;
    if (userLatLng && destMarker) routeTo(userLatLng, destMarker.getLatLng());
  });
});

els.locateBtn.addEventListener('click', () => locateUser(false));
els.zoomIn.addEventListener('click', () => map.zoomIn());
els.zoomOut.addEventListener('click', () => map.zoomOut());

// ===== PWA install prompt =====
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!localStorage.getItem('cartograph_install_dismissed')) {
    els.installBanner.classList.remove('hidden');
  }
});
els.installBtn.addEventListener('click', async () => {
  els.installBanner.classList.add('hidden');
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  }
});
els.dismissInstall.addEventListener('click', () => {
  els.installBanner.classList.add('hidden');
  localStorage.setItem('cartograph_install_dismissed', '1');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(console.error);
  });
}

showLoading('Generating world…');
initMap();
