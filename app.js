const POLL_INTERVAL_MS = 12000;
const SIM_INTERVAL_MS = 120;
const MAX_AIRCRAFT = 80;
const MAX_ROADS = 140;
const MAX_TRAFFIC_LIGHTS = 60;
const MAX_VEHICLES = 140;
const VEHICLE_ROAD_LIMIT = 34;

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
  lastFlightPoll: 0,
  lastTrafficLoad: 0,
  lastFocus: null,
  loadingTraffic: false
};

const viewer = new Cesium.Viewer('cesiumContainer', {
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  imageryProvider: new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/'
  }),
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

viewer.scene.globe.depthTestAgainstTerrain = false;
viewer.scene.requestRenderMode = true;
viewer.scene.maximumRenderTimeChange = Infinity;
viewer.scene.fog.enabled = false;
viewer.scene.globe.showGroundAtmosphere = false;
viewer.scene.postProcessStages.fxaa.enabled = false;
viewer.resolutionScale = Math.min(1, 1.5 / window.devicePixelRatio);
viewer.scene.skyBox.show = true;
viewer.clock.shouldAnimate = true;

const flightLayer = new Cesium.CustomDataSource('flights');
const trafficLayer = new Cesium.CustomDataSource('traffic');
const cctvLayer = new Cesium.CustomDataSource('cctv');
viewer.dataSources.add(flightLayer);
viewer.dataSources.add(trafficLayer);
viewer.dataSources.add(cctvLayer);

Cesium.createOsmBuildingsAsync().then((tileset) => {
  tileset.maximumScreenSpaceError = 24;
  tileset.skipLevelOfDetail = true;
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

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
    const response = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const [first] = await response.json();
    if (!first) return;

    const lon = Number(first.lon);
    const lat = Number(first.lat);

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 18000),
      duration: 1.2
    });

    await refreshTrafficForFocus(lon, lat, true);
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
  cullEntitiesByView();
});

function getRoadRadiusByHeight(height) {
  if (height < 5000) return 0.025;
  if (height < 15000) return 0.045;
  if (height < 35000) return 0.07;
  return 0.1;
}

function distanceDeg(lon1, lat1, lon2, lat2) {
  const dx = lon1 - lon2;
  const dy = lat1 - lat2;
  return Math.hypot(dx, dy);
}

async function refreshTrafficForFocus(lon, lat, force) {
  const now = Date.now();
  const minInterval = force ? 0 : 9000;
  const movedLittle = state.lastFocus && distanceDeg(lon, lat, state.lastFocus.lon, state.lastFocus.lat) < 0.03;

  if (state.loadingTraffic) return;
  if (!force && now - state.lastTrafficLoad < minInterval && movedLittle) return;

  state.loadingTraffic = true;
  state.lastTrafficLoad = now;
  state.lastFocus = { lon, lat };

  try {
    await loadRoadsNear(lon, lat, getRoadRadiusByHeight(viewer.camera.positionCartographic.height));
  } finally {
    state.loadingTraffic = false;
  }
}

