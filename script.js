const STORAGE_KEY        = "giloa-v7";
const FOG_ENABLED_KEY    = "giloa-fog-enabled";
const GPX_SAVES_KEY      = "giloa-gpx-saves";
const FOG_ALPHA          = 0.8;
const FOG_RADIUS_M       = 18;
const MIN_MOVE_M         = 15;
const MAX_ACCURACY_M     = 50;
const STAY_ACCURACY_FACTOR = 0.6;
const MAX_STAY_RADIUS_M  = 36;
const SAVE_DELAY_MS      = 800;
const MERGE_DISTANCE_M   = 6;
const MERGE_TIME_GAP_MS  = 2 * 60 * 1000;
const MAX_PATH_POINTS    = 5000;

const FULL_VISIBILITY_HOURS = 0;
const MIN_VISIBILITY_HOURS  = 24;
const MIN_PATH_VISIBILITY   = 0.4;

const THREE_DAYS_IN_DAYS   = 3;
const ONE_MONTH_DAYS       = 30;
const THREE_MONTHS_DAYS    = 90;
const SIX_MONTHS_DAYS      = 180;
const ONE_YEAR_DAYS        = 365;
const SEDIMENT_LAYER_COLOR = "rgba(126, 112, 96, 0.24)";

const CLUSTER_ZOOM_THRESHOLD = 14;
const MARKER_MAX_SIZE = 40;
const MARKER_MIN_SIZE = 20;
const MARKER_MAX_ZOOM = 17;
const MARKER_MIN_ZOOM = 14;

const LEVEL_TABLE = [
{ level: 1, title: "길 없는 자",          distKm: 0,   memories: 0,  photos: 0  },
{ level: 2, title: "흔적을 남긴 자",      distKm: 1,   memories: 0,  photos: 0  },
{ level: 3, title: "탐험자",              distKm: 10,  memories: 1,  photos: 0  },
{ level: 4, title: "길을 만든 자",        distKm: 30,  memories: 3,  photos: 0  },
{ level: 5, title: "기억을 수집하는 자",  distKm: 50,  memories: 5,  photos: 3  },
{ level: 6, title: "개척자",              distKm: 100, memories: 10, photos: 7  },
{ level: 7, title: "세계의 기록자",       distKm: 200, memories: 20, photos: 15 },
];

let isRecording     = false;
let photos          = [];
let isFogEnabled    = true;
let isHudExpanded   = false;
let currentPos      = null;
let pathCoordinates = [];
let memories        = [];
let totalDistance   = 0;
let playerMarker    = null;
let watchId         = null;
let saveTimer       = null;
let rafId           = null;
const memoryMarkers = new Map();

let activeGpxId     = null;
let activeGpxLayers = [];
let dialHours       = 12;

const recBtn       = document.getElementById("rec-btn");
const recStatusBox = document.getElementById("rec-status-box");

const map = L.map("map", { zoomControl: false, attributionControl: false })
    .setView([37.5665, 126.978], 16);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);

map.createPane("memoryPane");
map.getPane("memoryPane").style.zIndex = 500;

const photoClusterGroup = L.markerClusterGroup({
    maxClusterRadius: 60,
    disableClusteringAtZoom: CLUSTER_ZOOM_THRESHOLD + 1,
    iconCreateFunction: function(cluster) {
        const count = cluster.getChildCount();
        return L.divIcon({
            className: "photo-cluster-icon",
            html: `<div class="photo-cluster-inner">${count}</div>`,
            iconSize: [36, 36]
        });
    }
});
map.addLayer(photoClusterGroup);

const fogCanvas  = document.getElementById("fog-canvas");
const ageCanvas  = document.getElementById("age-canvas");
const stayCanvas = document.getElementById("stay-canvas");
const fogCtx     = fogCanvas.getContext("2d");
const ageCtx     = ageCanvas.getContext("2d");
const stayCtx    = stayCanvas.getContext("2d");

function resizeCanvas() {
    const w = window.innerWidth  + 2;
    const h = window.innerHeight + 2;
    [fogCanvas, ageCanvas, stayCanvas].forEach(c => {
        c.width        = w;
        c.height       = h;
        c.style.width  = w + "px";
        c.style.height = h + "px";
        c.style.top    = "-1px";
        c.style.left   = "-1px";
    });
    scheduleRender();
}

window.addEventListener("resize", resizeCanvas);
map.on("move zoom", scheduleRender);
map.on("zoomend", updatePhotoMarkerSizes);

function scheduleRender() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => { rafId = null; render(); });
}

function render() { renderFog(); renderAgeTint(); renderStayTint(); }

function calcMpp() {
    const center = map.getCenter();
    const pt  = map.latLngToContainerPoint(center);
    const ll2 = map.containerPointToLatLng(L.point(pt.x + 10, pt.y));
    return center.distanceTo(ll2) || 1;
}

function metersToPixels(meters, mpp) { return (meters / mpp) * 10; }

