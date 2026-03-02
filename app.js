const POLL_INTERVAL_MS = 15000;
const FLIGHT_BACKOFF_MS = 120000;
const SIM_INTERVAL_MS = 140;
const MAX_AIRCRAFT = 90;
const MAX_ROADS = 220;
const MAX_TRAFFIC_LIGHTS = 90;
const MAX_VEHICLES = 180;
const VEHICLE_ROAD_LIMIT = 60;
const MAX_BUILDINGS = 280;
const ROAD_LOAD_MAX_HEIGHT = 180000;

const GOOGLE_MAPS_API_KEY = window.GOOGLE_MAPS_API_KEY || '';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const cctvSources = [
  {
    name: 'Insecam Cam 1 (115.179.100.76)',
    url: 'http://115.179.100.76:8080/ViewerFrame?Resolution=640x480&Quality=Standard&Size=STD&Language=0&Sound=Enable&Mode=JPEG&RPeriod=3&SendMethod=1&View=Full'
  },
  {
    name: 'Insecam Cam 2 (31.173.253.61)',
    url: 'http://31.173.253.61:8080/ViewerFrame?Resolution=640x480&Quality=Standard&Size=STD&Language=0&Sound=Enable&Mode=JPEG&RPeriod=3&SendMethod=1&View=Full'
  },
  {
    name: 'Insecam Cam 3 (85.140.0.131)',
    url: 'http://85.140.0.131:8080/ViewerFrame?Resolution=640x480&Quality=Standard&Size=STD&Language=0&Sound=Enable&Mode=JPEG&RPeriod=3&SendMethod=1&View=Full'
  }
];

const state = {
  flights: new Map(),
  roads: [],
  intersections: [],
  trafficLights: [],
  vehicles: [],
  simulationHour: 12,
  lastFlightPoll: 0,
  lastTrafficLoad: 0,
  lastBuildingLoad: 0,
  lastFocus: null,
  loadingTraffic: false,
  loadingBuildings: false,
  terrainIsReal: false,
  usingCesiumBuildings: false,
  flightBackoffUntil: 0,
  trafficRequestSeq: 0,
  googleTilesLoaded: false
};

const viewer = new Cesium.Viewer('cesiumContainer', {
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  imageryProvider: new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
  timeline: false,
  animation: false,
  selectionIndicator: true,
  shouldAnimate: true,
  geocoder: false,
  infoBox: false,
  baseLayerPicker: false,
  navigationHelpButton: false,
  homeButton: false,
  sceneModePicker: false
});

viewer.scene.requestRenderMode = true;
viewer.scene.maximumRenderTimeChange = Infinity;
viewer.scene.globe.depthTestAgainstTerrain = false;
viewer.scene.globe.showGroundAtmosphere = true;
viewer.scene.fog.enabled = false;
viewer.scene.postProcessStages.fxaa.enabled = false;
viewer.resolutionScale = Math.min(1, 1.3 / window.devicePixelRatio);

const flightLayer = new Cesium.CustomDataSource('flights');
const trafficLayer = new Cesium.CustomDataSource('traffic');
const cctvLayer = new Cesium.CustomDataSource('cctv');
const buildingsLayer = new Cesium.CustomDataSource('buildingsFallback');
viewer.dataSources.add(flightLayer);
viewer.dataSources.add(trafficLayer);
viewer.dataSources.add(cctvLayer);
viewer.dataSources.add(buildingsLayer);

const ui = {
  selectionInfo: document.getElementById('selection-info'),
  toggleFlights: document.getElementById('toggle-flights'),
  toggleTraffic: document.getElementById('toggle-traffic'),
  toggleCctv: document.getElementById('toggle-cctv'),
  searchForm: document.getElementById('search-form'),
  searchInput: document.getElementById('search-input'),
  cctvSelect: document.getElementById('cctv-select'),
  cctvFrame: document.getElementById('cctv-frame'),
  timeSlider: document.getElementById('time-slider'),
  timeLabel: document.getElementById('time-label'),
  zoomLabel: document.getElementById('zoom-label')
};

