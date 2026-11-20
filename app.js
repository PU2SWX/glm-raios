// ============================================================
// GLM Lightning Map - Versão 2.0 (corrigida)
// ============================================================

const REGIONS = {
  br: { name: "Brasil", bounds: [[-34.0, -74.0], [5.5, -34.0]], center: [-14.2, -51.9], zoom: 4 },
  sudeste: { name: "Sudeste", bounds: [[-25.5, -50.5], [-14.0, -39.0]], center: [-20.5, -44.5], zoom: 6 },
  sul: { name: "Sul", bounds: [[-34.0, -58.0], [-22.0, -48.0]], center: [-28.0, -53.0], zoom: 6 },
  norte: { name: "Norte / Amazônia", bounds: [[-15.0, -74.0], [5.5, -45.0]], center: [-5.0, -60.0], zoom: 5 },
  nordeste: { name: "Nordeste", bounds: [[-18.5, -48.0], [-1.0, -34.5]], center: [-9.5, -40.5], zoom: 5.5 },
  all: { name: "América do Sul", bounds: [[-56.0, -82.0], [13.0, -34.0]], center: [-15.0, -58.0], zoom: 3.5 }
};

const TILES = {
  osm: { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> | GLM/GOES-19', name: "Mapa" },
  dark: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    labelsUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 16, attr: 'Esri Dark | GLM/GOES-19', name: "Escuro"
  },
  sat: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attr: 'Esri World Imagery | GLM/GOES-19', name: "Satélite" }
};

let map, flashLayer, heatLayer = null, baseLayer, labelsLayer = null;
let currentRegion = "br", currentStyle = "osm";
let showHeatmap = false, showRadar = false, showWeather = false, showNearby = false, showChart = false;
let autoRefreshInterval = null;
let allFlashes = [];
let satLayer = null, radarLayer = null;
let showSat = false;
let userLat = null, userLon = null;
let cellLayerGroup = null;
const MAX_POINTS = 30000;  // acima disso, usa mapa de calor em vez de um marcador por flash
let autoHeat = false;

const DEMO = new URLSearchParams(location.search).has("demo");
let dataInfo = { demo: DEMO, loaded: true, satellite: "", latestMs: null };

// ------------------------------------------------------------
function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: true })
    .setView(REGIONS.br.center, REGIONS.br.zoom);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  setBaseLayer("osm");
  map.createPane("sat").style.zIndex = 250;
  flashLayer = L.layerGroup().addTo(map);
  cellLayerGroup = L.layerGroup().addTo(map);

  // Filtros
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentRegion = btn.dataset.region;
      const region = REGIONS[currentRegion];
      map.flyTo(region.center, region.zoom, { duration: 0.9 });
      renderCurrent();
    });
  });

  document.getElementById("btn-refresh").addEventListener("click", () => loadFlashes(true));
  document.getElementById("btn-locate").addEventListener("click", locateUser);
  document.getElementById("btn-heatmap").addEventListener("click", toggleHeatmap);
  document.getElementById("btn-sat").addEventListener("click", toggleSat);
  document.getElementById("btn-radar").addEventListener("click", toggleRadar);
  document.getElementById("btn-weather").addEventListener("click", toggleWeather);
  document.getElementById("btn-nearby").addEventListener("click", toggleNearby);
  document.getElementById("btn-chart").addEventListener("click", toggleChart);
  document.getElementById("btn-style").addEventListener("click", cycleStyle);

  loadFlashes();
  autoRefreshInterval = setInterval(() => loadFlashes(false), 90_000);
  
  initChart();
}

// ------------------------------------------------------------
function setBaseLayer(style) {
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelsLayer) { map.removeLayer(labelsLayer); labelsLayer = null; }
  currentStyle = style;
  const t = TILES[style];
  const opts = { attribution: t.attr, maxZoom: t.maxZoom || 19 };
  if (style === "osm") opts.subdomains = "abc";
  baseLayer = L.tileLayer(t.url, opts).addTo(map);
  if (t.labelsUrl) labelsLayer = L.tileLayer(t.labelsUrl, { maxZoom: t.maxZoom || 19 }).addTo(map);
}

