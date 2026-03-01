const POLL_INTERVAL_MS = 12000;
const MAX_AIRCRAFT = 120;
const MAX_VEHICLES = 350;

const cctvSources = [
  { name: 'EarthCam Times Square', url: 'https://www.earthcam.com/usa/newyork/timessquare/?cam=tsrobo1' },
  { name: '511NY CCTV Portal', url: 'https://511ny.org/cctv' },
  { name: 'Insecam Public Cameras', url: 'http://www.insecam.org/' }
];

const state = {
  flights: new Map(),
  roads: [],
  intersections: [],
  trafficLights: [],
  vehicles: [],
  simulationHour: 12,
  lastFlightPoll: 0
};

Cesium.Ion.defaultAccessToken = '';

const viewer = new Cesium.Viewer('cesiumContainer', {
  terrain: Cesium.Terrain.fromWorldTerrain(),
  timeline: false,
  animation: false,
  selectionIndicator: true,
  shouldAnimate: true,
  geocoder: false,
  infoBox: false,
  baseLayerPicker: false
});
viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.scene.requestRenderMode = true;
viewer.camera.flyHome(0);

const flightLayer = new Cesium.CustomDataSource('flights');
const trafficLayer = new Cesium.CustomDataSource('traffic');
const cctvLayer = new Cesium.CustomDataSource('cctv');
viewer.dataSources.add(flightLayer);
viewer.dataSources.add(trafficLayer);
viewer.dataSources.add(cctvLayer);

let buildingsTileset;
Cesium.createOsmBuildingsAsync().then((tileset) => {
  buildingsTileset = tileset;
  viewer.scene.primitives.add(tileset);
}).catch((err) => {
  console.warn('OSM buildings unavailable in this environment.', err);
});

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
ui.cctvFrame.src = cctvSources[0].url;
ui.cctvSelect.addEventListener('change', () => {
  ui.cctvFrame.src = ui.cctvSelect.value;
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

ui.timeSlider.addEventListener('input', () => {
  state.simulationHour = Number(ui.timeSlider.value);
  ui.timeLabel.textContent = `${String(state.simulationHour).padStart(2, '0')}:00`;
  recolorRoads();
});

ui.searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = ui.searchInput.value.trim();
  if (!query) return;

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
  const response = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  const [first] = await response.json();
  if (!first) return;

  const lon = Number(first.lon);
  const lat = Number(first.lat);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 18000),
    duration: 1.5
  });

  await loadRoadsNear(lon, lat, 0.06);
  placeCctvMarkers(lon, lat);
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

viewer.camera.changed.addEventListener(() => {
  const height = Math.round(viewer.camera.positionCartographic.height);
  ui.zoomLabel.textContent = `Zoom: ${height.toLocaleString()}m`;
});

async function pollFlights(force = false) {
  const now = Date.now();
  if (!force && now - state.lastFlightPoll < POLL_INTERVAL_MS) return;
  state.lastFlightPoll = now;

  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return;

  const bbox = {
    lam: Cesium.Math.toDegrees(rect.west),
    lomin: Cesium.Math.toDegrees(rect.south),
    lamax: Cesium.Math.toDegrees(rect.east),
    lomax: Cesium.Math.toDegrees(rect.north)
  };

  const openSkyUrl = `https://opensky-network.org/api/states/all?lamin=${bbox.lam.toFixed(4)}&lomin=${bbox.lomin.toFixed(4)}&lamax=${bbox.lamax.toFixed(4)}&lomax=${bbox.lomax.toFixed(4)}`;

  try {
    const response = await fetch(openSkyUrl);
    const payload = await response.json();
    updateFlightEntities(payload.states || []);
  } catch (err) {
    console.warn('OpenSky fetch failed; using fallback simulated flights.', err);
    updateFlightEntities(simulateFlights());
  }
}