function renderFog() {
    const w = fogCanvas.width, h = fogCanvas.height;
    fogCtx.clearRect(0, 0, w, h);
    if (!isFogEnabled) return;
    fogCtx.fillStyle = `rgba(8, 10, 18, ${FOG_ALPHA})`;
    fogCtx.fillRect(0, 0, w, h);
    if (pathCoordinates.length === 0) return;

    const now    = Date.now();
    const mpp    = calcMpp();
    const radius = metersToPixels(FOG_RADIUS_M, mpp);

    const BUCKET = 0.05;
    const buckets = new Map();

    const addToBucket = (alpha, drawFn) => {
        const key = Math.round(alpha / BUCKET) * BUCKET;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(drawFn);
    };

    if (pathCoordinates.length === 1) {
        const point    = pathCoordinates[0];
        const ageHours = (now - point.startTime) / 3600000;
        const alpha    = getPathVisibility(ageHours);
        const stayMin  = (point.endTime - point.startTime) / 60000;
        const stayR    = metersToPixels(getStayRadiusMeters(stayMin), mpp);
        const pos      = map.latLngToContainerPoint([point.lat, point.lng]);
        addToBucket(alpha, ctx => {
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, stayR, 0, Math.PI * 2);
            ctx.fill();
        });
    } else {
        for (let i = 1; i < pathCoordinates.length; i++) {
            const point    = pathCoordinates[i];
            const ageHours = (now - point.startTime) / 3600000;
            const alpha    = getPathVisibility(ageHours);
            const stayMin  = (point.endTime - point.startTime) / 60000;
            const stayR    = metersToPixels(getStayRadiusMeters(stayMin), mpp);
            const prev     = map.latLngToContainerPoint([pathCoordinates[i-1].lat, pathCoordinates[i-1].lng]);
            const pos      = map.latLngToContainerPoint([point.lat, point.lng]);

            if (stayMin >= 10) {
                addToBucket(alpha, ctx => {
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, stayR, 0, Math.PI * 2);
                    ctx.fill();
                });
            }
            addToBucket(alpha, ctx => {
                ctx.beginPath();
                ctx.moveTo(prev.x, prev.y);
                ctx.lineTo(pos.x, pos.y);
                ctx.stroke();
            });
        }
    }

    const offscreen = document.createElement("canvas");
    offscreen.width  = w;
    offscreen.height = h;
    const offCtx = offscreen.getContext("2d");

    for (const [alpha, drawFns] of buckets) {
        offCtx.clearRect(0, 0, w, h);
        offCtx.fillStyle   = `rgba(0,0,0,${alpha})`;
        offCtx.strokeStyle = `rgba(0,0,0,${alpha})`;
        offCtx.lineWidth   = radius * 2;
        offCtx.lineCap     = "round";
        offCtx.lineJoin    = "round";
        drawFns.forEach(fn => fn(offCtx));

        fogCtx.save();
        fogCtx.globalCompositeOperation = "destination-out";
        fogCtx.drawImage(offscreen, 0, 0);
        fogCtx.restore();
    }
}

function getPathVisibility(ageHours) {
    if (ageHours <= FULL_VISIBILITY_HOURS) return 1;
    if (ageHours >= MIN_VISIBILITY_HOURS)  return MIN_PATH_VISIBILITY;
    return 1 - (1 - MIN_PATH_VISIBILITY) * (ageHours / MIN_VISIBILITY_HOURS);
}

function renderAgeTint() {
    const w = ageCanvas.width, h = ageCanvas.height;
    ageCtx.clearRect(0, 0, w, h);
    if (pathCoordinates.length === 0) return;
    const now    = Date.now();
    const mpp    = calcMpp();
    const radius = metersToPixels(FOG_RADIUS_M, mpp);
    pathCoordinates.forEach((point, i) => {
        const ageDays = (now - point.startTime) / 86400000;
        const color   = getAgeColor(ageDays);
        if (!color) return;
        const pos = map.latLngToContainerPoint([point.lat, point.lng]);
        ageCtx.fillStyle = color; ageCtx.strokeStyle = color;
        ageCtx.beginPath(); ageCtx.arc(pos.x, pos.y, radius, 0, Math.PI * 2); ageCtx.fill();
        if (i > 0) {
            const prev = map.latLngToContainerPoint([pathCoordinates[i-1].lat, pathCoordinates[i-1].lng]);
            ageCtx.beginPath();
            ageCtx.lineWidth = radius * 1.15; ageCtx.lineCap = "round"; ageCtx.lineJoin = "round";
            ageCtx.moveTo(prev.x, prev.y); ageCtx.lineTo(pos.x, pos.y); ageCtx.stroke();
        }
    });
}

function getAgeColor(ageDays) {
    if (ageDays < THREE_DAYS_IN_DAYS)  return null;
    if (ageDays < ONE_MONTH_DAYS)      return "rgba(173, 255, 120, 0.16)";
    if (ageDays < THREE_MONTHS_DAYS)   return "rgba(60,  170,  80, 0.18)";
    if (ageDays < SIX_MONTHS_DAYS)     return "rgba(214, 176,  55, 0.18)";
    if (ageDays < ONE_YEAR_DAYS)       return "rgba(130,  92,  55, 0.20)";
    return SEDIMENT_LAYER_COLOR;
}

function renderStayTint() {
    const w = stayCanvas.width, h = stayCanvas.height;
    stayCtx.clearRect(0, 0, w, h);
    if (pathCoordinates.length === 0) return;
    const mpp = calcMpp();
    pathCoordinates.forEach(point => {
        const stayMin = (point.endTime - point.startTime) / 60000;
        if (stayMin < 10) return;
        const pos    = map.latLngToContainerPoint([point.lat, point.lng]);
        const radius = metersToPixels(getStayRadiusMeters(stayMin), mpp);
        const grad = stayCtx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, radius);
        grad.addColorStop(0,   "rgba(255, 220, 100, 0.18)");
        grad.addColorStop(0.6, "rgba(255, 220, 100, 0.08)");
        grad.addColorStop(1,   "rgba(255, 220, 100, 0)");
        stayCtx.fillStyle = grad;
        stayCtx.beginPath(); stayCtx.arc(pos.x, pos.y, radius, 0, Math.PI * 2); stayCtx.fill();
    });
}