for (const src of cctvSources) {
  const option = document.createElement('option');
  option.value = src.url;
  option.textContent = src.name;
  ui.cctvSelect.appendChild(option);
}
setCctvFrameSource(cctvSources[0].url);

ui.cctvSelect.addEventListener('change', () => {
  setCctvFrameSource(ui.cctvSelect.value);
});

ui.toggleFlights.addEventListener('change', () => {
  flightLayer.show = ui.toggleFlights.checked;
});
ui.toggleTraffic.addEventListener('change', () => {
  trafficLayer.show = ui.toggleTraffic.checked;
});
ui.toggleCctv.addEventListener('change', () => {
  cctvLayer.show = ui.toggleCctv.checked;
});


function setCctvFrameSource(url) {
  if (window.location.protocol === 'https:' && url.startsWith('http://')) {
    ui.cctvFrame.src = 'about:blank';
    ui.selectionInfo.textContent = 'CCTV stream blocked by browser mixed-content policy on HTTPS. Open via HTTP host or use HTTPS camera streams.';
    return;
  }
  ui.cctvFrame.src = url;
}

ui.timeSlider.addEventListener('input', () => {
  state.simulationHour = Number(ui.timeSlider.value);
  ui.timeLabel.textContent = `${String(state.simulationHour).padStart(2, '0')}:00`;
  recolorRoads();
});

ui.searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = ui.searchInput.value.trim();
  if (!query) return;

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
    const response = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const [first] = await response.json();
    if (!first) return;

    const lon = Number(first.lon);
    const lat = Number(first.lat);
    const hasBbox = Array.isArray(first.boundingbox) && first.boundingbox.length === 4;

    if (hasBbox) {
      const south = Number(first.boundingbox[0]);
      const north = Number(first.boundingbox[1]);
      const west = Number(first.boundingbox[2]);
      const east = Number(first.boundingbox[3]);
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
        duration: 1.4,
        orientation: { pitch: Cesium.Math.toRadians(-42) }
      });
    } else {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, 20000),
        duration: 1.4,
        orientation: { pitch: Cesium.Math.toRadians(-45) }
      });
    }

    await refreshTrafficForFocus(lon, lat, true);
    await refreshBuildingsForFocus(lon, lat, true);
    placeCctvMarkers(lon, lat);
  } catch (err) {
    console.warn('Search failed.', err);
  }
});

viewer.selectedEntityChanged.addEventListener((entity) => {
  if (!entity) {
    ui.selectionInfo.textContent = 'Click an object to view details.';
    return;
  }
  const props = entity.properties;
  if (!props) return;

  const lines = [];
  for (const key of props.propertyNames) {
    lines.push(`<strong>${key}</strong>: ${props[key].getValue()}`);
  }
  ui.selectionInfo.innerHTML = lines.join('<br>');
});

viewer.camera.moveEnd.addEventListener(async () => {
  const center = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  const lon = Cesium.Math.toDegrees(center.longitude);
  const lat = Cesium.Math.toDegrees(center.latitude);
  const height = Math.round(viewer.camera.positionCartographic.height);
  ui.zoomLabel.textContent = `Zoom: ${height.toLocaleString()}m`;

  await refreshTrafficForFocus(lon, lat, false);
  await refreshBuildingsForFocus(lon, lat, false);
  cullEntitiesByView();
  viewer.scene.requestRender();
});

function distanceDeg(lon1, lat1, lon2, lat2) {
  return Math.hypot(lon1 - lon2, lat1 - lat2);
}

function getRoadRadiusByHeight(height) {
  if (height < 4000) return 0.015;
  if (height < 12000) return 0.03;
  if (height < 35000) return 0.05;
  if (height < 80000) return 0.07;
  return 0.1;
}

function getBuildingRadiusByHeight(height) {
  if (height < 6000) return 0.015;
  if (height < 18000) return 0.025;
  return 0.04;
}

