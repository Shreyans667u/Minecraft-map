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

// ===== Procedural Minecraft-map renderer =====
// Real map tiles are only used to classify each block into a biome
// (water / grass / forest / road / building) from their average color.
// The actual pixels you see are generated — noise-shaded, 4-tier
// elevation-lit, nearest-neighbor-scaled — the way an in-game map renders.

function hash(x, y) {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = (n ^ (n >> 13)) * 1274126177;
  n = (n ^ (n >> 16)) >>> 0;
  return n / 4294967295;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function valueNoise2D(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const v00 = hash(xi, yi), v10 = hash(xi + 1, yi);
  const v01 = hash(xi, yi + 1), v11 = hash(xi + 1, yi + 1);
  const u = smooth(xf), v = smooth(yf);
  const a = v00 + (v10 - v00) * u;
  const b = v01 + (v11 - v01) * u;
  return a + (b - a) * v;
}
function fbm(x, y, octaves, freq) {
  let sum = 0, amp = 0.5, f = freq, max = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2D(x * f, y * f) * amp;
    max += amp;
    amp *= 0.5; f *= 2;
  }
  return sum / max;
}
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpColor(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function applyShade(c, mult) {
  return [
    Math.max(0, Math.min(255, Math.round(c[0] * mult))),
    Math.max(0, Math.min(255, Math.round(c[1] * mult))),
    Math.max(0, Math.min(255, Math.round(c[2] * mult))),
  ];
}
// Minecraft maps shade each block against its north-west neighbor's height:
// dropping = darkest, flat = dark, rising = base, steep rise = brightest.
function elevationShade(nx, ny) {
  const e0 = fbm(nx, ny, 4, 0.05);
  const eNW = fbm(nx - 1, ny - 1, 4, 0.05);
  const d = e0 - eNW;
  if (d < -0.015) return 0.72;
  if (d < 0) return 0.86;
  if (d < 0.015) return 1.0;
  return 1.15;
}

const THEME_PALETTES = {
  overworld: {
    grass: [[86, 152, 62], [104, 168, 74], [70, 132, 50]],
    forestDark: [34, 90, 34], forestMid: [52, 112, 46], forestLight: [80, 144, 62],
    waterShallow: [96, 172, 214], waterMid: [46, 120, 190], waterDeep: [24, 70, 148],
    stone: [[150, 150, 150], [168, 168, 168], [130, 130, 130], [190, 190, 190]],
    snow: [[240, 240, 245], [212, 214, 220]],
    sand: [[214, 197, 145], [224, 208, 160], [200, 182, 128]],
    road: [[196, 184, 156], [206, 194, 166], [184, 172, 146]],
  },
  nether: {
    grass: [[124, 42, 34], [148, 54, 38], [104, 32, 28]],
    forestDark: [72, 20, 60], forestMid: [98, 30, 78], forestLight: [130, 46, 96],
    waterShallow: [230, 120, 40], waterMid: [214, 82, 24], waterDeep: [150, 40, 10],
    stone: [[52, 40, 54], [66, 50, 68], [42, 32, 44], [80, 60, 82]],
    snow: [[70, 70, 78], [50, 48, 56]],
    sand: [[92, 74, 70], [104, 84, 80], [80, 64, 60]],
    road: [[110, 60, 40], [122, 70, 48], [98, 52, 34]],
  },
};
let THEME = 'overworld';

function pick3(arr, n) { return arr[Math.floor(n * arr.length) % arr.length]; }

function grassColor(nx, ny, shade, isBeach) {
  const P = THEME_PALETTES[THEME];
  if (isBeach) return applyShade(pick3(P.sand, hash(Math.floor(nx * 4), Math.floor(ny * 4))), shade);
  const n = fbm(nx * 2.2, ny * 2.2, 3, 1);
  return applyShade(pick3(P.grass, n), shade);
}
function forestColor(nx, ny, shade) {
  const P = THEME_PALETTES[THEME];
  const clump = fbm(nx * 0.25, ny * 0.25, 2, 1);
  const grain = hash(Math.floor(nx * 3), Math.floor(ny * 3));
  const treeChance = 0.3 + clump * 0.45;
  let base;
  if (grain < treeChance * 0.4) base = P.forestDark;
  else if (grain < treeChance) base = P.forestMid;
  else base = P.forestLight;
  return applyShade(base, shade);
}
function waterColor(nx, ny, depthFactor) {
  const P = THEME_PALETTES[THEME];
  const n = fbm(nx * 2.5, ny * 2.5, 2, 1);
  let base = depthFactor > 0.66 ? P.waterDeep : depthFactor > 0.33 ? P.waterMid : P.waterShallow;
  base = lerpColor(base, [255, 255, 255], n * 0.05);
  return applyShade(base, 1.0);
}
function stoneColor(nx, ny, shade) {
  const P = THEME_PALETTES[THEME];
  const n = fbm(nx * 2.2, ny * 2.2, 3, 1);
  const snowLine = fbm(nx * 0.04, ny * 0.04, 2, 1);
  let base = pick3(P.stone, n);
  if (snowLine > 0.74) base = pick3(P.snow, n);
  return applyShade(base, shade);
}
function roadColor(nx, ny, shade) {
  const P = THEME_PALETTES[THEME];
  const n = hash(Math.floor(nx * 5), Math.floor(ny * 5));
  return applyShade(pick3(P.road, n), shade);
}
function snowBiomeColor(nx, ny, shade) {
  const P = THEME_PALETTES[THEME];
  const n = hash(Math.floor(nx * 5), Math.floor(ny * 5));
  return applyShade(pick3(P.snow, n), shade);
}

// Reference swatches from the source tile's flat colors, used only to
// classify each block into a biome — never drawn directly.
const BIOME_REFS = [
  { rgb: [170, 211, 223], biome: 'water' },
  { rgb: [200, 222, 187], biome: 'forest' },
  { rgb: [242, 239, 233], biome: 'grass' },
  { rgb: [255, 255, 255], biome: 'road' },
  { rgb: [247, 220, 124], biome: 'road' },
  { rgb: [224, 223, 220], biome: 'stone' },
];
function classifyBiome(r, g, b) {
  let best = 'grass', bestDist = Infinity;
  for (const ref of BIOME_REFS) {
    const d = (r - ref.rgb[0]) ** 2 + (g - ref.rgb[1]) ** 2 + (b - ref.rgb[2]) ** 2;
    if (d < bestDist) { bestDist = d; best = ref.biome; }
  }
  return best;
}

const GRID = 32; // blocks per tile edge

function renderPixelatedTile(img, ctx, tileX, tileY) {
  const small = document.createElement('canvas');
  small.width = GRID; small.height = GRID;
  const sctx = small.getContext('2d');
  sctx.drawImage(img, 0, 0, GRID, GRID);
  const src = sctx.getImageData(0, 0, GRID, GRID).data;

  // pass 1: classify every block into a biome
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
      const nx = tileX * GRID + bx, ny = tileY * GRID + by;
      const b = biome[idx];
      let rgb;

      if (b === 'water') {
        // depth = how surrounded by other water this block is
        let waterNeighbors = 0, total = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const wx = bx + dx, wy = by + dy;
          if (wx < 0 || wy < 0 || wx >= GRID || wy >= GRID) continue;
          total++;
          if (biome[wy * GRID + wx] === 'water') waterNeighbors++;
        }
        rgb = waterColor(nx, ny, total ? waterNeighbors / total : 1);
      } else if (b === 'forest') {
        rgb = forestColor(nx, ny, elevationShade(nx, ny));
      } else if (b === 'road') {
        rgb = roadColor(nx, ny, elevationShade(nx, ny));
      } else if (b === 'stone') {
        rgb = stoneColor(nx, ny, elevationShade(nx, ny));
      } else {
        // grass — check adjacency to water for a sandy beach fringe
        let nearWater = false;
        for (let dy = -1; dy <= 1 && !nearWater; dy++) for (let dx = -1; dx <= 1; dx++) {
          const wx = bx + dx, wy = by + dy;
          if (wx < 0 || wy < 0 || wx >= GRID || wy >= GRID) continue;
          if (biome[wy * GRID + wx] === 'water') { nearWater = true; break; }
        }
        const climate = fbm(nx * 0.015, ny * 0.015, 2, 1);
        if (climate > 0.76 && !nearWater) {
          rgb = snowBiomeColor(nx, ny, elevationShade(nx, ny));
        } else {
          rgb = grassColor(nx, ny, elevationShade(nx, ny), nearWater);
        }
      }

      const p = idx * 4;
      out.data[p] = rgb[0]; out.data[p + 1] = rgb[1]; out.data[p + 2] = rgb[2]; out.data[p + 3] = 255;
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
    tile.className = 'leaflet-tile';
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

  pixelLayer = new PixelTileLayer(
    'https://basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
    { maxZoom: 19, minZoom: 2 }
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