function getStayRadiusMeters(stayMin) {
    if (stayMin < 10)   return FOG_RADIUS_M;
    if (stayMin >= 180) return FOG_RADIUS_M * 2.0;
    return FOG_RADIUS_M * (1.0 + (stayMin - 10) / (180 - 10));
}

function getPhotoMarkerSize() {
    const zoom = map.getZoom();
    if (zoom >= MARKER_MAX_ZOOM) return MARKER_MAX_SIZE;
    if (zoom <= MARKER_MIN_ZOOM) return MARKER_MIN_SIZE;
    const ratio = (zoom - MARKER_MIN_ZOOM) / (MARKER_MAX_ZOOM - MARKER_MIN_ZOOM);
    return Math.round(MARKER_MIN_SIZE + ratio * (MARKER_MAX_SIZE - MARKER_MIN_SIZE));
}

function updatePhotoMarkerSizes() {
    const size = getPhotoMarkerSize();
    photoClusterGroup.eachLayer(marker => {
        if (marker._photoData) {
            const icon = L.divIcon({
                className: "photo-marker",
                html: `<img src="${marker._photoData.thumb}" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:6px;border:2px solid #fff;" />`,
                iconSize: [size, size],
                iconAnchor: [size / 2, size]
            });
            marker.setIcon(icon);
        }
    });
}

function calcLevel() {
    const distKm     = totalDistance / 1000;
    const memCount   = memories.length;
    const photoCount = photos.length;
    let currentLevel = LEVEL_TABLE[0];
    for (const row of LEVEL_TABLE) {
        if (distKm >= row.distKm && memCount >= row.memories && photoCount >= row.photos) {
            currentLevel = row;
        } else { break; }
    }
    return currentLevel;
}

function updateHud() {
    const current    = calcLevel();
    const distKm     = totalDistance / 1000;
    const memCount   = memories.length;
    const photoCount = photos.length;
    const nextRow    = LEVEL_TABLE.find(r => r.level === current.level + 1);
    const titleEl = document.getElementById("hud-title-text");
    const levelEl = document.getElementById("hud-level-num");
    if (titleEl) titleEl.textContent = current.title;
    if (levelEl) levelEl.textContent = current.level;
    const distCurEl  = document.getElementById("prog-dist-cur");
    const distBarEl  = document.getElementById("prog-dist-bar");
    const distNextEl = document.getElementById("prog-dist-next");
    if (distCurEl) distCurEl.textContent = distKm.toFixed(2) + " km";
    if (distBarEl && distNextEl) {
        if (!nextRow) { distBarEl.style.width = "100%"; distNextEl.textContent = "최고 레벨 달성!"; }
        else {
            const pct = nextRow.distKm > current.distKm ? Math.min(100, ((distKm - current.distKm) / (nextRow.distKm - current.distKm)) * 100) : 100;
            distBarEl.style.width = pct.toFixed(1) + "%";
            const remain = Math.max(0, nextRow.distKm - distKm);
            distNextEl.textContent = remain > 0.01 ? `다음까지 ${remain.toFixed(1)}km` : "조건 충족!";
        }
    }
    const memCurEl  = document.getElementById("prog-mem-cur");
    const memBarEl  = document.getElementById("prog-mem-bar");
    const memNextEl = document.getElementById("prog-mem-next");
    if (memCurEl) memCurEl.textContent = memCount + " 개";
    if (memBarEl && memNextEl) {
        if (!nextRow || nextRow.memories === 0) { memBarEl.style.width = "100%"; memNextEl.textContent = nextRow ? "조건 없음" : "최고!"; }
        else {
            const pct = nextRow.memories > current.memories ? Math.min(100, ((memCount - current.memories) / (nextRow.memories - current.memories)) * 100) : 100;
            memBarEl.style.width = pct.toFixed(1) + "%";
            const remain = Math.max(0, nextRow.memories - memCount);
            memNextEl.textContent = remain > 0 ? `다음까지 ${remain}개` : "조건 충족!";
        }
    }
    const photoCurEl  = document.getElementById("prog-photo-cur");
    const photoBarEl  = document.getElementById("prog-photo-bar");
    const photoNextEl = document.getElementById("prog-photo-next");
    if (photoCurEl) photoCurEl.textContent = photoCount + " 개";
    if (photoBarEl && photoNextEl) {
        if (!nextRow || nextRow.photos === 0) { photoBarEl.style.width = "100%"; photoNextEl.textContent = nextRow ? "조건 없음" : "최고!"; }
        else {
            const pct = nextRow.photos > current.photos ? Math.min(100, ((photoCount - current.photos) / (nextRow.photos - current.photos)) * 100) : 100;
            photoBarEl.style.width = pct.toFixed(1) + "%";
            const remain = Math.max(0, nextRow.photos - photoCount);
            photoNextEl.textContent = remain > 0 ? `다음까지 ${remain}개` : "조건 충족!";
        }
    }
}

function updateStats() {
    const todayDist = calcTodayDistance();
    const distEl  = document.getElementById("dist-val");
    const todayEl = document.getElementById("today-dist-val");
    const memEl   = document.getElementById("memory-count-val");
    const photoEl = document.getElementById("photo-count-val");
    if (distEl)  distEl.innerHTML  = `${(totalDistance / 1000).toFixed(2)}<span>km</span>`;
    if (todayEl) todayEl.innerHTML = `${(todayDist / 1000).toFixed(2)}<span>km</span>`;
    if (memEl)   memEl.innerHTML   = `${memories.length}<span>개</span>`;
    if (photoEl) photoEl.innerHTML = `${photos.length}<span>개</span>`;
    updateHud();
}