async function initGooglePhotorealisticTiles() {
  if (!Cesium.createGooglePhotorealistic3DTileset) {
    return;
  }

  if (!GOOGLE_MAPS_API_KEY) {
    ui.selectionInfo.textContent = 'Google Photorealistic 3D Tiles not enabled: set window.GOOGLE_MAPS_API_KEY before loading the app.';
    return;
  }

  try {
    Cesium.GoogleMaps.defaultApiKey = GOOGLE_MAPS_API_KEY;
    const tileset = await Cesium.createGooglePhotorealistic3DTileset();
    tileset.maximumScreenSpaceError = 24;
    tileset.dynamicScreenSpaceError = true;
    viewer.scene.primitives.add(tileset);
    viewer.scene.globe.show = false;
    state.googleTilesLoaded = true;
    ui.selectionInfo.textContent = 'Google Photorealistic 3D Tiles enabled.';
  } catch (err) {
    console.warn('Google Photorealistic 3D Tiles failed to load.', err);
    ui.selectionInfo.textContent = 'Google Photorealistic 3D Tiles failed; using fallback terrain/buildings.';
  }
}

async function initImageryAndTerrain() {
  viewer.imageryLayers.removeAll();
  const imageryProviders = [
    new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
    new Cesium.UrlTemplateImageryProvider({
      url: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      credit: '©OpenStreetMap, ©CARTO'
    })
  ];

  for (const provider of imageryProviders) {
    try {
      viewer.imageryLayers.addImageryProvider(provider);
      break;
    } catch (err) {
      console.warn('Imagery provider failed, trying next.', err);
    }
  }

  viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  viewer.scene.globe.depthTestAgainstTerrain = false;
  state.terrainIsReal = false;
}

async function init3DBuildings() {
  if (state.googleTilesLoaded) {
    state.usingCesiumBuildings = true;
    return true;
  }
  state.usingCesiumBuildings = false;
  return false;
}

async function refreshTrafficForFocus(lon, lat, force) {
  const height = viewer.camera.positionCartographic.height;
  if (height > ROAD_LOAD_MAX_HEIGHT && !force) {
    if (trafficLayer.entities.values.length > 0) {
      trafficLayer.entities.removeAll();
      state.roads = [];
      state.trafficLights = [];
      state.vehicles = [];
      ui.selectionInfo.textContent = 'Zoom in to load roads and traffic simulation.';
    }
    return;
  }

  const now = Date.now();
  const minInterval = force ? 0 : 7000;
  const movedLittle = state.lastFocus && distanceDeg(lon, lat, state.lastFocus.lon, state.lastFocus.lat) < 0.02;

  if (state.loadingTraffic) return;
  if (!force && now - state.lastTrafficLoad < minInterval && movedLittle) return;

  state.loadingTraffic = true;
  state.lastTrafficLoad = now;
  state.lastFocus = { lon, lat };
  ui.selectionInfo.textContent = 'Loading roads...';

  try {
    await loadRoadsNear(lon, lat, getRoadRadiusByHeight(height));
  } finally {
    state.loadingTraffic = false;
  }
}

async function refreshBuildingsForFocus(lon, lat, force) {
  if (state.googleTilesLoaded || state.usingCesiumBuildings) {
    buildingsLayer.entities.removeAll();
    return;
  }

  const height = viewer.camera.positionCartographic.height;
  if (height > 120000 && !force) {
    buildingsLayer.entities.removeAll();
    return;
  }

  const now = Date.now();
  const minInterval = force ? 0 : 9000;
  const movedLittle = state.lastFocus && distanceDeg(lon, lat, state.lastFocus.lon, state.lastFocus.lat) < 0.025;

  if (state.loadingBuildings) return;
  if (!force && now - state.lastBuildingLoad < minInterval && movedLittle) return;

  state.loadingBuildings = true;
  state.lastBuildingLoad = now;

  try {
    await loadFallbackBuildings(lon, lat, getBuildingRadiusByHeight(height));
  } finally {
    state.loadingBuildings = false;
  }
}