async function pollFlights(force = false) {
  const now = Date.now();
  if (!force && now - state.lastFlightPoll < POLL_INTERVAL_MS) return;
  state.lastFlightPoll = now;

  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return;

  const bbox = {
    west: Cesium.Math.toDegrees(rect.west),
    south: Cesium.Math.toDegrees(rect.south),
    east: Cesium.Math.toDegrees(rect.east),
    north: Cesium.Math.toDegrees(rect.north)
  };

  const openSkyUrl = `https://opensky-network.org/api/states/all?lamin=${bbox.west.toFixed(4)}&lomin=${bbox.south.toFixed(4)}&lamax=${bbox.east.toFixed(4)}&lomax=${bbox.north.toFixed(4)}`;

  try {
    const response = await fetch(openSkyUrl);
    const payload = await response.json();
    updateFlightEntities(payload.states || []);
  } catch (err) {
    console.warn('OpenSky unavailable, using simulated flights.', err);
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
        point: { pixelSize: 5, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
        label: {
          text: icao,
          font: '10px sans-serif',
          pixelOffset: new Cesium.Cartesian2(0, -12),
          fillColor: Cesium.Color.WHITE,
          scale: 0.7,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 220000)
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
  return Array.from({ length: 18 }, (_, i) => ([
    `SIM${i}`,
    lon + (Math.random() - 0.5) * 6,
    lat + (Math.random() - 0.5) * 5,
    8000 + Math.random() * 4500,
    170 + Math.random() * 90
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
  const overpassQuery = `[out:json][timeout:20];(way["highway"](${south},${west},${north},${east});>;);out body;`;

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
  elements.forEach((e) => {
    if (e.type === 'node') nodeMap.set(e.id, [e.lon, e.lat]);
  });

  const ways = elements
    .filter((e) => e.type === 'way' && Array.isArray(e.nodes))
    .map((way) => ({ id: String(way.id), coords: way.nodes.map((id) => nodeMap.get(id)).filter(Boolean) }))
    .filter((road) => road.coords.length >= 2)
    .sort((a, b) => b.coords.length - a.coords.length)
    .slice(0, MAX_ROADS);

  if (ways.length === 0) {
    makeSyntheticRoads(lon, lat);
  } else {
    ways.forEach((road) => {
      state.roads.push({
        id: road.id,
        coords: simplifyRoad(road.coords),
        congestion: randomCongestion()
      });
    });
  }

  detectIntersections();
  buildTrafficEntities();
}

function makeSyntheticRoads(lon, lat) {
  const span = 0.02;
  for (let i = -3; i <= 3; i += 1) {
    state.roads.push({ id: `h-${i}`, coords: [[lon - span, lat + i * 0.004], [lon + span, lat + i * 0.004]], congestion: randomCongestion() });
    state.roads.push({ id: `v-${i}`, coords: [[lon + i * 0.004, lat - span], [lon + i * 0.004, lat + span]], congestion: randomCongestion() });
  }
}

function simplifyRoad(coords) {
  if (coords.length <= 6) return coords;
  const stride = Math.max(1, Math.floor(coords.length / 10));
  const simplified = coords.filter((_, i) => i % stride === 0);
  const tail = coords[coords.length - 1];
  if (simplified[simplified.length - 1] !== tail) simplified.push(tail);
  return simplified;
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
      phaseOffset: index * 4,
      color: 'green',
      entity: null
    });
  });
}

function congestionColor(level) {
  if (level < 0.4) return Cesium.Color.LIME.withAlpha(0.8);
  if (level < 0.7) return Cesium.Color.YELLOW.withAlpha(0.85);
  return Cesium.Color.RED.withAlpha(0.9);
}

function buildTrafficEntities() {
  state.roads.forEach((road) => {
    trafficLayer.entities.add({
      id: `road-${road.id}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(road.coords.flatMap(([x, y]) => [x, y, 2])),
        width: 2.2,
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
      position: Cesium.Cartesian3.fromDegrees(light.lon, light.lat, 6),
      point: { pixelSize: 7, color: Cesium.Color.GREEN },
      properties: { type: 'Traffic Light', status: 'green' }
    });
  });

  const vehicleRoads = state.roads.slice(0, VEHICLE_ROAD_LIMIT);
  vehicleRoads.forEach((road, i) => {
    const count = Math.max(1, Math.round(road.congestion * 4));

    for (let j = 0; j < count; j += 1) {
      if (state.vehicles.length >= MAX_VEHICLES) return;
      const id = `veh-${i}-${j}`;
      const entity = trafficLayer.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(road.coords[0][0], road.coords[0][1], 3),
        point: { pixelSize: 3.5, color: Cesium.Color.ORANGE },
        properties: { type: 'Vehicle', roadId: road.id, speed: '0.0' }
      });

      state.vehicles.push({
        id,
        road,
        segment: 0,
        t: Math.random(),
        speed: 0.001 + Math.random() * 0.0013,
        entity
      });
    }
  });

  cullEntitiesByView();
}

function recolorRoads() {
  state.roads.forEach((road) => {
    road.congestion = randomCongestion();
    const roadEntity = trafficLayer.entities.getById(`road-${road.id}`);
    if (roadEntity) {
      roadEntity.polyline.material = congestionColor(road.congestion);
      roadEntity.properties.congestion = road.congestion.toFixed(2);
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
      position: Cesium.Cartesian3.fromDegrees(lon + (index - 1) * 0.01, lat + (1 - index) * 0.01, 10),
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
    if (light.entity) {
      light.entity.show = isInView(light.lon, light.lat, rect);
    }
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
      const color = status === 'green' ? Cesium.Color.GREEN : status === 'yellow' ? Cesium.Color.YELLOW : Cesium.Color.RED;
      light.entity.point.color = color;
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

    const blocked = state.trafficLights.some((light) => {
      if (light.color !== 'red') return false;
      return Math.abs(light.lon - nextLon) < 0.0009 && Math.abs(light.lat - nextLat) < 0.0009;
    });

    if (!blocked) {
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
    vehicle.entity.properties.speed = vehicle.speed.toFixed(4);
  });

  viewer.scene.requestRender();
}

setInterval(stepSimulation, SIM_INTERVAL_MS);
setInterval(() => {
  pollFlights(false);
}, POLL_INTERVAL_MS);

(async function init() {
  const initialLon = -74.006;
  const initialLat = 40.7128;

  await refreshTrafficForFocus(initialLon, initialLat, true);
  placeCctvMarkers(initialLon, initialLat);

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(initialLon, initialLat, 22000)
  });

  await pollFlights(true);
  cullEntitiesByView();
  ui.zoomLabel.textContent = `Zoom: ${Math.round(viewer.camera.positionCartographic.height).toLocaleString()}m`;
  viewer.scene.requestRender();
})();