function toggleHud() {
    isHudExpanded = !isHudExpanded;
    document.getElementById("hud").classList.toggle("expanded", isHudExpanded);
    document.getElementById("controls").classList.toggle("hud-open", isHudExpanded);
    document.getElementById("help-btn").classList.toggle("hud-open", isHudExpanded);
    if (isHudExpanded) {
        setTimeout(() => { document.addEventListener("click", handleHudOutsideClick); }, 0);
    } else {
        document.removeEventListener("click", handleHudOutsideClick);
    }
}

function handleHudOutsideClick(event) {
    const hud = document.getElementById("hud");
    if (!hud.contains(event.target)) {
        isHudExpanded = false;
        hud.classList.remove("expanded");
        document.getElementById("controls").classList.remove("hud-open");
        document.getElementById("help-btn").classList.remove("hud-open");
        document.removeEventListener("click", handleHudOutsideClick);
    }
}

function syncRecordingUI() {
    recBtn.classList.toggle("recording", isRecording);
    recStatusBox.textContent = isRecording ? "기록 중" : "대기 중";
    recStatusBox.classList.toggle("recording", isRecording);
}

function syncFogButton() {
    const toggleBtn   = document.getElementById("fog-toggle-btn");
    const toggleState = document.getElementById("fog-toggle-state");
    if (!toggleBtn) return;
    toggleBtn.classList.toggle("on",  isFogEnabled);
    toggleBtn.classList.toggle("off", !isFogEnabled);
    if (toggleState) {
        toggleState.textContent = isFogEnabled ? "켜짐" : "꺼짐";
        toggleState.classList.toggle("on",  isFogEnabled);
        toggleState.classList.toggle("off", !isFogEnabled);
    }
}

function toggleHelp() { document.getElementById("help-popup").classList.toggle("show"); }
function handleHelpOverlayClick(event) {
    const box = document.getElementById("help-content-box");
    if (!box.contains(event.target)) toggleHelp();
}
function switchHelpTab(tab) {
    ["ask", "info"].forEach(t => {
        document.getElementById("htab-" + t).classList.toggle("active", t === tab);
        document.getElementById("hpanel-" + t).style.display = t === tab ? "" : "none";
    });
}

function togglePhotoMenu() {
    const menu    = document.getElementById("photo-menu");
    const overlay = document.getElementById("photo-menu-overlay");
    const isOpen  = menu.classList.contains("open");
    if (isOpen) { closePhotoMenu(); } else { menu.classList.add("open"); overlay.classList.add("show"); }
}

function closePhotoMenu() {
    document.getElementById("photo-menu").classList.remove("open");
    document.getElementById("photo-menu-overlay").classList.remove("show");
}

function triggerCamera() {
    closePhotoMenu();
    document.getElementById("camera-input").click();
}

function triggerGallery() {
    closePhotoMenu();
    document.getElementById("gallery-input").click();
}

function resetRecordingState() { isRecording = false; syncRecordingUI(); stopTracking(); }

function toggleRecording() {
    if (isRecording) {
        isRecording = false; syncRecordingUI(); stopTracking(); compactPathData(); scheduleSave(); return;
    }
    isRecording = true; syncRecordingUI(); startTracking();
}

function toggleFog() {
    isFogEnabled = !isFogEnabled;
    localStorage.setItem(FOG_ENABLED_KEY, String(isFogEnabled));
    syncFogButton(); scheduleRender();
}

function startTracking() {
    if (!navigator.geolocation) { alert("이 브라우저는 위치 추적을 지원하지 않습니다."); resetRecordingState(); return; }
    if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
        alert("위치 추적은 HTTPS 또는 localhost에서만 동작합니다."); resetRecordingState(); return;
    }
    watchId = navigator.geolocation.watchPosition(handlePosition, handleLocationError,
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
}

function stopTracking() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}

function handlePosition(position) {
    const accuracy = Number(position.coords.accuracy) || Infinity;
    const latlng   = L.latLng(position.coords.latitude, position.coords.longitude);
    currentPos     = latlng;
    if (!playerMarker) {
        playerMarker = L.marker(latlng, { icon: L.divIcon({ className: "player-marker", iconSize: [18, 18] }) }).addTo(map);
        map.setView(latlng, 16);
    } else { playerMarker.setLatLng(latlng); }
    if (!isRecording) return;
    if (accuracy > 100) { recStatusBox.textContent = `GPS 너무 약함 (${Math.round(accuracy)}m)`; return; }
    recStatusBox.textContent = accuracy > MAX_ACCURACY_M ? `GPS 약함 (${Math.round(accuracy)}m)` : "기록 중";
    const now = Date.now();
    if (pathCoordinates.length === 0) {
        pathCoordinates.push(createPathPoint(latlng, now));
        updateStats(); scheduleSave(); scheduleRender(); return;
    }
    const last          = pathCoordinates[pathCoordinates.length - 1];
    const dist          = distanceToPoint(latlng, last);
    const stayThreshold = getDynamicStayThreshold(accuracy);
    if (dist <= stayThreshold) {
        last.endTime = now; last.visits = (last.visits || 1) + 1;
        last.lat += (latlng.lat - last.lat) * 0.3;
        last.lng += (latlng.lng - last.lng) * 0.3;
    } else {
        totalDistance += dist;
        pathCoordinates.push(createPathPoint(latlng, now));
        if (pathCoordinates.length > MAX_PATH_POINTS) compactPathData();
    }
    updateStats(); scheduleSave(); scheduleRender();
}