async function pollFlights(force = false) {
  const now = Date.now();
  if (now < state.flightBackoffUntil) return;
  if (!force && now - state.lastFlightPoll < POLL_INTERVAL_MS) return;
  state.lastFlightPoll = now;

  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return;

  const west = Cesium.Math.toDegrees(rect.west);
  const south = Cesium.Math.toDegrees(rect.south);
  const east = Cesium.Math.toDegrees(rect.east);
  const north = Cesium.Math.toDegrees(rect.north);

  const openSkyUrl = `https://opensky-network.org/api/states/all?lamin=${west.toFixed(4)}&lomin=${south.toFixed(4)}&lamax=${east.toFixed(4)}&lomax=${north.toFixed(4)}`;

  try {
    const response = await fetch(openSkyUrl);
    if (response.status === 429) {
      state.flightBackoffUntil = Date.now() + FLIGHT_BACKOFF_MS;
      updateFlightEntities(simulateFlights());
      return;
    }
    if (!response.ok) throw new Error(`OpenSky error ${response.status}`);
    const payload = await response.json();
    updateFlightEntities(payload.states || []);
  } catch (err) {
    updateFlightEntities(simulateFlights());
  }
}

function updateFlightEntities(statesInput) {
  const states = statesInput.slice(0, MAX_AIRCRAFT);
  const seen = new Set();

  states.forEach((s, idx) => {
    const isSimulated = Array.isArray(s) && s.length < 17;
    const id = isSimulated ? s[0] : (s[0] || `sim-${idx}`);
    const lon = Number(isSimulated ? s[1] : s[5]);
    const lat = Number(isSimulated ? s[2] : s[6]);
    const alt = Number(isSimulated ? s[3] : s[7] || 10000);
    const velocity = Number(isSimulated ? s[4] : s[9] || 220);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;

    seen.add(id);
    let entity = state.flights.get(id);
    if (!entity) {
      entity = flightLayer.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
        point: { pixelSize: 5, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
        label: {
          text: id,
          font: '10px sans-serif',
          pixelOffset: new Cesium.Cartesian2(0, -12),
          fillColor: Cesium.Color.WHITE,
          scale: 0.7,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 220000)
        },
        properties: {
          type: 'Aircraft',
          callsign: id,
          velocity: `${Math.round(velocity)} m/s`,
          altitude: `${Math.round(alt)} m`
        }
      });
      state.flights.set(id, entity);
    } else {
      const start = Cesium.JulianDate.now();
      const end = Cesium.JulianDate.addSeconds(start, POLL_INTERVAL_MS / 1000, new Cesium.JulianDate());
      const path = new Cesium.SampledPositionProperty();
      path.addSample(start, entity.position.getValue(start));
      path.addSample(end, Cesium.Cartesian3.fromDegrees(lon, lat, alt));
      entity.position = path;
      entity.properties.velocity = `${Math.round(velocity)} m/s`;
      entity.properties.altitude = `${Math.round(alt)} m`;
    }
  });

  for (const [id, entity] of state.flights.entries()) {
    if (!seen.has(id)) {
      flightLayer.entities.remove(entity);
      state.flights.delete(id);
    }
  }
}

function simulateFlights() {
  const center = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  const lon = Cesium.Math.toDegrees(center.longitude);
  const lat = Cesium.Math.toDegrees(center.latitude);
  return Array.from({ length: 18 }, (_, i) => ([
    `SIM${i}`,
    lon + (Math.random() - 0.5) * 5,
    lat + (Math.random() - 0.5) * 4,
    8000 + Math.random() * 4500,
    170 + Math.random() * 90
  ]));
}

async function fetchOverpass(query, timeoutMs = 3500) {
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: query,
        signal: controller.signal
      });
      clearTimeout(timer);
      return await response.json();
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }
  throw lastError || new Error('Overpass unavailable');
}

