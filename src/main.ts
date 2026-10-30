import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import circle from '@turf/circle';
import greatCircle from '@turf/great-circle';
import './style.css';

type Region = { code: string; longName: string; city: string; lon: number; lat: number };
type Measured = Region & { ms: number };
type LngLat = [number, number];
type Mode = 'idle' | 'measuring' | 'guess' | 'home' | 'reveal' | 'done';

const API_KEY = import.meta.env.VITE_LOCATION_API_KEY as string;
const MAP_REGION = 'ap-northeast-1';
const ROUNDS = 5;
const FIBER_KM_PER_MS = 200; // light in optical fiber, about 2/3 of c
const HALF_EARTH_KM = 20000;
const MS_SCALE = 40; // points halve roughly every 28 ms of difference
const CONCURRENCY = 6;
const HOME_VIEW = { center: [20, 25] as LngLat, zoom: 1.2 };

const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const styleUrl =
  `https://maps.geo.${MAP_REGION}.amazonaws.com/v2/styles/Standard/descriptor` +
  `?key=${API_KEY}&color-scheme=${dark ? 'Dark' : 'Light'}`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  round: $('round'), score: $('score'), clue: $('clue'), todo: $('todo'), steps: $('steps'),
  hint: $('hint'), result: $('result'),
  go: $<HTMLButtonElement>('go'), home: $<HTMLButtonElement>('home'), gps: $<HTMLButtonElement>('gps'),
};
const panel = $('panel');

// Vite pre-bundling breaks MapLibre's relative worker URL, so point it at a bundled worker.
maplibregl.setWorkerUrl(workerUrl);

const map = new maplibregl.Map({
  container: 'map', style: styleUrl, center: HOME_VIEW.center, zoom: HOME_VIEW.zoom,
  attributionControl: { compact: true },
});
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
const homeMarker = new maplibregl.Marker({ color: '#2563eb' });
const answerPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 });
const pickPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 });

let regions: Region[] = [];
let measured: Measured[] = [];
let queue: Measured[] = [];
let mode: Mode = 'idle';
let modeBeforeHome: Mode = 'idle';
let round = 0;
let total = 0;
let current: Measured | null = null;
let pick: Measured | null = null;
let home: LngLat | null = null;
let homeNear: Measured | null = null; // set when home is estimated from the fastest Region

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const lngLat = (r: Region): LngLat => [r.lon, r.lat];
const setData = (id: string, data: FeatureCollection | Feature) =>
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
const setTodo = (text: string) => { ui.todo.textContent = text; };
const setClue = (text: string, big = false) => {
  ui.clue.textContent = text;
  ui.clue.className = big ? 'big' : 'msg';
};
const fitPadding = () => {
  const wide = window.innerWidth > 600;
  return { top: 60, right: 60, left: wide ? panel.offsetWidth + 40 : 40, bottom: wide ? 60 : panel.offsetHeight + 40 };
};
const pointFC = (list: Measured[], withMs: boolean): FeatureCollection => ({
  type: 'FeatureCollection',
  features: list.map((r) => ({
    type: 'Feature',
    properties: { code: r.code, ms: r.ms, label: withMs ? `${r.ms} ms` : '' },
    geometry: { type: 'Point', coordinates: lngLat(r) },
  })),
});

// ---- map layers ----
const DOT_IDLE = '#94a3b8';
const HEAT: maplibregl.ExpressionSpecification =
  ['interpolate', ['linear'], ['get', 'ms'], 0, '#16a34a', 100, '#eab308', 200, '#f97316', 300, '#dc2626'];
let hasLabels = false;