function handleLocationError(err) {
    const messages = { 1: "위치 권한이 거부되었습니다.", 2: "현재 위치를 확인할 수 없습니다.", 3: "위치 요청 시간이 초과되었습니다." };
    alert(messages[err.code] || "위치 정보를 가져오지 못했습니다.");
    resetRecordingState();
}

function createPathPoint(latlng, timestamp) {
    return { lat: latlng.lat, lng: latlng.lng, startTime: timestamp, endTime: timestamp, visits: 1 };
}

function distanceToPoint(latlng, point) { return latlng.distanceTo([point.lat, point.lng]); }
function getDynamicStayThreshold(accuracy) { return Math.max(MIN_MOVE_M, Math.min(MAX_STAY_RADIUS_M, accuracy * STAY_ACCURACY_FACTOR)); }

function calcTodayDistance() {
    const todayStartMs = new Date().setHours(0, 0, 0, 0);
    let dist = 0;
    for (let i = 1; i < pathCoordinates.length; i++) {
        if (pathCoordinates[i].startTime >= todayStartMs) {
            dist += L.latLng(pathCoordinates[i].lat, pathCoordinates[i].lng)
                      .distanceTo([pathCoordinates[i-1].lat, pathCoordinates[i-1].lng]);
        }
    }
    return dist;
}

function compactPathData() {
    if (pathCoordinates.length <= 1) return;
    const merged = [];
    for (const point of pathCoordinates) {
        const last = merged[merged.length - 1];
        if (!last) { merged.push({ ...point }); continue; }
        const timeGap = point.startTime - last.endTime;
        const dist    = L.latLng(point.lat, point.lng).distanceTo([last.lat, last.lng]);
        if (dist <= MERGE_DISTANCE_M && timeGap <= MERGE_TIME_GAP_MS) {
            const tv = (last.visits || 1) + (point.visits || 1);
            last.lat     = ((last.lat * (last.visits || 1)) + (point.lat * (point.visits || 1))) / tv;
            last.lng     = ((last.lng * (last.visits || 1)) + (point.lng * (point.visits || 1))) / tv;
            last.endTime = Math.max(last.endTime, point.endTime);
            last.visits  = tv;
        } else { merged.push({ ...point }); }
    }
    pathCoordinates = shrinkOldPoints(merged, MAX_PATH_POINTS);
}

function shrinkOldPoints(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const keepTail = Math.floor(maxPoints * 0.4);
    const tail  = points.slice(-keepTail);
    const head  = points.slice(0, points.length - keepTail);
    const ratio = Math.ceil(head.length / (maxPoints - keepTail));
    return [...head.filter((_, i) => i % ratio === 0), ...tail].slice(-maxPoints);
}

function addMemory() {
    if (!currentPos) { alert("위치 정보를 수신 중입니다."); return; }
    const input = prompt("이 장소의 이름을 입력하세요:", "새로운 발견");
    if (input === null) return;
    const now  = new Date();
    const data = {
        id: String(now.getTime()), lat: currentPos.lat, lng: currentPos.lng,
        name: escapeHtml(input.trim() || "기억의 지점"), time: now.getTime(),
        dateString: now.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" }),
        timeString: now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    };
    memories.push(data);
    createMemoryMarker(data, true);
    updateMemoryList(); updateStats(); scheduleSave();
}

function createMemoryMarker(data, openPopup = false) {
    const marker = L.marker([data.lat, data.lng], {
        pane: "memoryPane",
        icon: L.divIcon({ className: "memory-marker", html: "★", iconSize: [28, 28] })
    }).addTo(map);
    const popupEl = document.createElement("div");
    const title = document.createElement("b"); title.textContent = data.name;
    const info = document.createElement("small"); info.style.display = "block";
    info.textContent = `${data.dateString} ${data.timeString || ""}`;
    const delBtn = document.createElement("button");
    delBtn.className = "popup-delete-btn"; delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => deleteMemory(data.id));
    popupEl.appendChild(title); popupEl.appendChild(document.createElement("br"));
    popupEl.appendChild(info); popupEl.appendChild(delBtn);
    marker.bindPopup(popupEl);
    memoryMarkers.set(data.id, marker);
    if (openPopup) marker.openPopup();
}

function deleteMemory(id) {
    memories = memories.filter(m => m.id !== id);
    const marker = memoryMarkers.get(id);
    if (marker) { map.removeLayer(marker); memoryMarkers.delete(id); }
    updateMemoryList(); updateStats(); scheduleSave();
}

function updateMemoryList() {
    const container = document.getElementById("memory-list-container");
    if (!container) return;
    if (memories.length === 0) { container.innerHTML = '<p class="empty-message">아직 기록이 없습니다.</p>'; return; }
    container.innerHTML = "";
    [...memories].reverse().forEach(memo => {
        const item = document.createElement("div"); item.className = "memory-item";
        const name = document.createElement("span"); name.className = "item-name"; name.textContent = "★ " + memo.name;
        const date = document.createElement("span"); date.className = "item-date"; date.textContent = `${memo.dateString} ${memo.timeString || ""}`;
        const actions = document.createElement("div"); actions.className = "memory-actions";
        const moveBtn = document.createElement("button"); moveBtn.className = "memory-action-btn move"; moveBtn.textContent = "이동";
        moveBtn.addEventListener("click", e => { e.stopPropagation(); map.flyTo([memo.lat, memo.lng], 17); });
        const delBtn = document.createElement("button"); delBtn.className = "memory-action-btn delete"; delBtn.textContent = "삭제";
        delBtn.addEventListener("click", e => { e.stopPropagation(); deleteMemory(memo.id); });
        actions.appendChild(moveBtn); actions.appendChild(delBtn);
        item.appendChild(name); item.appendChild(date); item.appendChild(actions);
        item.addEventListener("click", () => { map.flyTo([memo.lat, memo.lng], 17); toggleSidebar(false); });
        container.appendChild(item);
    });
}