async function loadRoadsNear(lon, lat, radiusDeg) {
  const requestId = ++state.trafficRequestSeq;

  // Render synthetic traffic immediately so roads/lights/vehicles appear without waiting on Overpass.
  trafficLayer.entities.removeAll();
  state.roads = [];
  state.intersections = [];
  state.trafficLights = [];
  state.vehicles = [];
  makeSyntheticRoads(lon, lat);
  detectIntersections();
  buildTrafficEntities();
  ui.selectionInfo.textContent = 'Loading live roads… showing fast synthetic preview.';

  const south = lat - radiusDeg;
  const west = lon - radiusDeg;
  const north = lat + radiusDeg;
  const east = lon + radiusDeg;
  const roadsQuery = `[out:json][timeout:8];way["highway"](${south},${west},${north},${east});out geom;`;

  try {
    const data = await fetchOverpass(roadsQuery, 3000);
    if (requestId !== state.trafficRequestSeq) return;

    const ways = (data.elements || [])
      .filter((e) => e.type === 'way' && Array.isArray(e.geometry))
      .map((way) => ({ id: String(way.id), coords: way.geometry.map((p) => [p.lon, p.lat]) }))
      .filter((road) => road.coords.length >= 2)
      .slice(0, MAX_ROADS);

    if (ways.length === 0) return;

    trafficLayer.entities.removeAll();
    state.roads = [];
    state.intersections = [];
    state.trafficLights = [];
    state.vehicles = [];

    ways.forEach((road) => {
      state.roads.push({
        id: road.id,
        coords: simplifyRoad(road.coords),
        congestion: randomCongestion()
      });
    });

    detectIntersections();
    buildTrafficEntities();
    ui.selectionInfo.textContent = `Loaded ${state.roads.length} live roads, ${state.trafficLights.length} lights, ${state.vehicles.length} vehicles.`;
  } catch (err) {
    // Keep already-rendered synthetic traffic; no further action required.
  }
}

async function loadFallbackBuildings(lon, lat, radiusDeg) {
  buildingsLayer.entities.removeAll();

  const south = lat - radiusDeg;
  const west = lon - radiusDeg;
  const north = lat + radiusDeg;
  const east = lon + radiusDeg;
  const query = `[out:json][timeout:12];way["building"](${south},${west},${north},${east});out geom tags;`;

  try {
    const data = await fetchOverpass(query, 6000);
    const ways = (data.elements || [])
      .filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length >= 3)
      .slice(0, MAX_BUILDINGS);

    ways.forEach((way) => {
      const positions = way.geometry.flatMap((pt) => [pt.lon, pt.lat]);
      const levels = Number(way.tags?.['building:levels']) || (2 + Math.floor(Math.random() * 8));
      const height = Math.min(95, Math.max(10, levels * 3.2));
      buildingsLayer.entities.add({
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
          extrudedHeight: height,
          height: 0,
          material: Cesium.Color.GRAY.withAlpha(0.7),
          outline: false,
          perPositionHeight: false
        },
        properties: {
          type: 'Building',
          height: `${Math.round(height)} m`
        }
      });
    });
  } catch (err) {
    console.warn('Fallback building load failed.', err);
  }
}

function makeSyntheticRoads(lon, lat) {
  const span = 0.02;
  for (let i = -4; i <= 4; i += 1) {
    state.roads.push({ id: `h-${i}`, coords: [[lon - span, lat + i * 0.004], [lon + span, lat + i * 0.004]], congestion: randomCongestion() });
    state.roads.push({ id: `v-${i}`, coords: [[lon + i * 0.004, lat - span], [lon + i * 0.004, lat + span]], congestion: randomCongestion() });
  }
}

function simplifyRoad(coords) {
  if (coords.length <= 6) return coords;
  const step = Math.max(1, Math.floor(coords.length / 12));
  const simple = coords.filter((_, i) => i % step === 0);
  const last = coords[coords.length - 1];
  if (simple[simple.length - 1] !== last) simple.push(last);
  return simple;
}