map.on('load', () => {
  for (const id of ['circle', 'line-pick', 'line-answer', 'regions', 'picked', 'answer']) {
    map.addSource(id, { type: 'geojson', data: empty });
  }
  const stroke = dark ? '#0b0f17' : '#ffffff';
  map.addLayer({ id: 'circle-fill', type: 'fill', source: 'circle',
    paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'circle-edge', type: 'line', source: 'circle',
    paint: { 'line-color': '#2563eb', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'pick-line', type: 'line', source: 'line-pick',
    paint: { 'line-color': '#f59e0b', 'line-width': 2.5 } });
  map.addLayer({ id: 'answer-line', type: 'line', source: 'line-answer',
    paint: { 'line-color': '#16a34a', 'line-width': 2.5 } });
  map.addLayer({ id: 'region-dots', type: 'circle', source: 'regions',
    paint: { 'circle-radius': 6, 'circle-color': DOT_IDLE, 'circle-stroke-width': 1.5, 'circle-stroke-color': stroke } });
  map.addLayer({ id: 'picked-dot', type: 'circle', source: 'picked',
    paint: { 'circle-radius': 10, 'circle-color': '#f59e0b', 'circle-stroke-width': 2, 'circle-stroke-color': stroke } });
  map.addLayer({ id: 'answer-dot', type: 'circle', source: 'answer',
    paint: { 'circle-radius': 10, 'circle-color': '#16a34a', 'circle-stroke-width': 2, 'circle-stroke-color': stroke } });

  // Reuse a font the basemap style already serves, for the ms labels on the final map.
  const font = map.getStyle().layers
    .map((l) => (l as { layout?: Record<string, unknown> }).layout?.['text-font'])
    .find((f): f is string[] => Array.isArray(f) && f.every((x) => typeof x === 'string'));
  if (font) {
    map.addLayer({ id: 'region-labels', type: 'symbol', source: 'regions',
      layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 12,
        'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': false },
      paint: { 'text-color': dark ? '#f3f4f6' : '#111827', 'text-halo-color': stroke, 'text-halo-width': 1.5 } });
    hasLabels = true;
  }
  map.on('mouseenter', 'region-dots', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'region-dots', () => { map.getCanvas().style.cursor = ''; });
});

function showHeat(on: boolean) {
  setData('regions', pointFC(measured, on && hasLabels));
  if (!map.getLayer('region-dots')) return;
  map.setPaintProperty('region-dots', 'circle-color', on ? HEAT : DOT_IDLE);
  map.setPaintProperty('region-dots', 'circle-radius', on ? 8 : 6);
}

// ---- measuring ----
const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