function switchTab(tab) {
    ["memory", "photo", "gpx"].forEach(t => {
        document.getElementById("tab-" + t).classList.toggle("active", t === tab);
        document.getElementById("panel-" + t).style.display = t === tab ? "" : "none";
    });
    if (tab === "photo") updatePhotoList();
    if (tab === "gpx")   updateGpxSavedList();
}

function updatePhotoList() {
    const container = document.getElementById("photo-list-container");
    if (!container) return;
    if (photos.length === 0) { container.innerHTML = '<p class="empty-message" style="grid-column:1/-1">아직 사진이 없습니다.</p>'; return; }
    container.innerHTML = "";
    [...photos].reverse().forEach(p => {
        const item = document.createElement("div"); item.className = "photo-list-item";
        const img = document.createElement("img"); img.src = p.thumb || p.photo;
        const date = document.createElement("div"); date.className = "photo-list-date"; date.textContent = p.dateString;
        const del = document.createElement("div"); del.className = "photo-list-del"; del.textContent = "✕";
        del.addEventListener("click", e => { e.stopPropagation(); deletePhoto(p.id); updatePhotoList(); });
        item.addEventListener("click", () => {
            map.flyTo([p.lat, p.lng], 17);
            const markerLayer = findPhotoMarker(p.id);
            if (markerLayer) markerLayer.openPopup();
            toggleSidebar(false);
        });
        item.appendChild(img); item.appendChild(date); item.appendChild(del);
        container.appendChild(item);
    });
}

function findPhotoMarker(id) {
    let found = null;
    photoClusterGroup.eachLayer(layer => { if (layer._photoData && layer._photoData.id === id) found = layer; });
    return found;
}

function adjustHourDial(dir) {
    const next = dialHours + dir;
    if (next < 1 || next > 20) return;
    dialHours = next; updateDialUI();
}

function updateDialUI() {
    const labelEl = document.getElementById("dial-hour-label");
    const infoEl  = document.getElementById("gpx-range-info");
    if (labelEl) labelEl.textContent = dialHours + "시간";
    if (infoEl)  infoEl.textContent  = `오늘 기준 최근 ${dialHours}시간 발걸음`;
}

function exportGpx() {
    const sinceMs  = Date.now() - dialHours * 60 * 60 * 1000;
    const filtered = pathCoordinates.filter(p => p.startTime >= sinceMs);
    if (filtered.length === 0) { alert("해당 시간에 기록된 발걸음이 없습니다."); return; }
    const nameInput = document.getElementById("gpx-export-name").value.trim();
    const name = nameInput || `발걸음 최근${dialHours}시간`;
    const trkpts = filtered.map(p => {
        const t = new Date(p.startTime).toISOString();
        return `    <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">\n      <time>${t}</time>\n    </trkpt>`;
    }).join("\n");
    const gpxContent =
`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Giloa - 나의 대동여지도"
     xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name><time>${new Date().toISOString()}</time></metadata>
  <trk><name>${name}</name><trkseg>
${trkpts}
  </trkseg></trk>
</gpx>`;
    const saves = loadGpxSaves();
    const id    = String(Date.now());
    saves.push({ id, name, createdAt: Date.now(), pointCount: filtered.length, gpxContent });
    saveGpxSaves(saves); updateGpxSavedList();
    const blob = new Blob([gpxContent], { type: "application/gpx+xml" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `giloa_${name}.gpx`; a.click();
    URL.revokeObjectURL(url);
    document.getElementById("gpx-export-name").value = "";
    document.getElementById("gpx-import-status").textContent = `✓ "${name}" 저장 완료`;
}

function loadGpxSaves() { try { return JSON.parse(localStorage.getItem(GPX_SAVES_KEY) || "[]"); } catch { return []; } }
function saveGpxSaves(saves) { localStorage.setItem(GPX_SAVES_KEY, JSON.stringify(saves)); }

function updateGpxSavedList() {
    const container = document.getElementById("gpx-saved-list");
    if (!container) return;
    const saves = loadGpxSaves();
    if (saves.length === 0) { container.innerHTML = '<p class="empty-message">저장된 발걸음이 없습니다.</p>'; return; }
    container.innerHTML = "";
    [...saves].reverse().forEach(s => {
        const item = document.createElement("div");
        item.className = "gpx-saved-item" + (s.id === activeGpxId ? " active-route" : "");
        const icon = document.createElement("span"); icon.className = "gpx-saved-icon";
        icon.textContent = s.id === activeGpxId ? "🔵" : "👣";
        const info = document.createElement("div"); info.className = "gpx-saved-info";
        const nameEl = document.createElement("div"); nameEl.className = "gpx-saved-name"; nameEl.textContent = s.name;
        const meta = document.createElement("div"); meta.className = "gpx-saved-meta";
        meta.textContent = `${new Date(s.createdAt).toLocaleDateString("ko-KR")} · ${s.pointCount}개 포인트`;
        info.appendChild(nameEl); info.appendChild(meta);
        const del = document.createElement("div"); del.className = "gpx-saved-del"; del.textContent = "✕";
        del.addEventListener("click", e => { e.stopPropagation(); deleteGpxSave(s.id); });
        item.appendChild(icon); item.appendChild(info); item.appendChild(del);
        item.addEventListener("click", () => toggleGpxRoute(s));
        container.appendChild(item);
    });
}

function deleteGpxSave(id) {
    if (id === activeGpxId) clearActiveGpxRoute();
    saveGpxSaves(loadGpxSaves().filter(s => s.id !== id));
    updateGpxSavedList();
}

function toggleGpxRoute(save) {
    if (activeGpxId === save.id) { clearActiveGpxRoute(); updateGpxSavedList(); return; }
    clearActiveGpxRoute(); drawGpxRoute(save.gpxContent, save.id); updateGpxSavedList(); toggleSidebar(false);
}

function clearActiveGpxRoute() {
    activeGpxLayers.forEach(l => map.removeLayer(l));
    activeGpxLayers = []; activeGpxId = null;
}

function drawGpxRoute(gpxContent, id) {
    const parser  = new DOMParser();
    const xmlDoc  = parser.parseFromString(gpxContent, "application/xml");
    const trkpts  = xmlDoc.querySelectorAll("trkpt");
    const latlngs = [];
    trkpts.forEach(pt => {
        const lat = parseFloat(pt.getAttribute("lat"));
        const lng = parseFloat(pt.getAttribute("lon"));
        if (isFinite(lat) && isFinite(lng)) latlngs.push([lat, lng]);
    });
    if (latlngs.length === 0) return;
    const polyline = L.polyline(latlngs, { color: "#4db8ff", weight: 4, opacity: 0.85, dashArray: "8, 6" }).addTo(map);
    const startM = L.circleMarker(latlngs[0], { radius: 7, color: "#4db8ff", fillColor: "#fff", fillOpacity: 1, weight: 2.5 }).addTo(map).bindTooltip("출발");
    const endM   = L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, color: "#ff6b6b", fillColor: "#fff", fillOpacity: 1, weight: 2.5 }).addTo(map).bindTooltip("도착");
    activeGpxLayers = [polyline, startM, endM]; activeGpxId = id;
    map.fitBounds(polyline.getBounds(), { padding: [50, 50] });
}