function randomCongestion() {
  const rush = (state.simulationHour >= 7 && state.simulationHour <= 9) || (state.simulationHour >= 16 && state.simulationHour <= 18);
  return Cesium.Math.clamp((rush ? 0.7 : 0.35) + (Math.random() - 0.5) * 0.4, 0.1, 0.95);
}

function detectIntersections() {
  const nodeCounter = new Map();
  state.roads.forEach((road) => {
    road.coords.forEach(([lon, lat]) => {
      const key = `${lon.toFixed(5)}:${lat.toFixed(5)}`;
      nodeCounter.set(key, (nodeCounter.get(key) || 0) + 1);
    });
  });

  nodeCounter.forEach((count, key) => {
    if (count > 1) {
      const [lon, lat] = key.split(':').map(Number);
      state.intersections.push({ lon, lat });
    }
  });

  state.intersections.slice(0, MAX_TRAFFIC_LIGHTS).forEach((intersection, index) => {
    state.trafficLights.push({
      id: `light-${index}`,
      lon: intersection.lon,
      lat: intersection.lat,
      phaseOffset: index * 3,
      color: 'green',
      entity: null
    });
  });
}

function congestionColor(level) {
  if (level < 0.4) return Cesium.Color.LIME.withAlpha(0.85);
  if (level < 0.7) return Cesium.Color.YELLOW.withAlpha(0.85);
  return Cesium.Color.RED.withAlpha(0.9);
}