function cycleStyle() {
  const order = ["osm", "dark", "sat"];
  const idx = order.indexOf(currentStyle);
  setBaseLayer(order[(idx + 1) % order.length]);
  document.getElementById("btn-style").classList.toggle("active", currentStyle !== "osm");
}

// ------------------------------------------------------------
function toggleHeatmap() {
  showHeatmap = !showHeatmap;
  document.getElementById("btn-heatmap").classList.toggle("active", showHeatmap);
  renderCurrent();
}

function toggleRadar() {
  showRadar = !showRadar;
  document.getElementById("btn-radar").classList.toggle("active", showRadar);
  if (showRadar) addRadar();
  else if (radarLayer) { map.removeLayer(radarLayer); radarLayer = null; }
}

function toggleWeather() {
  showWeather = !showWeather;
  document.getElementById("weather-panel").classList.toggle("show", showWeather);
  document.getElementById("btn-weather").classList.toggle("active", showWeather);
  if (showWeather && userLat && userLon) loadWeather(userLat, userLon);
}

function toggleNearby() {
  showNearby = !showNearby;
  document.getElementById("nearby-panel").classList.toggle("show", showNearby);
  document.getElementById("btn-nearby").classList.toggle("active", showNearby);
  if (showNearby && userLat && userLon) updateNearby();
}

function toggleChart() {
  showChart = !showChart;
  document.getElementById("chart-panel").classList.toggle("show", showChart);
  document.getElementById("btn-chart").classList.toggle("active", showChart);
  if (showChart) updateChart();
}

