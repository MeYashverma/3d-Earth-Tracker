# 3D Earth Tracker (MVP)

A browser-based **CesiumJS** MVP that visualizes:

- A 3D globe with terrain and OSM buildings
- Live aircraft tracking from OpenSky (with fallback simulation)
- Simulated road traffic and vehicle particles
- Simulated traffic lights at detected intersections
- Public CCTV links embedded in a right-side panel
- Progressive traffic loading in small render batches to avoid UI stalls
- Camera-driven refresh + viewport culling so only nearby/visible traffic entities stay active

## Features

### 1) 3D Earth + Camera
- Full 3D globe rendering with Cesium world terrain
- User camera controls: zoom, pan, tilt, rotate
- OSM 3D buildings (`createOsmBuildingsAsync`)

### 2) Flight Tracker
- Polls OpenSky every ~12 seconds using current camera bounding box
- Adds aircraft markers and labels
- Smooth transition between updates using sampled positions
- Falls back to simulated flight data if API fetch fails

### 3) Traffic Simulation
- Loads nearby roads from OpenStreetMap via Overpass
- Uses synthetic grid roads when Overpass is unavailable
- Assigns congestion levels based on simulation hour + random variation
- Colors roads by congestion (green / yellow / red)

### 4) Vehicle Particles
- Spawns vehicle points on roads (capped for performance)
- Animates movement along road vectors each Cesium clock tick
- Stops vehicles near red traffic lights

### 5) Traffic Lights
- Detects intersection candidates from repeated road nodes
- Places light entities at intersections
- Cycles states: green (30s) → yellow (5s) → red (30s)

### 6) CCTV Integration
- Includes embeddable public CCTV sources:
  - EarthCam
  - 511NY
  - Insecam
- Shows CCTV markers near current city focus
- Sidebar stream selector updates embedded iframe

### 7) Minimal UI
- Top bar: location search + layer toggles
- Right sidebar: selected object details + CCTV stream
- Bottom bar: simulation time slider + zoom indicator

## Project Structure

```text
.
├── app.js        # Cesium scene bootstrapping + simulation logic
├── index.html    # App layout and controls
├── styles.css    # Minimal styling + Cesium widget hiding
└── README.md
```

## Run Locally

Because this is a static app, use any simple local web server:

```bash
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

## Deployment

This project can be deployed as static hosting on:

- GitHub Pages
- Netlify
- Vercel

No backend is required for this MVP.

## Data Sources

- OpenSky Network states API
- OpenStreetMap roads/buildings (Overpass + Cesium OSM buildings)
- Public CCTV websites with embeddable pages

## Notes / Limitations

- Traffic is simulated (not real-time traffic API data).
- Some third-party endpoints may rate-limit or block requests.
- CCTV pages may restrict embedding in some browsers.
- Rendering performance depends on zoom level and device GPU.
- Globe imagery now initializes with explicit provider fallbacks and attempts real Cesium World Terrain first, with ellipsoid fallback if unavailable.
- When Cesium OSM 3D buildings are unavailable, the app falls back to local OSM building extrusion near the camera focus.
- Roads are only loaded when sufficiently zoomed in to avoid very slow country-scale Overpass queries.
- Roads are fetched from multiple Overpass endpoints with timeout failover for faster/more reliable loading.
- Performance tuning in this MVP favors responsiveness by capping roads/vehicles and reducing simulation update frequency.

## Next Steps

- Add structured settings/config for tunable simulation parameters
- Add historical playback for flights and traffic
- Replace simple vehicle points with instanced 3D meshes
- Add optional authenticated backend for richer data pipelines