function buildTrafficEntities() {
  state.roads.forEach((road) => {
    trafficLayer.entities.add({
      id: `road-${road.id}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(road.coords.flatMap(([x, y]) => [x, y, 1])),
        width: 2,
        material: congestionColor(road.congestion)
      },
      properties: {
        type: 'Road',
        roadId: road.id,
        congestion: road.congestion.toFixed(2)
      }
    });
  });

  state.trafficLights.forEach((light) => {
    light.entity = trafficLayer.entities.add({
      id: light.id,
      position: Cesium.Cartesian3.fromDegrees(light.lon, light.lat, 5),
      point: { pixelSize: 6, color: Cesium.Color.GREEN },
      properties: { type: 'Traffic Light', status: 'green' }
    });
  });

  state.roads.slice(0, VEHICLE_ROAD_LIMIT).forEach((road, i) => {
    const count = Math.max(1, Math.round(road.congestion * 4));
    for (let j = 0; j < count; j += 1) {
      if (state.vehicles.length >= MAX_VEHICLES) return;
      const entity = trafficLayer.entities.add({
        id: `veh-${i}-${j}`,
        position: Cesium.Cartesian3.fromDegrees(road.coords[0][0], road.coords[0][1], 3),
        point: { pixelSize: 3.5, color: Cesium.Color.ORANGE },
        properties: { type: 'Vehicle', roadId: road.id, speed: '0.0' }
      });
      state.vehicles.push({ road, segment: 0, t: Math.random(), speed: 0.001 + Math.random() * 0.0014, entity });
    }
  });

  cullEntitiesByView();
}

function recolorRoads() {
  state.roads.forEach((road) => {
    road.congestion = randomCongestion();
    const entity = trafficLayer.entities.getById(`road-${road.id}`);
    if (entity) {
      entity.polyline.material = congestionColor(road.congestion);
      entity.properties.congestion = road.congestion.toFixed(2);
    }
  });
}

function lightStatus(seconds, phaseOffset) {
  const cycle = (seconds + phaseOffset) % 65;
  if (cycle < 30) return 'green';
  if (cycle < 35) return 'yellow';
  return 'red';
}

function placeCctvMarkers(lon, lat) {
  cctvLayer.entities.removeAll();
  cctvSources.forEach((source, index) => {
    cctvLayer.entities.add({
      id: `cctv-${index}`,
      position: Cesium.Cartesian3.fromDegrees(lon + (index - 1) * 0.01, lat + (1 - index) * 0.01, 8),
      billboard: {
        image: 'https://cdn-icons-png.flaticon.com/512/149/149852.png',
        width: 20,
        height: 20,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 70000)
      },
      properties: {
        type: 'CCTV Camera',
        source: source.name,
        stream: source.url
      }
    });
  });
}

function isInView(lon, lat, rect) {
  if (!rect) return true;
  const west = Cesium.Math.toDegrees(rect.west);
  const east = Cesium.Math.toDegrees(rect.east);
  const south = Cesium.Math.toDegrees(rect.south);
  const north = Cesium.Math.toDegrees(rect.north);
  const inLon = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
  return inLon && lat >= south && lat <= north;
}

function cullEntitiesByView() {
  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return;

  state.trafficLights.forEach((light) => {
    if (light.entity) light.entity.show = isInView(light.lon, light.lat, rect);
  });

  state.vehicles.forEach((vehicle) => {
    const point = vehicle.road.coords[Math.min(vehicle.segment, vehicle.road.coords.length - 1)];
    if (!point) return;
    vehicle.entity.show = isInView(point[0], point[1], rect);
  });
}

function stepSimulation() {
  const elapsed = Date.now() / 1000;

  state.trafficLights.forEach((light) => {
    const status = lightStatus(elapsed, light.phaseOffset);
    light.color = status;
    if (light.entity) {
      light.entity.point.color = status === 'green' ? Cesium.Color.GREEN : status === 'yellow' ? Cesium.Color.YELLOW : Cesium.Color.RED;
      light.entity.properties.status = status;
    }
  });

  state.vehicles.forEach((vehicle) => {
    if (!vehicle.entity.show) return;
    const coords = vehicle.road.coords;
    if (coords.length < 2) return;

    const from = coords[vehicle.segment % (coords.length - 1)];
    const to = coords[(vehicle.segment + 1) % (coords.length - 1) + 1];
    const nextLon = Cesium.Math.lerp(from[0], to[0], vehicle.t);
    const nextLat = Cesium.Math.lerp(from[1], to[1], vehicle.t);

    const blocked = state.trafficLights.some((light) => light.color === 'red' && Math.abs(light.lon - nextLon) < 0.0009 && Math.abs(light.lat - nextLat) < 0.0009);
    if (!blocked) {
      vehicle.t += vehicle.speed;
      if (vehicle.t >= 1) {
        vehicle.t = 0;
        vehicle.segment = (vehicle.segment + 1) % (coords.length - 1);
      }
    }

    const cFrom = coords[vehicle.segment % (coords.length - 1)];
    const cTo = coords[(vehicle.segment + 1) % (coords.length - 1) + 1];
    vehicle.entity.position = Cesium.Cartesian3.fromDegrees(Cesium.Math.lerp(cFrom[0], cTo[0], vehicle.t), Cesium.Math.lerp(cFrom[1], cTo[1], vehicle.t), 3);
    vehicle.entity.properties.speed = vehicle.speed.toFixed(4);
  });

  viewer.scene.requestRender();
}

setInterval(stepSimulation, SIM_INTERVAL_MS);
setInterval(() => pollFlights(false), POLL_INTERVAL_MS);

(async function init() {
  await initImageryAndTerrain();
  await initGooglePhotorealisticTiles();
  await init3DBuildings();

  const initialLon = -74.006;
  const initialLat = 40.7128;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(initialLon, initialLat, 22000),
    orientation: { pitch: Cesium.Math.toRadians(-45) }
  });

  await refreshTrafficForFocus(initialLon, initialLat, true);
  await refreshBuildingsForFocus(initialLon, initialLat, true);
  placeCctvMarkers(initialLon, initialLat);
  await pollFlights(true);

  cullEntitiesByView();
  ui.zoomLabel.textContent = `Zoom: ${Math.round(viewer.camera.positionCartographic.height).toLocaleString()}m`;
  if (!state.terrainIsReal) {
    ui.selectionInfo.innerHTML = 'Terrain fallback active. 3D buildings still render via OSM-extrusion fallback when Cesium tiles are unavailable.';
  }
  viewer.scene.requestRender();
})();