async function measure(code: string): Promise<number | null> {
  const url = `https://dynamodb.${code}.amazonaws.com/`;
  const hit = () => withTimeout(fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' }), 5000);
  try {
    await hit(); // warm-up: DNS, TCP, TLS
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await hit();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return Math.round(samples[2]);
  } catch {
    return null;
  }
}

async function measureAll(list: Region[], onProgress: (done: number) => void): Promise<Measured[]> {
  const out: Measured[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < list.length) {
      const r = list[next++];
      const ms = await measure(r.code);
      if (ms !== null) out.push({ ...r, ms });
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

const shuffle = <T,>(a: T[]) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

// ---- game ----
function renderStatus() {
  ui.round.textContent = round ? `Round ${Math.min(round, ROUNDS)}/${ROUNDS}` : '';
  ui.score.textContent = round ? `${fmt(total)} pts` : '';
}

function updateHint() {
  if (!current) { ui.hint.textContent = ''; setData('circle', empty); return; }
  const r = (current.ms / 2) * FIBER_KM_PER_MS;
  const reach = `In ${current.ms} ms, light in fiber can go at most ~${fmt(r)} km and come back.`;
  const where = homeNear
    ? `The blue pin is you, guessed from your fastest Region (${homeNear.code}, ${homeNear.ms} ms). Move it if it’s wrong. `
    : '';
  if (!home) {
    ui.hint.textContent = `${reach} Optional: “Set my location” draws that limit on the map.`;
    setData('circle', empty);
  } else if (r >= HALF_EARTH_KM) {
    ui.hint.textContent = `${where}${reach} That covers the whole planet. No help this time.`;
    setData('circle', empty);
  } else {
    ui.hint.textContent = `${where}${reach} The Region must be inside the blue circle.`;
    setData('circle', circle(home, r, { steps: 128, units: 'kilometers' }));
  }
}

function clearRound() {
  pick = null;
  current = null;
  answerPopup.remove();
  pickPopup.remove();
  setData('picked', empty);
  setData('answer', empty);
  setData('line-pick', empty);
  setData('line-answer', empty);
  ui.result.replaceChildren();
}

async function newGame() {
  clearRound();
  round = 0;
  total = 0;
  measured = [];
  showHeat(false);
  renderStatus();
  mode = 'measuring';
  ui.steps.hidden = true;
  ui.go.disabled = true;
  ui.hint.textContent = '';
  setClue('Pinging every AWS Region from your browser…');
  measured = await measureAll(regions, (n) => setTodo(`${n} / ${regions.length} Regions measured`));
  if (measured.length < 2) {
    setClue('Could not reach enough Regions from this network.');
    setTodo('');
    mode = 'done';
    ui.go.textContent = 'Try again';
    ui.go.disabled = false;
    return;
  }
  showHeat(false);
  if (!home || homeNear) {
    homeNear = measured.reduce((a, b) => (b.ms < a.ms ? b : a));
    home = lngLat(homeNear);
    homeMarker.setLngLat(home).addTo(map);
  }
  queue = shuffle(measured);
  // Dev-only: put chosen Regions first (VITE_DEMO_ORDER=us-west-1,...) to record the demo video.
  const demo = import.meta.env.DEV ? (import.meta.env.VITE_DEMO_ORDER as string | undefined) : undefined;
  for (const code of (demo ?? '').split(',').filter(Boolean).reverse()) {
    const i = queue.findIndex((r) => r.code === code);
    if (i >= 0) queue.push(queue.splice(i, 1)[0]);
  }
  nextRound();
}

function nextRound() {
  clearRound();
  round += 1;
  if (round > ROUNDS || !queue.length) { finish(); return; }
  current = queue.pop()!;
  mode = 'guess';
  renderStatus();
  ui.go.disabled = true;
  ui.go.textContent = 'Guess';
  setClue(`${current.ms} ms`, true);
  setTodo('Which AWS Region answered in this time? Click a dot on the map.');
  updateHint();
  map.easeTo(HOME_VIEW);
}

function choose(r: Measured) {
  pick = r;
  setData('picked', pointFC([r], false));
  pickPopup.setLngLat(lngLat(r)).setHTML(`<b>${esc(r.code)}</b><br>${esc(r.longName)}`).addTo(map);
  ui.go.disabled = false;
  setTodo('Press Guess to lock it in, or click another Region.');
}

const verdict = (diff: number, exact: boolean) =>
  exact ? 'Exact Region!' : diff <= 10 ? 'Bullseye!' : diff <= 30 ? 'Great guess!' : diff <= 80 ? 'Not bad.' : 'Way off.';

function reveal() {
  if (!current || !pick) return;
  const ans = current;
  const p = pick;
  const exact = p.code === ans.code;
  const diff = Math.abs(p.ms - ans.ms);
  const pts = exact ? 5000 : Math.round(5000 * Math.exp(-diff / MS_SCALE));
  total += pts;

  setData('answer', pointFC([ans], false));
  if (home) {
    setData('line-answer', greatCircle(home, lngLat(ans), { npoints: 64 }));
    if (!exact) setData('line-pick', greatCircle(home, lngLat(p), { npoints: 64 }));
  }
  answerPopup.setLngLat(lngLat(ans))
    .setHTML(`<b>Answer: ${esc(ans.code)} · ${ans.ms} ms</b><br>${esc(ans.longName)}`).addTo(map);
  if (exact) {
    pickPopup.remove();
    setData('picked', empty);
    map.easeTo({ center: lngLat(ans), zoom: 3 });
  } else {
    pickPopup.setLngLat(lngLat(p))
      .setHTML(`<b>Your pick: ${esc(p.code)} · ${p.ms} ms</b><br>${esc(p.longName)}`).addTo(map);
    const b = new maplibregl.LngLatBounds(lngLat(p), lngLat(p)).extend(lngLat(ans));
    if (home) b.extend(home);
    map.fitBounds(b,
      { padding: fitPadding(), maxZoom: 4 });
  }

  ui.result.innerHTML = `
    <div class="verdict">${verdict(diff, exact)}</div>
    <div class="pts">+${fmt(pts)} <small>pts</small></div>
    <div class="facts">
      <span>Answer</span><b>${esc(ans.longName)} · ${esc(ans.code)} · ${ans.ms} ms</b>
      <span>Your pick</span><b>${esc(p.longName)} · ${esc(p.code)} · ${p.ms} ms</b>
      <span>Difference</span><b>${exact ? 'none' : `${diff} ms`}</b>
    </div>`;
  mode = 'reveal';
  setTodo('');
  renderStatus();
  ui.go.textContent = round >= ROUNDS ? 'See total' : 'Next round';
}

function finish() {
  mode = 'done';
  round = ROUNDS;
  renderStatus();
  setClue(`${fmt(total)} / ${fmt(5000 * ROUNDS)}`, true);
  setTodo('');
  ui.hint.textContent = '';
  setData('circle', empty);
  showHeat(true);
  map.easeTo(HOME_VIEW);
  ui.result.innerHTML = `
    <div class="verdict">Your latency map</div>
    <p class="hint">Every dot is an AWS Region, colored by how long it took to answer you:
    green is fast, red is slow. Click a dot for its time. Play again from somewhere else and the map changes.</p>`;
  ui.go.textContent = 'Play again';
  ui.go.disabled = false;
  ui.steps.hidden = false;
}

const km = (a: LngLat, b: LngLat) => {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

function nearestMeasured(p: LngLat): Measured | null {
  let best: Measured | null = null;
  let bestKm = Infinity;
  for (const r of measured) {
    const d = km(p, lngLat(r));
    if (d < bestKm) { best = r; bestKm = d; }
  }
  return best;
}

function setHome(p: LngLat) {
  home = p;
  homeNear = null;
  homeMarker.setLngLat(p).addTo(map);
  if (mode === 'home') mode = modeBeforeHome;
  ui.home.textContent = 'Move my location';
  updateHint();
}

map.on('click', (e: MapMouseEvent) => {
  const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
  if (mode === 'home') { setHome(p); return; }
  if (mode === 'guess') {
    const r = nearestMeasured(p);
    if (r) choose(r);
  } else if (mode === 'done' && measured.length) {
    const r = nearestMeasured(p);
    if (r) answerPopup.setLngLat(lngLat(r)).setHTML(`<b>${esc(r.code)} · ${r.ms} ms</b><br>${esc(r.longName)}`).addTo(map);
  }
});

ui.home.addEventListener('click', () => {
  if (mode === 'home') return;
  modeBeforeHome = mode;
  mode = 'home';
  ui.hint.textContent = 'Tap the map where you are now.';
});

ui.gps.addEventListener('click', () => {
  if (!navigator.geolocation) { ui.hint.textContent = 'GPS is not available. Use “Set my location”.'; return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => setHome([pos.coords.longitude, pos.coords.latitude]),
    () => { ui.hint.textContent = 'Location unavailable. Use “Set my location” instead.'; },
  );
});

ui.go.addEventListener('click', () => {
  if (mode === 'idle' || mode === 'done') void newGame();
  else if (mode === 'guess' && pick) reveal();
  else if (mode === 'reveal') nextRound();
});

// ---- tutorial ----
const TUT_KEY = 'ping-guessr:tutorial-seen';
const tut = {
  el: $('tutorial'), dots: $('tut-dots'),
  next: $<HTMLButtonElement>('tut-next'), back: $<HTMLButtonElement>('tut-back'),
  skip: $<HTMLButtonElement>('tut-skip'), help: $<HTMLButtonElement>('help'),
};
const slides = Array.from(tut.el.querySelectorAll<HTMLElement>('[data-step]'));
let step = 0;

function showStep(i: number) {
  step = i;
  slides.forEach((s, j) => { s.hidden = j !== i; });
  tut.back.hidden = i === 0;
  tut.next.textContent = i === slides.length - 1 ? 'Let’s play' : 'Next';
  tut.dots.innerHTML = slides.map((_, j) => `<span class="${j === i ? 'on' : ''}"></span>`).join('');
}
function openTutorial() {
  tut.el.hidden = false;
  showStep(0);
  tut.next.focus();
}
function closeTutorial(start: boolean) {
  tut.el.hidden = true;
  try { localStorage.setItem(TUT_KEY, '1'); } catch { /* storage unavailable */ }
  if (start && (mode === 'idle' || mode === 'done') && regions.length) void newGame();
}
tut.next.addEventListener('click', () => (step === slides.length - 1 ? closeTutorial(true) : showStep(step + 1)));
tut.back.addEventListener('click', () => showStep(Math.max(0, step - 1)));
tut.skip.addEventListener('click', () => closeTutorial(false));
tut.help.addEventListener('click', openTutorial);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tut.el.hidden) closeTutorial(false); });
const tutorialSeen = () => { try { return localStorage.getItem(TUT_KEY) === '1'; } catch { return false; } };

fetch('/regions.json')
  .then((r) => r.json())
  .then((data: Region[]) => {
    regions = data;
    setClue('Which AWS Region is behind this ping?');
    ui.go.disabled = false;
    if (!tutorialSeen()) openTutorial();
  })
  .catch(() => setClue('Could not load the Region list.'));

map.on('error', (e) => console.error('[map]', e.error ?? e));

if (import.meta.env.DEV) Object.assign(window, { __pg: { map, measured: () => measured } });