function importGpxFile(event) {
    const file = event.target.files[0]; if (!file) return;
    const statusEl = document.getElementById("gpx-import-status");
    statusEl.textContent = "읽는 중...";
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const name = file.name.replace(".gpx", "");
            const gpxContent = e.target.result;
            const trkpts = new DOMParser().parseFromString(gpxContent, "application/xml").querySelectorAll("trkpt");
            if (trkpts.length === 0) { statusEl.textContent = "경로 없음"; return; }
            const saves = loadGpxSaves(); const id = String(Date.now());
            saves.push({ id, name, createdAt: Date.now(), pointCount: trkpts.length, gpxContent });
            saveGpxSaves(saves);
            clearActiveGpxRoute(); drawGpxRoute(gpxContent, id); updateGpxSavedList();
            statusEl.textContent = `✓ "${name}" 불러오기 완료`; toggleSidebar(false);
        } catch (err) { statusEl.textContent = "파일을 읽지 못했습니다."; console.error(err); }
    };
    reader.readAsText(file); event.target.value = "";
}

function toggleSidebar(forceOpen) {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (!sidebar || !overlay) return;
    const willOpen = typeof forceOpen === "boolean" ? forceOpen : !sidebar.classList.contains("open");
    sidebar.classList.toggle("open", willOpen);
    overlay.classList.toggle("show", willOpen);
}

function centerMap() { if (currentPos) map.panTo(currentPos); }

function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; compactPathData(); persistState(); }, SAVE_DELAY_MS);
}

function persistState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            pathCoordinates: pathCoordinates.map(p => ({ lat: p.lat, lng: p.lng, startTime: p.startTime, endTime: p.endTime, visits: p.visits || 1 })),
            memories: memories.map(m => ({ id: m.id, lat: m.lat, lng: m.lng, name: m.name, time: m.time, dateString: m.dateString, timeString: m.timeString })),
            photos: photos.map(p => ({ id: p.id, lat: p.lat, lng: p.lng, thumb: p.thumb, photo: p.photo, time: p.time, dateString: p.dateString, timeString: p.timeString })),
            totalDistance
        }));
    } catch (e) { console.error("저장 실패", e); }
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return;
        const saved = JSON.parse(raw);
        if (Array.isArray(saved.pathCoordinates)) {
            pathCoordinates = saved.pathCoordinates
                .filter(p => isFinite(p.lat) && isFinite(p.lng) && isFinite(p.startTime) && isFinite(p.endTime))
                .map(p => ({ lat: p.lat, lng: p.lng, startTime: p.startTime, endTime: p.endTime, visits: isFinite(p.visits) ? p.visits : 1 }));
        }
        if (Array.isArray(saved.memories)) {
            memories = saved.memories
                .filter(m => isFinite(m.lat) && isFinite(m.lng) && typeof m.name === "string")
                .map(m => ({
                    id: typeof m.id === "string" ? m.id : String(m.time),
                    lat: m.lat, lng: m.lng, name: m.name, time: m.time,
                    dateString: m.dateString,
                    timeString: typeof m.timeString === "string" ? m.timeString
                        : new Date(m.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
                }));
        }
        if (isFinite(saved.totalDistance)) totalDistance = saved.totalDistance;
        if (Array.isArray(saved.photos)) {
            photos = saved.photos.filter(p => isFinite(p.lat) && isFinite(p.lng) && (typeof p.thumb === "string" || typeof p.photo === "string"));
        }
        const savedFog = localStorage.getItem(FOG_ENABLED_KEY);
        if (savedFog !== null) isFogEnabled = savedFog === "true";
        compactPathData();
    } catch (e) { console.error("복원 실패", e); }
}