// ------------------------------------------------------------
function locateUser() {
  if (!("geolocation" in navigator)) {
    alert("Este navegador não suporta geolocalização.");
    return;
  }

  showLoading(true);
  navigator.geolocation.getCurrentPosition(
    pos => {
      userLat = pos.coords.latitude;
      userLon = pos.coords.longitude;
      map.flyTo([userLat, userLon], 9, { duration: 1.1 });

      L.circleMarker([userLat, userLon], {
        radius: 9, color: "#38bdf8", fillColor: "#0ea5e9", fillOpacity: 0.85, weight: 2
      }).addTo(map).bindPopup("<b>Você está aqui</b>").openPopup();

      showLoading(false);
      if (showWeather) loadWeather(userLat, userLon);
      if (showNearby) updateNearby();
    },
    err => {
      showLoading(false);
      const msg = {
        1: "Permissão de localização negada. Habilite em 'Site settings'.",
        2: "Localização indisponível (sem GPS/Wi-Fi).",
        3: "Tempo esgotado ao obter localização."
      }[err.code] || "Erro desconhecido";
      console.warn("Geolocation error:", err);
      alert(msg);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

// ------------------------------------------------------------
// Radar RainViewer (com retry de frames válidos)
async function addRadar() {
  try {
    const resp = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    const data = await resp.json();
    if (radarLayer) map.removeLayer(radarLayer);
    
    const past = data.radar.past;
    if (!past || past.length === 0) {
      alert("Radar: nenhum frame disponível agora.");
      showRadar = false;
      document.getElementById("btn-radar").classList.remove("active");
      return;
    }
    
    // Testa os últimos 5 frames até achar um que responda 200
    let frame = null;
    for (let i = past.length - 1; i >= Math.max(0, past.length - 5); i--) {
      const f = past[i];
      const testUrl = `https://tilecache.rainviewer.com${f.path}/256/4/5/8/2/1_1.png`;
      try {
        const test = await fetch(testUrl, { method: 'HEAD' });
        if (test.ok) { frame = f; break; }
      } catch(e) { continue; }
    }
    
    if (!frame) {
      alert("Radar indisponível no momento (frames expirados). Tente novamente em alguns minutos.");
      showRadar = false;
      document.getElementById("btn-radar").classList.remove("active");
      return;
    }
    
    radarLayer = L.tileLayer(`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0.45, attribution: "RainViewer Radar", pane: "sat", maxZoom: 10, errorTileUrl: ""
    }).addTo(map);
    
  } catch (e) {
    console.error("Radar error:", e);
    alert("Erro ao carregar radar.");
    showRadar = false;
    document.getElementById("btn-radar").classList.remove("active");
  }
}

// ------------------------------------------------------------
// Clima Open-Meteo
async function loadWeather(lat, lon) {
  const panel = document.getElementById("weather-panel");
  if (panel) panel.classList.add("show");

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  set("w-temp", "…"); set("w-humidity", "…"); set("w-wind", "…");
  set("w-rain", "…"); set("w-pressure", "…"); set("w-cape", "N/A");

  try {
    // URL simplificada — sem 'daily=cape' que causa 400
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,pressure_msl,wind_direction_10m&timezone=America%2FSao_Paulo`;

    const resp = await fetch(url);
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${txt}`);
    }
    const data = await resp.json();
    console.log("Open-Meteo OK:", data);

    const c = data.current || {};
    set("w-temp",     c.temperature_2m     != null ? `${c.temperature_2m}°C`       : "N/A");
    set("w-humidity", c.relative_humidity_2m != null ? `${c.relative_humidity_2m}%` : "N/A");
    set("w-wind",     c.wind_speed_10m     != null ? `${c.wind_speed_10m} km/h`    : "N/A");
    set("w-rain",     c.precipitation      != null ? `${c.precipitation} mm`       : "N/A");
    set("w-pressure", c.pressure_msl       != null ? `${c.pressure_msl} hPa`       : "N/A");
  } catch (e) {
    console.error("Weather error:", e);
    set("w-temp", "erro");
  }
}

function degToDir(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ------------------------------------------------------------
// Clustering DBSCAN
function clusterFlashes(flashes, epsKm = 50, minPts = 3) {
  if (flashes.length < minPts) return [];
  const clusters = [];
  const visited = new Set();
  const clustered = new Set();
  const epsDeg = epsKm / 111.0;
  const epsDeg2 = epsDeg * epsDeg;

  // Índice em grade: cada flash só é comparado com os das células vizinhas
  const cellOf = v => Math.floor(v / epsDeg);
  const gridKey = (cx, cy) => (cx + 5000) * 10000 + (cy + 5000);
  const grid = new Map();
  flashes.forEach((f, idx) => {
    const k = gridKey(cellOf(f.lat), cellOf(f.lon));
    const list = grid.get(k);
    if (list) list.push(idx); else grid.set(k, [idx]);
  });
  const neighborsOf = (i) => {
    const out = [];
    const cx = cellOf(flashes[i].lat), cy = cellOf(flashes[i].lon);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const list = grid.get(gridKey(cx + a, cy + b));
        if (!list) continue;
        for (const j of list) {
          const dx = flashes[i].lat - flashes[j].lat;
          const dy = flashes[i].lon - flashes[j].lon;
          if (i === j || dx*dx + dy*dy < epsDeg2) out.push(j);
        }
      }
    }
    return out.sort((x, y) => x - y);
  };
  
  for (let i = 0; i < flashes.length; i++) {
    if (visited.has(i)) continue;
    visited.add(i);
    
    const neighbors = neighborsOf(i);
    
    if (neighbors.length < minPts) continue;
    const inNeighbors = new Set(neighbors);
    
    const cluster = [i];
    clustered.add(i);
    
    let idx = 0;
    while (idx < neighbors.length) {
      const p = neighbors[idx];
      if (!visited.has(p)) {
        visited.add(p);
        const pNeighbors = neighborsOf(p);
        if (pNeighbors.length >= minPts) {
          pNeighbors.forEach(pn => { if (!inNeighbors.has(pn)) { inNeighbors.add(pn); neighbors.push(pn); } });
        }
      }
      if (!clustered.has(p)) {
        clustered.add(p);
        cluster.push(p);
      }
      idx++;
    }
    
    clusters.push(cluster.map(ci => flashes[ci]));
  }
  
  return clusters;
}

// ------------------------------------------------------------
// Análise de célula
function analyzeCell(flashes) {
  const now = Date.now();
  const total = flashes.length;
  
  let last2 = 0, last5 = 0, last15 = 0, last30 = 0;
  flashes.forEach(f => {
    const ageMin = (now - f.time) / 60000;
    if (ageMin <= 2) last2++;
    if (ageMin <= 5) last5++;
    if (ageMin <= 15) last15++;
    if (ageMin <= 30) last30++;
  });
  
  const avgLat = flashes.reduce((s, f) => s + f.lat, 0) / total;
  const avgLon = flashes.reduce((s, f) => s + f.lon, 0) / total;
  
  const rate5min = last5;
  
  const prevWindow = flashes.filter(f => {
    const age = (now - f.time) / 60000;
    return age > 2 && age <= 5;
  }).length;
  
  let trend = "stable";
  if (last2 > prevWindow * 1.3) trend = "rising";
  else if (last2 < prevWindow * 0.7) trend = "falling";
  
  let severity = "low";
  if (rate5min >= 15 || trend === "rising") severity = "high";
  else if (rate5min >= 5) severity = "med";
  
  return { total, last2, last5, last15, last30, rate5min, trend, severity, centroid: [avgLat, avgLon] };
}

// ------------------------------------------------------------
// Render células no mapa
function renderCells(clusters) {
  cellLayerGroup.clearLayers();
  
  clusters.forEach((cluster, idx) => {
    if (cluster.length < 3) return;
    const info = analyzeCell(cluster);
    const [lat, lon] = info.centroid;
    
    const color = info.severity === "high" ? "#ef4444" : info.severity === "med" ? "#f59e0b" : "#22c55e";
    const radius = Math.min(30 + info.rate5min * 2, 80);
    
    const circle = L.circleMarker([lat, lon], {
      radius: radius / 4,
      color: color,
      fillColor: color,
      fillOpacity: 0.15,
      weight: 2,
      opacity: 0.7
    });
    
    const trendIcon = info.trend === "rising" ? "📈" : info.trend === "falling" ? "📉" : "➡️";
    const sevLabel = info.severity === "high" ? "ALTO" : info.severity === "med" ? "MÉDIO" : "BAIXO";
    
    circle.bindPopup(`
      <b>⛈️ Célula #${idx + 1}</b><br>
      Centro: ${lat.toFixed(2)}°, ${lon.toFixed(2)}°<br>
      Flashes (5min): <b>${info.last5}</b><br>
      Flash rate: <b>${info.rate5min}/5min</b><br>
      Tendência: ${trendIcon} ${info.trend === "rising" ? "Crescendo" : info.trend === "falling" ? "Dissipando" : "Estável"}<br>
      Severidade: <span style="color:${color};font-weight:700">${sevLabel}</span><br>
      Total (30min): ${info.total}
    `);
    
    cellLayerGroup.addLayer(circle);
    
    const label = L.divIcon({
      className: "cell-marker",
      html: `<div class="cell-marker-inner">
        <div class="cell-pulse" style="border-color:${color}"></div>
        <div class="cell-label" style="color:${color}">#${idx+1} ${info.last5}⚡</div>
      </div>`,
      iconSize: [80, 80],
      iconAnchor: [40, 40]
    });
    cellLayerGroup.addLayer(L.marker([lat, lon], { icon: label }));
  });
  
  document.getElementById("cell-count").textContent = clusters.filter(c => c.length >= 3).length;
}

// ------------------------------------------------------------
// Nearby cells
function updateNearby() {
  if (!userLat || !userLon) {
    document.getElementById("nearby-list").innerHTML = '<div style="color:var(--muted)">Use 📍 primeiro para marcar sua posição</div>';
    return;
  }
  const region = REGIONS[currentRegion];
  const filtered = allFlashes.filter(f =>
    f.lat >= region.bounds[0][0] && f.lat <= region.bounds[1][0] &&
    f.lon >= region.bounds[0][1] && f.lon <= region.bounds[1][1]
  );
  const clusters = clusterFlashes(filtered, 50, 3);
  const list = document.getElementById("nearby-list");
  list.innerHTML = "";
  
  if (clusters.length === 0) {
    list.innerHTML = '<div style="color:var(--muted)">Nenhuma célula detectada na região.</div>';
    return;
  }
  
  const nearby = clusters.map((c, i) => {
    const info = analyzeCell(c);
    const dist = haversine(userLat, userLon, info.centroid[0], info.centroid[1]);
    const bearing = calcBearing(userLat, userLon, info.centroid[0], info.centroid[1]);
    return { ...info, dist, bearing, idx: i };
  }).sort((a, b) => a.dist - b.dist).slice(0, 3);
  
  nearby.forEach(cell => {
    const sevClass = cell.severity === "high" ? "severity-high" : cell.severity === "med" ? "severity-med" : "severity-low";
    const trendIcon = cell.trend === "rising" ? "📈" : cell.trend === "falling" ? "📉" : "➡️";
    const div = document.createElement("div");
    div.className = "nearby-cell";
    div.innerHTML = `
      <div class="n-name">
        <span>Célula #${cell.idx + 1}</span>
        <span class="severity-badge ${sevClass}">${cell.severity === "high" ? "ALTO" : cell.severity === "med" ? "MÉDIO" : "BAIXO"}</span>
      </div>
      <div class="n-detail">
        ${cell.dist.toFixed(0)} km • ${cell.bearing} • ${cell.last5} flashes/5min ${trendIcon}
      </div>
    `;
    list.appendChild(div);
  });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calcBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const lat1r = lat1 * Math.PI / 180, lat2r = lat2 * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2r);
  const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
  const brng = Math.atan2(y, x) * 180 / Math.PI;
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(((brng + 360) % 360) / 22.5) % 16];
}

// ------------------------------------------------------------
// Gráfico de flash rate
let chartCtx = null;
function initChart() {
  const canvas = document.getElementById("rate-chart");
  if (canvas) chartCtx = canvas.getContext("2d");
}

function updateChart() {
  if (!chartCtx) return;
  const region = REGIONS[currentRegion];
  const filtered = allFlashes.filter(f =>
    f.lat >= region.bounds[0][0] && f.lat <= region.bounds[1][0] &&
    f.lon >= region.bounds[0][1] && f.lon <= region.bounds[1][1]
  );
  
  // Bucket por minuto (30 buckets)
  const now = Date.now();
  const buckets = new Array(30).fill(0);
  filtered.forEach(f => {
    const ageMin = (now - f.time) / 60000;
    const idx = Math.floor(ageMin);
    if (idx >= 0 && idx < 30) buckets[29 - idx]++;
  });
  
  const W = 220, H = 80;
  chartCtx.clearRect(0, 0, W, H);
  
  const max = Math.max(...buckets, 1);
  const barW = W / 30 - 1;
  
  // Linha de tendência
  chartCtx.strokeStyle = "rgba(56, 189, 248, 0.5)";
  chartCtx.lineWidth = 1.5;
  chartCtx.beginPath();
  buckets.forEach((v, i) => {
    const x = i * (barW + 1) + barW/2;
    const y = H - (v / max) * (H - 10) - 5;
    if (i === 0) chartCtx.moveTo(x, y); else chartCtx.lineTo(x, y);
  });
  chartCtx.stroke();
  
  // Barras
  buckets.forEach((v, i) => {
    const x = i * (barW + 1);
    const h = (v / max) * (H - 10);
    const hue = 200 + (v / max) * 130;
    chartCtx.fillStyle = `hsla(${hue}, 90%, 60%, 0.7)`;
    chartCtx.fillRect(x, H - h - 5, barW, h);
  });
  
  // Eixo
  chartCtx.strokeStyle = "rgba(148,163,184,0.3)";
  chartCtx.lineWidth = 0.5;
  chartCtx.beginPath();
  chartCtx.moveTo(0, H-5);
  chartCtx.lineTo(W, H-5);
  chartCtx.stroke();
}

// ------------------------------------------------------------
async function loadFlashes(force = false) {
  showLoading(true);
  try {
    if (DEMO) {
      const novos = await fetchDemoFlashes();
      const limite = Date.now() - 30 * 60 * 1000;
      allFlashes = allFlashes.concat(novos).filter(f => f.time >= limite);
    } else {
      const resp = await fetch("api/flashes?minutes=30", { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      allFlashes = data.flashes.map(([lat, lon, time]) => ({ lat, lon, time }));
      dataInfo = { demo: false, loaded: data.loaded, satellite: data.satellite, latestMs: data.latest_ms, error: data.error };
      if (!data.loaded) setTimeout(() => loadFlashes(false), 5000);
    }
    renderCurrent();
    updateSat();
    if (showChart) updateChart();
    if (showNearby && userLat && userLon) updateNearby();
  } catch (err) {
    console.error(err);
    document.getElementById("status-line").textContent = "Servidor GLM indisponível. Inicie com: python3 glm_server.py";
  } finally {
    showLoading(false);
  }
}

// ------------------------------------------------------------
function renderCurrent() {
  const region = REGIONS[currentRegion];
  const filtered = allFlashes.filter(f =>
    f.lat >= region.bounds[0][0] && f.lat <= region.bounds[1][0] &&
    f.lon >= region.bounds[0][1] && f.lon <= region.bounds[1][1]
  );

  flashLayer.clearLayers();
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

  autoHeat = !showHeatmap && filtered.length > MAX_POINTS;
  if ((showHeatmap || autoHeat) && typeof L.heatLayer === "function") {
    const heatData = filtered.map(f => {
      const ageMin = (Date.now() - f.time) / 60000;
      const intensity = ageMin <= 5 ? 1.0 : ageMin <= 15 ? 0.6 : 0.3;
      return [f.lat, f.lon, intensity];
    });
    heatLayer = L.heatLayer(heatData, {
      radius: 22, blur: 18, maxZoom: 12,
      gradient: { 0.2: "#7dd3fc", 0.45: "#ffd000", 0.75: "#ff6a00", 1.0: "#ff1212" }
    }).addTo(map);
  } else {
    renderPoints(filtered);
  }

  const clusters = clusterFlashes(filtered, 50, 3);
  renderCells(clusters);

  updateStats(filtered.length);
  if (showChart) updateChart();
}

// ------------------------------------------------------------
function renderPoints(flashes) {
  const now = Date.now();
  flashes.forEach(f => {
    const ageMin = (now - f.time) / 60000;
    let color, radius, opacity, isRecent = false;
    if (ageMin <= 2) { color = "#ff1212"; radius = 8; opacity = 1; isRecent = true; }
    else if (ageMin <= 5) { color = "#ff6a00"; radius = 7; opacity = 1; isRecent = true; }
    else if (ageMin <= 15) { color = "#ffd000"; radius = 5.5; opacity = 0.9; }
    else { color = "#7dd3fc"; radius = 4.5; opacity = 0.6; }

    const marker = L.circleMarker([f.lat, f.lon], {
      radius, color: "#ffffff", fillColor: color, fillOpacity: opacity, weight: 1, opacity: 0.9,
      className: isRecent ? "flash-recent" : ""
    });

    marker.bindPopup(() => {   // montado só quando o usuário clica
      const age = (Date.now() - f.time) / 60000;
      const ageText = age < 1 ? "agora há pouco" : age < 60 ? `${Math.round(age)} min atrás` : `${Math.round(age / 60)} h atrás`;
      return `<b>⚡ Flash GLM</b><br>${f.lat.toFixed(3)}°, ${f.lon.toFixed(3)}°<br><span style="color:#94a3b8">${ageText}</span>`;
    });
    flashLayer.addLayer(marker);
  });
}

// ------------------------------------------------------------
function updateStats(count) {
  document.getElementById("flash-count").textContent = count;
  const now = new Date();
  const timeStr = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let origem;
  if (dataInfo.demo) origem = '<span class="live" style="color:#fbbf24">Dados de demonstração</span>';
  else if (!dataInfo.loaded) origem = "Baixando dados do GLM…";
  else {
    const idade = dataInfo.latestMs ? ` (satélite há ${Math.max(0, Math.round((Date.now() - dataInfo.latestMs) / 60000))} min)` : "";
    origem = `<span class="live">${dataInfo.satellite} • dados reais</span>${idade}`;
  }
  document.getElementById("status-line").innerHTML = `Última atualização: <b>${timeStr}</b> • ${origem}${autoHeat ? " • mapa de calor (muitos raios)" : ""}`;
}

function showLoading(show) { document.getElementById("loading").classList.toggle("show", show); }

// ------------------------------------------------------------
// Satélite
async function updateSat() {
  if (!showSat) return;
  try {
    const resp = await fetch("api/sat.json", { cache: "no-store" });
    const m = await resp.json();
    if (!m.available) { setTimeout(updateSat, 8000); return; }
    if (satLayer && satLayer._glmTime === m.time_ms) return;
    if (satLayer) map.removeLayer(satLayer);
    satLayer = L.imageOverlay("api/sat.png?t=" + m.time_ms, m.bounds, {
      pane: "sat", opacity: 0.9, interactive: false, attribution: "Nuvens: NOAA GOES-19 (banda 13)"
    }).addTo(map);
    satLayer._glmTime = m.time_ms;
  } catch (err) { console.error(err); }
}

function toggleSat() {
  showSat = !showSat;
  document.getElementById("btn-sat").classList.toggle("active", showSat);
  if (!showSat && satLayer) { map.removeLayer(satLayer); satLayer = null; }
  updateSat();
}

// ------------------------------------------------------------
// Demo
const DEMO_CELLS = [
  { lat: -23.55, lon: -46.63, count: 42 }, { lat: -22.90, lon: -43.20, count: 28 },
  { lat: -19.92, lon: -43.94, count: 22 }, { lat: -25.43, lon: -49.27, count: 31 },
  { lat: -30.03, lon: -51.23, count: 18 }, { lat: -15.78, lon: -47.93, count: 15 },
  { lat: -3.10, lon: -60.02, count: 48 }, { lat: -8.05, lon: -34.88, count: 14 },
  { lat: -12.97, lon: -38.50, count: 19 }, { lat: -27.60, lon: -48.55, count: 24 },
  { lat: -1.45, lon: -48.50, count: 11 }, { lat: -16.68, lon: -49.25, count: 13 },
  { lat: -20.47, lon: -54.62, count: 16 }, { lat: -9.97, lon: -67.81, count: 20 },
  { lat: -5.09, lon: -42.80, count: 9 }, { lat: -3.73, lon: -38.52, count: 12 },
];

let lastDemoTime = null;
function fetchDemoFlashes() {
  return new Promise(resolve => {
    setTimeout(() => {
      const now = Date.now();
      const from = lastDemoTime ?? now - 30 * 60 * 1000;
      const elapsedMin = (now - from) / 60000;
      lastDemoTime = now;
      const flashes = [];
      DEMO_CELLS.forEach(cell => {
        const n = Math.floor((cell.count / 30) * elapsedMin + Math.random());
        for (let i = 0; i < n; i++) {
          flashes.push({
            lat: cell.lat + (Math.random() - 0.5) * 2.2,
            lon: cell.lon + (Math.random() - 0.5) * 2.2,
            time: from + Math.random() * (now - from)
          });
        }
      });
      resolve(flashes);
    }, 500);
  });
}

// ------------------------------------------------------------
document.addEventListener("DOMContentLoaded", initMap);
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
}