function updateFlightEntities(statesInput) {
  const states = statesInput.slice(0, MAX_AIRCRAFT);
  const seen = new Set();

  states.forEach((s, idx) => {
    const isSimulated = Array.isArray(s) && s.length < 17;
    const icao = isSimulated ? s[0] : (s[0] || `sim-${idx}`);
    const lon = Number(isSimulated ? s[1] : s[5]);
    const lat = Number(isSimulated ? s[2] : s[6]);
    const alt = Number(isSimulated ? s[3] : s[7] || 10000);
    const velocity = Number(isSimulated ? s[4] : s[9] || 220);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    seen.add(icao);

    let entity = state.flights.get(icao);
    if (!entity) {
      entity = flightLayer.entities.add({
        id: icao,
        position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
        point: { pixelSize: 7, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
        label: {
          text: icao,
          font: '11px sans-serif',
          pixelOffset: new Cesium.Cartesian2(0, -16),
          fillColor: Cesium.Color.WHITE,
          scale: 0.8
        },
        properties: {
          type: 'Aircraft',
          callsign: icao,
          velocity: `${Math.round(velocity)} m/s`,
          altitude: `${Math.round(alt)} m`
        }
      });
      state.flights.set(icao, entity);
    } else {
      const start = Cesium.JulianDate.now();
      const end = Cesium.JulianDate.addSeconds(start, POLL_INTERVAL_MS / 1000, new Cesium.JulianDate());
      const position = new Cesium.SampledPositionProperty();
      position.addSample(start, entity.position.getValue(start));
      position.addSample(end, Cesium.Cartesian3.fromDegrees(lon, lat, alt));
      entity.position = position;
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
  return Array.from({ length: 20 }, (_, i) => ([
    `SIM${i}`,
    lon + (Math.random() - 0.5) * 8,
    lat + (Math.random() - 0.5) * 6,
    8000 + Math.random() * 5000,
    160 + Math.random() * 120
  ]));
}

async function loadRoadsNear(lon, lat, radiusDeg) {
  trafficLayer.entities.removeAll();
  state.roads = [];
  state.intersections = [];
  state.trafficLights = [];
  state.vehicles = [];

  const south = lat - radiusDeg;
  const west = lon - radiusDeg;
  const north = lat + radiusDeg;
  const east = lon + radiusDeg;
  const overpassQuery = `[out:json][timeout:25];(way["highway"](${south},${west},${north},${east});>;);out body;`;

  let elements = [];
  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: overpassQuery
    });
    const data = await response.json();
    elements = data.elements || [];
  } catch (err) {
    console.warn('Overpass unavailable, using synthetic roads.', err);
  }

  const nodeMap = new Map();
  for (const e of elements) {
    if (e.type === 'node') nodeMap.set(e.id, [e.lon, e.lat]);
  }
  const ways = elements.filter((e) => e.type === 'way' && Array.isArray(e.nodes));

  if (ways.length === 0) {
    makeSyntheticRoads(lon, lat);
  } else {
    ways.forEach((way) => {
      const coords = way.nodes.map((id) => nodeMap.get(id)).filter(Boolean);
      if (coords.length < 2) return;
      state.roads.push({ id: way.id, coords, congestion: randomCongestion() });
    });
  }

  detectIntersections();
  buildTrafficEntities();
}

function makeSyntheticRoads(lon, lat) {
  const span = 0.03;
  for (let i = -4; i <= 4; i += 1) {
    state.roads.push({ id: `h-${i}`, coords: [[lon - span, lat + i * 0.005], [lon + span, lat + i * 0.005]], congestion: randomCongestion() });
    state.roads.push({ id: `v-${i}`, coords: [[lon + i * 0.005, lat - span], [lon + i * 0.005, lat + span]], congestion: randomCongestion() });
  }
}

function randomCongestion() {
  const base = state.simulationHour >= 7 && state.simulationHour <= 9 || state.simulationHour >= 16 && state.simulationHour <= 18 ? 0.7 : 0.35;
  return Cesium.Math.clamp(base + (Math.random() - 0.5) * 0.5, 0.05, 0.98);
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

  state.intersections.forEach((int, i) => {
    state.trafficLights.push({
      id: `light-${i}`,
      lon: int.lon,
      lat: int.lat,
      phaseOffset: i * 3,
      color: 'green'
    });
  });
}

function congestionColor(value) {
  if (value < 0.4) return Cesium.Color.LIME.withAlpha(0.9);
  if (value < 0.7) return Cesium.Color.YELLOW.withAlpha(0.9);
  return Cesium.Color.RED.withAlpha(0.9);
}

function buildTrafficEntities() {
  state.roads.forEach((road) => {
    const positions = road.coords.flatMap(([lon, lat]) => [lon, lat, 2]);
    trafficLayer.entities.add({
      id: `road-${road.id}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
        width: 3,
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
    const entity = trafficLayer.entities.add({
      id: light.id,
      position: Cesium.Cartesian3.fromDegrees(light.lon, light.lat, 6),
      point: { pixelSize: 8, color: Cesium.Color.GREEN },
      properties: { type: 'Traffic Light', status: 'green' }
    });
    light.entity = entity;
  });

  const roads = state.roads.slice(0, Math.min(state.roads.length, 60));
  roads.forEach((road, idx) => {
    const vehicleCount = Math.max(2, Math.round(road.congestion * 8));
    for (let i = 0; i < vehicleCount; i += 1) {
      if (state.vehicles.length >= MAX_VEHICLES) return;
      const vehicle = {
        id: `veh-${idx}-${i}`,
        road,
        segment: 0,
        t: Math.random(),
        speed: 0.0008 + Math.random() * 0.0016,
        blocked: false
      };
      vehicle.entity = trafficLayer.entities.add({
        id: vehicle.id,
        position: Cesium.Cartesian3.fromDegrees(road.coords[0][0], road.coords[0][1], 3),
        point: { pixelSize: 4, color: Cesium.Color.ORANGE },
        properties: {
          type: 'Vehicle',
          roadId: road.id,
          speed: vehicle.speed.toFixed(4)
        }
      });
      state.vehicles.push(vehicle);
    }
  });
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
  cctvSources.forEach((src, idx) => {
    cctvLayer.entities.add({
      id: `cctv-${idx}`,
      position: Cesium.Cartesian3.fromDegrees(lon + (idx - 1) * 0.012, lat + (1 - idx) * 0.01, 12),
      billboard: {
        image: 'https://cdn-icons-png.flaticon.com/512/149/149852.png',
        width: 22,
        height: 22
      },
      properties: {
        type: 'CCTV Camera',
        source: src.name,
        stream: src.url
      }
    });
  });
}

const startSeconds = Date.now() / 1000;
viewer.clock.onTick.addEventListener(() => {
  const elapsed = Date.now() / 1000 - startSeconds;

  state.trafficLights.forEach((light) => {
    const status = lightStatus(elapsed, light.phaseOffset);
    light.color = status;
    const colorMap = { green: Cesium.Color.GREEN, yellow: Cesium.Color.YELLOW, red: Cesium.Color.RED };
    light.entity.point.color = colorMap[status];
    light.entity.properties.status = status;
  });

  state.vehicles.forEach((vehicle) => {
    const coords = vehicle.road.coords;
    if (coords.length < 2) return;
    const from = coords[vehicle.segment % (coords.length - 1)];
    const to = coords[(vehicle.segment + 1) % (coords.length - 1) + 1];

    const nextLon = Cesium.Math.lerp(from[0], to[0], vehicle.t);
    const nextLat = Cesium.Math.lerp(from[1], to[1], vehicle.t);

    const nearbyRedLight = state.trafficLights.some((light) => {
      if (light.color !== 'red') return false;
      const dLon = Math.abs(light.lon - nextLon);
      const dLat = Math.abs(light.lat - nextLat);
      return dLon < 0.0009 && dLat < 0.0009;
    });

    if (!nearbyRedLight) {
      vehicle.t += vehicle.speed;
      if (vehicle.t >= 1) {
        vehicle.t = 0;
        vehicle.segment = (vehicle.segment + 1) % (coords.length - 1);
      }
    }

    const currentFrom = coords[vehicle.segment % (coords.length - 1)];
    const currentTo = coords[(vehicle.segment + 1) % (coords.length - 1) + 1];
    const lon = Cesium.Math.lerp(currentFrom[0], currentTo[0], vehicle.t);
    const lat = Cesium.Math.lerp(currentFrom[1], currentTo[1], vehicle.t);
    vehicle.entity.position = Cesium.Cartesian3.fromDegrees(lon, lat, 3);
  });

  pollFlights(false);
});

(async function init() {
  await loadRoadsNear(-74.006, 40.7128, 0.05);
  placeCctvMarkers(-74.006, 40.7128);
  viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-74.006, 40.7128, 22000) });
  await pollFlights(true);
})();