function handlePhotos(event) {
    const files = Array.from(event.target.files);
    if (!files.length) return;
    let processed = 0;

    const finishOne = () => {
        processed++;
        if (processed === files.length) {
            updateStats(); scheduleSave(); updatePhotoList();
            event.target.value = "";
        }
    };

    files.forEach(file => {
        EXIF.getData(file, function() {
            let lat = null, lng = null;
            const latVal = EXIF.getTag(this, "GPSLatitude");
            const latRef = EXIF.getTag(this, "GPSLatitudeRef");
            const lngVal = EXIF.getTag(this, "GPSLongitude");
            const lngRef = EXIF.getTag(this, "GPSLongitudeRef");

            if (latVal && lngVal) {
                lat = latVal[0] + latVal[1]/60 + latVal[2]/3600;
                lng = lngVal[0] + lngVal[1]/60 + lngVal[2]/3600;
                if (latRef === "S") lat = -lat;
                if (lngRef === "W") lng = -lng;
            }

            if (!lat || !lng) {
                if (currentPos) {
                    lat = currentPos.lat;
                    lng = currentPos.lng;
                } else {
                    const center = map.getCenter();
                    lat = center.lat;
                    lng = center.lng;
                }
            }

            const reader = new FileReader();
            reader.onload = function(e) {
                const now = new Date();
                const img = new Image();
                img.onload = function() {
                    const popup = resizeImage(img, 200);
                    const thumb = resizeImage(img, 40);
                    const data = {
                        id: String(now.getTime()) + Math.random().toString(36).slice(2),
                        lat, lng,
                        photo: popup, thumb: thumb,
                        time: now.getTime(),
                        dateString: now.toLocaleDateString("ko-KR", { year:"numeric", month:"long", day:"numeric" }),
                        timeString: now.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit" })
                    };
                    photos.push(data);
                    createPhotoMarker(data, true);
                    finishOne();
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    });
}

function resizeImage(img, maxSize) {
    const canvas = document.createElement("canvas");
    let w = img.width, h = img.height;
    if (w > h && w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; }
    else if (h > maxSize)     { w = Math.round(w * maxSize / h); h = maxSize; }
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.7);
}

function createPhotoMarker(data, openPopup = false) {
    const size = getPhotoMarkerSize();
    const marker = L.marker([data.lat, data.lng], {
        icon: L.divIcon({
            className: "photo-marker",
            html: `<img src="${data.thumb}" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:6px;border:2px solid #fff;" />`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size]
        })
    });
    marker._photoData = data;
    const popupEl = document.createElement("div"); popupEl.className = "photo-popup";
    const img = document.createElement("img"); img.src = data.photo;
    img.style.cssText = "width:200px;border-radius:8px;margin-bottom:8px;display:block;";
    const info = document.createElement("div");
    info.style.cssText = "font-size:12px;color:rgba(255,255,255,0.6);text-align:center;margin:6px 0 8px;";
    info.textContent = `${data.dateString} ${data.timeString}`;
    const delBtn = document.createElement("button"); delBtn.className = "popup-delete-btn"; delBtn.textContent = "사진 삭제";
    delBtn.addEventListener("click", () => { deletePhoto(data.id); marker.closePopup(); });
    popupEl.appendChild(img); popupEl.appendChild(info); popupEl.appendChild(delBtn);
    marker.bindPopup(popupEl);
    photoClusterGroup.addLayer(marker);
    if (openPopup) marker.openPopup();
}

function deletePhoto(id) {
    photos = photos.filter(p => p.id !== id);
    const marker = findPhotoMarker(id);
    if (marker) photoClusterGroup.removeLayer(marker);
    updateStats(); scheduleSave();
}

function escapeHtml(value) {
    return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function renderStoredMarkers()      { memories.forEach(m => createMemoryMarker(m, false)); }
function renderStoredPhotoMarkers() { photos.forEach(p => createPhotoMarker(p, false)); }
function initGpxDial() { dialHours = 12; updateDialUI(); }

function initHudTapTargets() {
    const distItem  = document.querySelector(".hud-prog-item:nth-child(1)");
    const memItem   = document.querySelector(".hud-prog-item:nth-child(2)");
    const photoItem = document.querySelector(".hud-prog-item:nth-child(3)");
    if (distItem) {
        distItem.style.cursor = "pointer";
        distItem.addEventListener("click", () => { toggleSidebar(true); switchTab("gpx"); });
    }
    if (memItem) {
        memItem.style.cursor = "pointer";
        memItem.addEventListener("click", () => { toggleSidebar(true); switchTab("memory"); });
    }
    if (photoItem) {
        photoItem.style.cursor = "pointer";
        photoItem.addEventListener("click", () => { toggleSidebar(true); switchTab("photo"); });
    }
}

function init() {
    resizeCanvas();
    loadState();
    renderStoredMarkers();
    renderStoredPhotoMarkers();
    updateStats();
    updateMemoryList();
    syncRecordingUI();
    syncFogButton();
    scheduleRender();
    initGpxDial();
    initHudTapTargets();
}

map.whenReady(() => init());
