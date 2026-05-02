// ── 앱 시작 시 위치 권한 요청 ──
async function requestLocationPermission() {
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        try {
            const { Geolocation } = window.Capacitor.Plugins;
            await Geolocation.requestPermissions();

            const { BackgroundGeolocation } = window.Capacitor.Plugins;
            if (BackgroundGeolocation) {
                await BackgroundGeolocation.addWatcher({
                    backgroundMessage: "길로아가 경로를 기록하고 있어요",
                    backgroundTitle: "길로아 위치 기록 중",
                    requestPermissions: true,
                    stale: false,
                    distanceFilter: 10
                }, function(location, error) {
                    if (error) { console.warn("BG 위치 에러", error); return; }
                    if (location && isRecording) {
                        handlePosition({
                            coords: {
                                latitude: location.latitude,
                                longitude: location.longitude,
                                accuracy: location.accuracy
                            }
                        });
                    }
                });
            }
        } catch (e) {
            console.warn("권한 요청 실패", e);
        }
    }
}
requestLocationPermission();

const STORAGE_KEY        = "giloa-v7";
const FOG_ENABLED_KEY    = "giloa-fog-enabled";
const GPX_SAVES_KEY      = "giloa-gpx-saves";
const FOG_ALPHA_BASE     = 0.80;
const FOG_ALPHA_PER_LV   = 0.01;
function getFogAlpha() {
    const lv = calcLevel().level;
    return Math.max(0, FOG_ALPHA_BASE - (lv - 1) * FOG_ALPHA_PER_LV);
}
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

const GAP_THRESHOLD_MS = 3 * 60 * 1000;

const LEVEL_TABLE = [
{ level: 1,  title: "길 없는 자",           distKm: 0,    memories: 0,  photos: 0   },
{ level: 2,  title: "흔적을 남긴 자",       distKm: 1,    memories: 0,  photos: 0   },
{ level: 3,  title: "탐험자",               distKm: 10,   memories: 1,  photos: 0   },
{ level: 4,  title: "길을 만든 자",         distKm: 30,   memories: 3,  photos: 0   },
{ level: 5,  title: "바람을 걷는 자",       distKm: 60,   memories: 5,  photos: 3   },
{ level: 6,  title: "기억을 수집하는 자",   distKm: 100,  memories: 8,  photos: 5   },
{ level: 7,  title: "두 바퀴의 여행자",     distKm: 150,  memories: 12, photos: 8   },
{ level: 8,  title: "지도를 그리는 자",     distKm: 220,  memories: 18, photos: 12  },
{ level: 9,  title: "길의 연대기",          distKm: 300,  memories: 25, photos: 18  },
{ level: 10, title: "개척자",               distKm: 400,  memories: 35, photos: 25  },
{ level: 11, title: "속도의 탐험가",        distKm: 550,  memories: 45, photos: 33  },
{ level: 12, title: "궤도를 달리는 자",     distKm: 720,  memories: 58, photos: 43  },
{ level: 13, title: "대륙을 가로지르는 자", distKm: 900,  memories: 72, photos: 55  },
{ level: 14, title: "세계의 증인",          distKm: 1100, memories: 88, photos: 68  },
{ level: 15, title: "세계의 기록자",        distKm: 1350, memories: 107, photos: 84 },
];

const SPEED_LIMIT_WALK   = 7  / 3.6;
const SPEED_LIMIT_BIKE   = 30 / 3.6;

// ── IndexedDB (사진 이미지 전용) ──
const IDB_NAME    = "giloa-photos";
const IDB_VERSION = 1;
const IDB_STORE   = "images";
let idb = null;

function openIdb() {
    return new Promise(function(resolve, reject) {
        if (idb) { resolve(idb); return; }
        var req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: "id" });
            }
        };
        req.onsuccess  = function(e) { idb = e.target.result; resolve(idb); };
        req.onerror    = function(e) { reject(e.target.error); };
    });
}

function idbSavePhoto(id, photo, thumb) {
    return openIdb().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).put({ id: id, photo: photo, thumb: thumb });
            tx.oncomplete = resolve;
            tx.onerror = function(e) { reject(e.target.error); };
        });
    });
}

function idbGetPhoto(id) {
    return openIdb().then(function(db) {
        return new Promise(function(resolve, reject) {
            var req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(id);
            req.onsuccess = function(e) { resolve(e.target.result || null); };
            req.onerror = function(e) { reject(e.target.error); };
        });
    });
}

function idbDeletePhoto(id) {
    return openIdb().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).delete(id);
            tx.oncomplete = resolve;
            tx.onerror = function(e) { reject(e.target.error); };
        });
    });
}

function idbGetAllPhotos() {
    return openIdb().then(function(db) {
        return new Promise(function(resolve, reject) {
            var req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAll();
            req.onsuccess = function(e) { resolve(e.target.result || []); };
            req.onerror = function(e) { reject(e.target.error); };
        });
    });
}

// ── 상태 변수 ──
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

const STAY_BONUS_MS        = 30 * 60 * 1000;
const STAY_BONUS_RADIUS_M  = 50;
let stayBonusStartTime     = null;
let stayBonusAnchor        = null;
let stayBonusLevelBoost    = 0;
let stayBonusPlaces        = [];

const recBtn       = document.getElementById("rec-btn");
const recStatusBox = document.getElementById("rec-status-box");

// ── 지도 초기화 ──
const map = L.map("map", { zoomControl: false, attributionControl: false })
    .setView([37.5665, 126.978], 16);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);

// 캔버스를 Leaflet 내부로 편입시켜 마커가 안개 위에 보이도록 함
map.whenReady(function() {
    var mapPane = map.getPane("mapPane");
    var fogC  = document.getElementById("fog-canvas");
    var ageC  = document.getElementById("age-canvas");
    var stayC = document.getElementById("stay-canvas");

    mapPane.appendChild(stayC);
    mapPane.appendChild(ageC);
    mapPane.appendChild(fogC);

    stayC.style.zIndex = "402";
    ageC.style.zIndex  = "401";
    fogC.style.zIndex  = "400";

    map.on("move", function() {
        var offset = map._getMapPanePos();
        var t = "translate3d(" + (-offset.x) + "px," + (-offset.y) + "px,0)";
        fogC.style.transform  = t;
        ageC.style.transform  = t;
        stayC.style.transform = t;
    });
    map.fire("move");
});
map.createPane("photoPane");
map.getPane("photoPane").style.zIndex = 630;

map.createPane("memoryPane");
map.getPane("memoryPane").style.zIndex = 640;

map.createPane("playerPane");
map.getPane("playerPane").style.zIndex = 650;

const photoClusterGroup = L.markerClusterGroup({
    clusterPane: "photoPane",
    maxClusterRadius: 60,
    disableClusteringAtZoom: CLUSTER_ZOOM_THRESHOLD + 1,
    iconCreateFunction: function(cluster) {
        var count = cluster.getChildCount();
        return L.divIcon({
            className: "photo-cluster-icon",
            html: '<div class="photo-cluster-inner">' + count + '</div>',
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
    var w = window.innerWidth;
    var h = window.innerHeight;
    [fogCanvas, ageCanvas, stayCanvas].forEach(function(c) {
        c.width  = w;
        c.height = h;
    });
    scheduleRender();
}

window.addEventListener("resize", resizeCanvas);
map.on("move zoom", scheduleRender);
map.on("zoomend", updatePhotoMarkerSizes);

function scheduleRender() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(function() { rafId = null; render(); });
}

function render() {
    renderFog();
    renderAgeTint();
    renderStayTint();
}

function calcMpp() {
    var center = map.getCenter();
    var pt  = map.latLngToContainerPoint(center);
    var ll2 = map.containerPointToLatLng(L.point(pt.x + 10, pt.y));
    return center.distanceTo(ll2) || 1;
}

function metersToPixels(meters, mpp) {
    return (meters / mpp) * 10;
}

function renderFog() {
    var w = fogCanvas.width, h = fogCanvas.height;
    fogCtx.clearRect(0, 0, w, h);
    if (!isFogEnabled) return;
    fogCtx.fillStyle = "rgba(8, 10, 18, " + getFogAlpha() + ")";
    fogCtx.fillRect(0, 0, w, h);
    if (pathCoordinates.length === 0) return;

    var now    = Date.now();
    var mpp    = calcMpp();
    var radius = metersToPixels(FOG_RADIUS_M, mpp);

    var BUCKET = 0.05;
    var buckets = new Map();

    var addToBucket = function(alpha, drawFn) {
        var key = Math.round(alpha / BUCKET) * BUCKET;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(drawFn);
    };

    if (pathCoordinates.length === 1) {
        var point    = pathCoordinates[0];
        var ageHours = (now - point.startTime) / 3600000;
        var alpha    = getPathVisibility(ageHours);
        var stayMin  = (point.endTime - point.startTime) / 60000;
        var stayR    = metersToPixels(getStayRadiusMeters(stayMin), mpp);
        var pos      = map.latLngToContainerPoint([point.lat, point.lng]);
        addToBucket(alpha, function(ctx) {
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, stayR, 0, Math.PI * 2);
            ctx.fill();
        });
    } else {
        for (var i = 1; i < pathCoordinates.length; i++) {
            (function(idx) {
                var point    = pathCoordinates[idx];
                var ageHours = (now - point.startTime) / 3600000;
                var alpha    = getPathVisibility(ageHours);
                var stayMin  = (point.endTime - point.startTime) / 60000;
                var stayR    = metersToPixels(getStayRadiusMeters(stayMin), mpp);
                var prev     = map.latLngToContainerPoint([pathCoordinates[idx - 1].lat, pathCoordinates[idx - 1].lng]);
                var pos      = map.latLngToContainerPoint([point.lat, point.lng]);

                if (stayMin >= 10) {
                    addToBucket(alpha, function(ctx) {
                        ctx.beginPath();
                        ctx.arc(pos.x, pos.y, stayR, 0, Math.PI * 2);
                        ctx.fill();
                    });
                }
                var timeGap = point.startTime - pathCoordinates[idx - 1].endTime;
                if (timeGap <= GAP_THRESHOLD_MS) {
                    addToBucket(alpha, function(ctx) {
                        ctx.beginPath();
                        ctx.moveTo(prev.x, prev.y);
                        ctx.lineTo(pos.x, pos.y);
                        ctx.stroke();
                    });
                }
            })(i);
        }
    }

    var offscreen = document.createElement("canvas");
    offscreen.width  = w;
    offscreen.height = h;
    var offCtx = offscreen.getContext("2d");

    buckets.forEach(function(drawFns, alpha) {
        offCtx.clearRect(0, 0, w, h);
        offCtx.fillStyle   = "rgba(0,0,0," + alpha + ")";
        offCtx.strokeStyle = "rgba(0,0,0," + alpha + ")";
        offCtx.lineWidth   = radius * 2;
        offCtx.lineCap     = "round";
        offCtx.lineJoin    = "round";
        drawFns.forEach(function(fn) { fn(offCtx); });

        fogCtx.save();
        fogCtx.globalCompositeOperation = "destination-out";
        fogCtx.drawImage(offscreen, 0, 0);
        fogCtx.restore();
    });
}

function getPathVisibility(ageHours) {
    if (ageHours <= FULL_VISIBILITY_HOURS) return 1;
    if (ageHours >= MIN_VISIBILITY_HOURS)  return MIN_PATH_VISIBILITY;
    return 1 - (1 - MIN_PATH_VISIBILITY) * (ageHours / MIN_VISIBILITY_HOURS);
}

function renderAgeTint() {
    var w = ageCanvas.width, h = ageCanvas.height;
    ageCtx.clearRect(0, 0, w, h);
    if (pathCoordinates.length === 0) return;
    var now    = Date.now();
    var mpp    = calcMpp();
    var radius = metersToPixels(FOG_RADIUS_M, mpp);

    var buckets = new Map();
    pathCoordinates.forEach(function(point, i) {
        var ageDays = (now - point.startTime) / 86400000;
        var color   = getAgeColor(ageDays);
        if (!color) return;
        if (!buckets.has(color)) buckets.set(color, []);
        var pos = map.latLngToContainerPoint([point.lat, point.lng]);
        if (i > 0) {
            var timeGap = point.startTime - pathCoordinates[i - 1].endTime;
            if (timeGap <= GAP_THRESHOLD_MS) {
                var prev = map.latLngToContainerPoint([pathCoordinates[i - 1].lat, pathCoordinates[i - 1].lng]);
                buckets.get(color).push({ x1: prev.x, y1: prev.y, x2: pos.x, y2: pos.y });
            }
        }
    });

    buckets.forEach(function(draws, color) {
        var offscreen = document.createElement("canvas");
        offscreen.width  = w;
        offscreen.height = h;
        var offCtx = offscreen.getContext("2d");
        offCtx.strokeStyle = color;
        offCtx.lineWidth   = radius * 1.15;
        offCtx.lineCap     = "round";
        offCtx.lineJoin    = "round";
        offCtx.beginPath();
        draws.forEach(function(d) {
            offCtx.moveTo(d.x1, d.y1);
            offCtx.lineTo(d.x2, d.y2);
        });
        offCtx.stroke();
        ageCtx.drawImage(offscreen, 0, 0);
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
    var w = stayCanvas.width, h = stayCanvas.height;
    stayCtx.clearRect(0, 0, w, h);
    if (pathCoordinates.length === 0) return;
    var mpp = calcMpp();
    pathCoordinates.forEach(function(point) {
        var stayMin = (point.endTime - point.startTime) / 60000;
        if (stayMin < 10) return;
        var pos    = map.latLngToContainerPoint([point.lat, point.lng]);
        var radius = metersToPixels(getStayRadiusMeters(stayMin), mpp);
        var grad = stayCtx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, radius);
        grad.addColorStop(0,   "rgba(255, 220, 100, 0.18)");
        grad.addColorStop(0.6, "rgba(255, 220, 100, 0.08)");
        grad.addColorStop(1,   "rgba(255, 220, 100, 0)");
        stayCtx.fillStyle = grad;
        stayCtx.beginPath();
        stayCtx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        stayCtx.fill();
    });
}

function getStayRadiusMeters(stayMin) {
    if (stayMin < 10)   return FOG_RADIUS_M;
    if (stayMin >= 180) return FOG_RADIUS_M * 2.0;
    return FOG_RADIUS_M * (1.0 + (stayMin - 10) / (180 - 10));
}

function getPhotoMarkerSize() {
    var zoom = map.getZoom();
    if (zoom >= MARKER_MAX_ZOOM) return MARKER_MAX_SIZE;
    if (zoom <= MARKER_MIN_ZOOM) return MARKER_MIN_SIZE;
    var ratio = (zoom - MARKER_MIN_ZOOM) / (MARKER_MAX_ZOOM - MARKER_MIN_ZOOM);
    return Math.round(MARKER_MIN_SIZE + ratio * (MARKER_MAX_SIZE - MARKER_MIN_SIZE));
}

function updatePhotoMarkerSizes() {
    var size = getPhotoMarkerSize();
    photoClusterGroup.eachLayer(function(marker) {
        if (marker._photoData) {
            var icon = L.divIcon({
                className: "photo-marker",
                html: '<img src="' + marker._photoData.thumb + '" style="width:' + size + 'px;height:' + size + 'px;object-fit:cover;border-radius:6px;border:2px solid #fff;" />',
                iconSize: [size, size],
                iconAnchor: [size / 2, size]
            });
            marker.setIcon(icon);
        }
    });
}

function calcLevel() {
    var distKm     = totalDistance / 1000;
    var memCount   = memories.length;
    var photoCount = photos.length;
    var currentLevel = LEVEL_TABLE[0];
    for (var i = 0; i < LEVEL_TABLE.length; i++) {
        var row = LEVEL_TABLE[i];
        if (distKm >= row.distKm && memCount >= row.memories && photoCount >= row.photos) {
            currentLevel = row;
        } else { break; }
    }
    var boostedLevel = Math.min(currentLevel.level + stayBonusLevelBoost, LEVEL_TABLE.length);
    return LEVEL_TABLE[boostedLevel - 1];
}

function updateHud() {
    var current    = calcLevel();
    var distKm     = totalDistance / 1000;
    var memCount   = memories.length;
    var photoCount = photos.length;
    var nextRow    = LEVEL_TABLE.find(function(r) { return r.level === current.level + 1; });
    var titleEl = document.getElementById("hud-title-text");
    var levelEl = document.getElementById("hud-level-num");
    if (titleEl) titleEl.textContent = current.title;
    if (levelEl) levelEl.textContent = current.level;

    var distCurEl  = document.getElementById("prog-dist-cur");
    var distBarEl  = document.getElementById("prog-dist-bar");
    var distNextEl = document.getElementById("prog-dist-next");
    if (distCurEl) distCurEl.textContent = distKm.toFixed(2) + " km";
    if (distBarEl && distNextEl) {
        if (!nextRow) {
            distBarEl.style.width = "100%";
            distNextEl.textContent = "최고 레벨 달성!";
        } else {
            var pct = nextRow.distKm > current.distKm ? Math.min(100, ((distKm - current.distKm) / (nextRow.distKm - current.distKm)) * 100) : 100;
            distBarEl.style.width = pct.toFixed(1) + "%";
            var remain = Math.max(0, nextRow.distKm - distKm);
            distNextEl.textContent = remain > 0.01 ? "다음까지 " + remain.toFixed(1) + "km" : "조건 충족!";
        }
    }

    var memCurEl  = document.getElementById("prog-mem-cur");
    var memBarEl  = document.getElementById("prog-mem-bar");
    var memNextEl = document.getElementById("prog-mem-next");
    if (memCurEl) memCurEl.textContent = memCount + " 개";
    if (memBarEl && memNextEl) {
        if (!nextRow || nextRow.memories === 0) {
            memBarEl.style.width = "100%";
            memNextEl.textContent = nextRow ? "조건 없음" : "최고!";
        } else {
            var pct2 = nextRow.memories > current.memories ? Math.min(100, ((memCount - current.memories) / (nextRow.memories - current.memories)) * 100) : 100;
            memBarEl.style.width = pct2.toFixed(1) + "%";
            var remain2 = Math.max(0, nextRow.memories - memCount);
            memNextEl.textContent = remain2 > 0 ? "다음까지 " + remain2 + "개" : "조건 충족!";
        }
    }

    var photoCurEl  = document.getElementById("prog-photo-cur");
    var photoBarEl  = document.getElementById("prog-photo-bar");
    var photoNextEl = document.getElementById("prog-photo-next");
    if (photoCurEl) photoCurEl.textContent = photoCount + " 개";
    if (photoBarEl && photoNextEl) {
        if (!nextRow || nextRow.photos === 0) {
            photoBarEl.style.width = "100%";
            photoNextEl.textContent = nextRow ? "조건 없음" : "최고!";
        } else {
            var pct3 = nextRow.photos > current.photos ? Math.min(100, ((photoCount - current.photos) / (nextRow.photos - current.photos)) * 100) : 100;
            photoBarEl.style.width = pct3.toFixed(1) + "%";
            var remain3 = Math.max(0, nextRow.photos - photoCount);
            photoNextEl.textContent = remain3 > 0 ? "다음까지 " + remain3 + "개" : "조건 충족!";
        }
    }
}

function updateStats() {
    var todayDist = calcTodayDistance();
    var distEl  = document.getElementById("dist-val");
    var todayEl = document.getElementById("today-dist-val");
    var memEl   = document.getElementById("memory-count-val");
    var photoEl = document.getElementById("photo-count-val");
    if (distEl)  distEl.innerHTML  = (totalDistance / 1000).toFixed(2) + "<span>km</span>";
    if (todayEl) todayEl.innerHTML = (todayDist / 1000).toFixed(2) + "<span>km</span>";
    if (memEl)   memEl.innerHTML   = memories.length + "<span>개</span>";
    if (photoEl) photoEl.innerHTML = photos.length + "<span>개</span>";
    updateHud();
}

function toggleHud() {
    isHudExpanded = !isHudExpanded;
    document.getElementById("hud").classList.toggle("expanded", isHudExpanded);
    document.getElementById("controls").classList.toggle("hud-open", isHudExpanded);
    document.getElementById("help-btn").classList.toggle("hud-open", isHudExpanded);
    if (isHudExpanded) {
        setTimeout(function() { document.addEventListener("click", handleHudOutsideClick); }, 0);
    } else {
        document.removeEventListener("click", handleHudOutsideClick);
    }
}

function handleHudOutsideClick(event) {
    var hud = document.getElementById("hud");
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
    var toggleBtn   = document.getElementById("fog-toggle-btn");
    var toggleState = document.getElementById("fog-toggle-state");
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
    var box = document.getElementById("help-content-box");
    if (!box.contains(event.target)) toggleHelp();
}
function switchHelpTab(tab) {
    ["ask", "info"].forEach(function(t) {
        document.getElementById("htab-" + t).classList.toggle("active", t === tab);
        document.getElementById("hpanel-" + t).style.display = t === tab ? "" : "none";
    });
}

function togglePhotoMenu() {
    var menu    = document.getElementById("photo-menu");
    var overlay = document.getElementById("photo-menu-overlay");
    var isOpen  = menu.classList.contains("open");
    if (isOpen) { closePhotoMenu(); } else { menu.classList.add("open"); overlay.classList.add("show"); }
}

function closePhotoMenu() {
    document.getElementById("photo-menu").classList.remove("open");
    document.getElementById("photo-menu-overlay").classList.remove("show");
}

async function triggerCamera() {
    closePhotoMenu();
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        try {
            var Camera = window.Capacitor.Plugins.Camera;
            var photo = await Camera.getPhoto({
                quality: 80,
                resultType: "uri",
                source: "CAMERA"
            });
            var now = new Date();
            var img = new Image();
            img.onload = function() {
                var lat = currentPos ? currentPos.lat : map.getCenter().lat;
                var lng = currentPos ? currentPos.lng : map.getCenter().lng;
                processPhoto(img, now, lat, lng);
            };
            img.src = photo.webPath;
        } catch (e) {
            console.warn("카메라 실패", e);
        }
    } else {
        document.getElementById("camera-input").click();
    }
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
    var accuracy = Number(position.coords.accuracy) || Infinity;
    var latlng   = L.latLng(position.coords.latitude, position.coords.longitude);
    currentPos   = latlng;
    if (!playerMarker) {
        playerMarker = L.marker(latlng, {
            pane: "playerPane",
            icon: L.divIcon({ className: "player-marker", iconSize: [18, 18] })
        }).addTo(map);
        map.setView(latlng, 16);
    } else { playerMarker.setLatLng(latlng); }
    if (!isRecording) return;
    if (accuracy > 100) { recStatusBox.textContent = "GPS 너무 약함 (" + Math.round(accuracy) + "m)"; return; }

    var now = Date.now();
    recStatusBox.textContent = accuracy > MAX_ACCURACY_M ? "GPS 약함 (" + Math.round(accuracy) + "m)" : "기록 중";

    if (pathCoordinates.length === 0) {
        pathCoordinates.push(createPathPoint(latlng, now));
        checkStayBonus(latlng, now);
        updateStats(); scheduleSave(); scheduleRender(); return;
    }

    var last          = pathCoordinates[pathCoordinates.length - 1];
    var dist          = distanceToPoint(latlng, last);
    var stayThreshold = getDynamicStayThreshold(accuracy);
    if (dist <= stayThreshold) {
        last.endTime = now; last.visits = (last.visits || 1) + 1;
        last.lat += (latlng.lat - last.lat) * 0.3;
        last.lng += (latlng.lng - last.lng) * 0.3;
    } else {
        totalDistance += dist;
        pathCoordinates.push(createPathPoint(latlng, now));
        if (pathCoordinates.length > MAX_PATH_POINTS) compactPathData();
    }
    checkStayBonus(latlng, now);
    updateStats(); scheduleSave(); scheduleRender();
}

function handleLocationError(err) {
    var messages = { 1: "위치 권한이 거부되었습니다.", 2: "현재 위치를 확인할 수 없습니다.", 3: "위치 요청 시간이 초과되었습니다." };
    alert(messages[err.code] || "위치 정보를 가져오지 못했습니다.");
    resetRecordingState();
}

function createPathPoint(latlng, timestamp) {
    return { lat: latlng.lat, lng: latlng.lng, startTime: timestamp, endTime: timestamp, visits: 1 };
}

function distanceToPoint(latlng, point) { return latlng.distanceTo([point.lat, point.lng]); }
function getDynamicStayThreshold(accuracy) { return Math.max(MIN_MOVE_M, Math.min(MAX_STAY_RADIUS_M, accuracy * STAY_ACCURACY_FACTOR)); }

function checkStayBonus(latlng, now) {
    if (!stayBonusAnchor) {
        stayBonusAnchor    = latlng;
        stayBonusStartTime = now;
        return;
    }
    var distFromAnchor = latlng.distanceTo(stayBonusAnchor);
    if (distFromAnchor > STAY_BONUS_RADIUS_M) {
        stayBonusAnchor    = latlng;
        stayBonusStartTime = now;
        return;
    }

    var alreadyBonused = stayBonusPlaces.some(function(p) {
        return latlng.distanceTo([p.lat, p.lng]) <= STAY_BONUS_RADIUS_M;
    });
    if (alreadyBonused) return;

    var elapsed   = now - stayBonusStartTime;
    var remaining = STAY_BONUS_MS - elapsed;

    if (remaining > 0) {
        var mins = Math.ceil(remaining / 60000);
        recStatusBox.textContent = "기록 중 · 체류 보너스까지 " + mins + "분";
        return;
    }

    stayBonusPlaces.push({ lat: stayBonusAnchor.lat, lng: stayBonusAnchor.lng });
    stayBonusLevelBoost += 1;
    saveBonusState();
    updateStats();

    recStatusBox.textContent = "30분 체류 달성! 레벨 +1 보너스!";
    setTimeout(function() {
        if (isRecording) recStatusBox.textContent = "기록 중";
    }, 4000);
}

function saveBonusState() {
    localStorage.setItem("giloa-stay-bonus", JSON.stringify({
        boost:  stayBonusLevelBoost,
        places: stayBonusPlaces
    }));
}

function loadBonusState() {
    try {
        var raw = localStorage.getItem("giloa-stay-bonus");
        if (!raw) return;
        var data = JSON.parse(raw);
        stayBonusLevelBoost = isFinite(data.boost) ? data.boost : 0;
        stayBonusPlaces     = Array.isArray(data.places) ? data.places.filter(function(p) { return isFinite(p.lat) && isFinite(p.lng); }) : [];
    } catch (e) { console.warn("보너스 상태 복원 실패", e); }
}

function calcTodayDistance() {
    var todayStartMs = new Date().setHours(0, 0, 0, 0);
    var dist = 0;
    for (var i = 1; i < pathCoordinates.length; i++) {
        if (pathCoordinates[i].startTime >= todayStartMs) {
            dist += L.latLng(pathCoordinates[i].lat, pathCoordinates[i].lng)
                .distanceTo([pathCoordinates[i - 1].lat, pathCoordinates[i - 1].lng]);
        }
    }
    return dist;
}

function compactPathData() {
    if (pathCoordinates.length <= 1) return;
    var merged = [];
    for (var i = 0; i < pathCoordinates.length; i++) {
        var point = pathCoordinates[i];
        var last = merged[merged.length - 1];
        if (!last) { merged.push(Object.assign({}, point)); continue; }
        var timeGap = point.startTime - last.endTime;
        var dist    = L.latLng(point.lat, point.lng).distanceTo([last.lat, last.lng]);
        if (dist <= MERGE_DISTANCE_M && timeGap <= MERGE_TIME_GAP_MS) {
            var tv = (last.visits || 1) + (point.visits || 1);
            last.lat     = ((last.lat * (last.visits || 1)) + (point.lat * (point.visits || 1))) / tv;
            last.lng     = ((last.lng * (last.visits || 1)) + (point.lng * (point.visits || 1))) / tv;
            last.endTime = Math.max(last.endTime, point.endTime);
            last.visits  = tv;
        } else { merged.push(Object.assign({}, point)); }
    }
    pathCoordinates = shrinkOldPoints(merged, MAX_PATH_POINTS);
}

function shrinkOldPoints(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    var keepTail = Math.floor(maxPoints * 0.4);
    var tail  = points.slice(-keepTail);
    var head  = points.slice(0, points.length - keepTail);
    var ratio = Math.ceil(head.length / (maxPoints - keepTail));
    var filtered = head.filter(function(_, i) { return i % ratio === 0; });
    return filtered.concat(tail).slice(-maxPoints);
}

function addMemory() {
    if (!currentPos) { alert("위치 정보를 수신 중입니다."); return; }
    var input = prompt("이 장소의 이름을 입력하세요:", "새로운 발견");
    if (input === null) return;
    var now  = new Date();
    var data = {
        id: String(now.getTime()), lat: currentPos.lat, lng: currentPos.lng,
        name: escapeHtml(input.trim() || "기억의 지점"), time: now.getTime(),
        dateString: now.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" }),
        timeString: now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    };
    memories.push(data);
    createMemoryMarker(data, true);
    updateMemoryList(); updateStats(); scheduleSave();
}

function createMemoryMarker(data, openPopup) {
    var marker = L.marker([data.lat, data.lng], {
        pane: "memoryPane",
        icon: L.divIcon({ className: "memory-marker", html: "★", iconSize: [28, 28] })
    }).addTo(map);
    var popupEl = document.createElement("div");
    var title = document.createElement("b"); title.textContent = data.name;
    var info = document.createElement("small"); info.style.display = "block";
    info.textContent = data.dateString + " " + (data.timeString || "");
    var delBtn = document.createElement("button");
    delBtn.className = "popup-delete-btn"; delBtn.textContent = "삭제";
    delBtn.addEventListener("click", function() { deleteMemory(data.id); });
    popupEl.appendChild(title); popupEl.appendChild(document.createElement("br"));
    popupEl.appendChild(info); popupEl.appendChild(delBtn);
    marker.bindPopup(popupEl);
    memoryMarkers.set(data.id, marker);
    if (openPopup) marker.openPopup();
}

function deleteMemory(id) {
    memories = memories.filter(function(m) { return m.id !== id; });
    var marker = memoryMarkers.get(id);
    if (marker) { map.removeLayer(marker); memoryMarkers.delete(id); }
    updateMemoryList(); updateStats(); scheduleSave();
}

function updateMemoryList() {
    var container = document.getElementById("memory-list-container");
    if (!container) return;
    if (memories.length === 0) { container.innerHTML = '<p class="empty-message">아직 기록이 없습니다.</p>'; return; }
    container.innerHTML = "";
    memories.slice().reverse().forEach(function(memo) {
        var item = document.createElement("div"); item.className = "memory-item";
        var name = document.createElement("span"); name.className = "item-name"; name.textContent = "★ " + memo.name;
        var date = document.createElement("span"); date.className = "item-date"; date.textContent = memo.dateString + " " + (memo.timeString || "");
        var actions = document.createElement("div"); actions.className = "memory-actions";
        var moveBtn = document.createElement("button"); moveBtn.className = "memory-action-btn move"; moveBtn.textContent = "이동";
        moveBtn.addEventListener("click", function(e) { e.stopPropagation(); map.flyTo([memo.lat, memo.lng], 17); });
        var delBtn = document.createElement("button"); delBtn.className = "memory-action-btn delete"; delBtn.textContent = "삭제";
        delBtn.addEventListener("click", function(e) { e.stopPropagation(); deleteMemory(memo.id); });
        actions.appendChild(moveBtn); actions.appendChild(delBtn);
        item.appendChild(name); item.appendChild(date); item.appendChild(actions);
        item.addEventListener("click", function() { map.flyTo([memo.lat, memo.lng], 17); toggleSidebar(false); });
        container.appendChild(item);
    });
}

function switchTab(tab) {
    ["memory", "photo", "gpx"].forEach(function(t) {
        document.getElementById("tab-" + t).classList.toggle("active", t === tab);
        document.getElementById("panel-" + t).style.display = t === tab ? "" : "none";
    });
    if (tab === "photo") updatePhotoList();
    if (tab === "gpx")   updateGpxSavedList();
}

function updatePhotoList() {
    var container = document.getElementById("photo-list-container");
    if (!container) return;
    if (photos.length === 0) { container.innerHTML = '<p class="empty-message" style="grid-column:1/-1">아직 사진이 없습니다.</p>'; return; }
    container.innerHTML = "";
    photos.slice().reverse().forEach(function(p) {
        var item = document.createElement("div"); item.className = "photo-list-item";
        var img = document.createElement("img"); img.src = p.thumb || p.photo;
        var date = document.createElement("div"); date.className = "photo-list-date"; date.textContent = p.dateString;
        var del = document.createElement("div"); del.className = "photo-list-del"; del.textContent = "✕";
        del.addEventListener("click", function(e) { e.stopPropagation(); deletePhoto(p.id); updatePhotoList(); });
        item.addEventListener("click", function() {
            map.flyTo([p.lat, p.lng], 17);
            var markerLayer = findPhotoMarker(p.id);
            if (markerLayer) markerLayer.openPopup();
            toggleSidebar(false);
        });
        item.appendChild(img); item.appendChild(date); item.appendChild(del);
        container.appendChild(item);
    });
}

function findPhotoMarker(id) {
    var found = null;
    photoClusterGroup.eachLayer(function(layer) { if (layer._photoData && layer._photoData.id === id) found = layer; });
    return found;
}

function adjustHourDial(dir) {
    var next = dialHours + dir;
    if (next < 1 || next > 20) return;
    dialHours = next; updateDialUI();
}

function updateDialUI() {
    var labelEl = document.getElementById("dial-hour-label");
    var infoEl  = document.getElementById("gpx-range-info");
    if (labelEl) labelEl.textContent = dialHours + "시간";
    if (infoEl)  infoEl.textContent  = "오늘 기준 최근 " + dialHours + "시간 발걸음";
}

function exportGpx() {
    var sinceMs  = Date.now() - dialHours * 60 * 60 * 1000;
    var filtered = pathCoordinates.filter(function(p) { return p.startTime >= sinceMs; });
    if (filtered.length === 0) { alert("해당 시간에 기록된 발걸음이 없습니다."); return; }
    var nameInput = document.getElementById("gpx-export-name").value.trim();
    var name = nameInput || "발걸음 최근" + dialHours + "시간";
    var trkpts = filtered.map(function(p) {
        var t = new Date(p.startTime).toISOString();
        return '    <trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lng.toFixed(7) + '">\n      <time>' + t + '</time>\n    </trkpt>';
    }).join("\n");
    var gpxContent =
'<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Giloa - 나의 대동여지도"\n     xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>' + name + '</name><time>' + new Date().toISOString() + '</time></metadata>\n  <trk><name>' + name + '</name><trkseg>\n' + trkpts + '\n  </trkseg></trk>\n</gpx>';
    var saves = loadGpxSaves();
    var id    = String(Date.now());
    saves.push({ id: id, name: name, createdAt: Date.now(), pointCount: filtered.length, gpxContent: gpxContent });
    saveGpxSaves(saves); updateGpxSavedList();
    var blob = new Blob([gpxContent], { type: "application/gpx+xml" });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement("a");
    a.href = url; a.download = "giloa_" + name + ".gpx"; a.click();
    URL.revokeObjectURL(url);
    document.getElementById("gpx-export-name").value = "";
    document.getElementById("gpx-import-status").textContent = '✓ "' + name + '" 저장 완료';
}

function loadGpxSaves() { try { return JSON.parse(localStorage.getItem(GPX_SAVES_KEY) || "[]"); } catch(e) { return []; } }
function saveGpxSaves(saves) { localStorage.setItem(GPX_SAVES_KEY, JSON.stringify(saves)); }

function updateGpxSavedList() {
    var container = document.getElementById("gpx-saved-list");
    if (!container) return;
    var saves = loadGpxSaves();
    if (saves.length === 0) { container.innerHTML = '<p class="empty-message">저장된 발걸음이 없습니다.</p>'; return; }
    container.innerHTML = "";
    saves.slice().reverse().forEach(function(s) {
        var item = document.createElement("div");
        item.className = "gpx-saved-item" + (s.id === activeGpxId ? " active-route" : "");
        var icon = document.createElement("span"); icon.className = "gpx-saved-icon";
        icon.textContent = s.id === activeGpxId ? "🔵" : "👣";
        var info = document.createElement("div"); info.className = "gpx-saved-info";
        var nameEl = document.createElement("div"); nameEl.className = "gpx-saved-name"; nameEl.textContent = s.name;
        var meta = document.createElement("div"); meta.className = "gpx-saved-meta";
        meta.textContent = new Date(s.createdAt).toLocaleDateString("ko-KR") + " · " + s.pointCount + "개 포인트";
        info.appendChild(nameEl); info.appendChild(meta);
        var del = document.createElement("div"); del.className = "gpx-saved-del"; del.textContent = "✕";
        del.addEventListener("click", function(e) { e.stopPropagation(); deleteGpxSave(s.id); });
        item.appendChild(icon); item.appendChild(info); item.appendChild(del);
        item.addEventListener("click", function() { toggleGpxRoute(s); });
        container.appendChild(item);
    });
}

function deleteGpxSave(id) {
    if (id === activeGpxId) clearActiveGpxRoute();
    saveGpxSaves(loadGpxSaves().filter(function(s) { return s.id !== id; }));
    updateGpxSavedList();
}

function toggleGpxRoute(save) {
    if (activeGpxId === save.id) { clearActiveGpxRoute(); updateGpxSavedList(); return; }
    clearActiveGpxRoute(); drawGpxRoute(save.gpxContent, save.id); updateGpxSavedList(); toggleSidebar(false);
}

function clearActiveGpxRoute() {
    activeGpxLayers.forEach(function(l) { map.removeLayer(l); });
    activeGpxLayers = []; activeGpxId = null;
}

function drawGpxRoute(gpxContent, id) {
    var parser  = new DOMParser();
    var xmlDoc  = parser.parseFromString(gpxContent, "application/xml");
    var trkpts  = xmlDoc.querySelectorAll("trkpt");
    var latlngs = [];
    trkpts.forEach(function(pt) {
        var lat = parseFloat(pt.getAttribute("lat"));
        var lng = parseFloat(pt.getAttribute("lon"));
        if (isFinite(lat) && isFinite(lng)) latlngs.push([lat, lng]);
    });
    if (latlngs.length === 0) return;
    var polyline = L.polyline(latlngs, { color: "#4db8ff", weight: 4, opacity: 0.85, dashArray: "8, 6" }).addTo(map);
    var startM = L.circleMarker(latlngs[0], { radius: 7, color: "#4db8ff", fillColor: "#fff", fillOpacity: 1, weight: 2.5 }).addTo(map).bindTooltip("출발");
    var endM   = L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, color: "#ff6b6b", fillColor: "#fff", fillOpacity: 1, weight: 2.5 }).addTo(map).bindTooltip("도착");
    activeGpxLayers = [polyline, startM, endM]; activeGpxId = id;
    map.fitBounds(polyline.getBounds(), { padding: [50, 50] });
}

function importGpxFile(event) {
    var file = event.target.files[0]; if (!file) return;
    var statusEl = document.getElementById("gpx-import-status");
    statusEl.textContent = "읽는 중...";
    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var name = file.name.replace(".gpx", "");
            var gpxContent = e.target.result;
            var trkpts = new DOMParser().parseFromString(gpxContent, "application/xml").querySelectorAll("trkpt");
            if (trkpts.length === 0) { statusEl.textContent = "경로 없음"; return; }
            var saves = loadGpxSaves(); var id = String(Date.now());
            saves.push({ id: id, name: name, createdAt: Date.now(), pointCount: trkpts.length, gpxContent: gpxContent });
            saveGpxSaves(saves);
            clearActiveGpxRoute(); drawGpxRoute(gpxContent, id); updateGpxSavedList();
            statusEl.textContent = '✓ "' + name + '" 불러오기 완료'; toggleSidebar(false);
        } catch (err) { statusEl.textContent = "파일을 읽지 못했습니다."; console.error(err); }
    };
    reader.readAsText(file); event.target.value = "";
}

function toggleSidebar(forceOpen) {
    var sidebar = document.getElementById("sidebar");
    var overlay = document.getElementById("sidebar-overlay");
    if (!sidebar || !overlay) return;
    var willOpen = typeof forceOpen === "boolean" ? forceOpen : !sidebar.classList.contains("open");
    sidebar.classList.toggle("open", willOpen);
    overlay.classList.toggle("show", willOpen);
}

function centerMap() { if (currentPos) map.panTo(currentPos); }

function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(function() { saveTimer = null; compactPathData(); persistState(); }, SAVE_DELAY_MS);
}

function persistState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            pathCoordinates: pathCoordinates.map(function(p) { return { lat: p.lat, lng: p.lng, startTime: p.startTime, endTime: p.endTime, visits: p.visits || 1 }; }),
            memories: memories.map(function(m) { return { id: m.id, lat: m.lat, lng: m.lng, name: m.name, time: m.time, dateString: m.dateString, timeString: m.timeString }; }),
            photos: photos.map(function(p) { return { id: p.id, lat: p.lat, lng: p.lng, time: p.time, dateString: p.dateString, timeString: p.timeString }; }),
            totalDistance: totalDistance
        }));
    } catch (e) {
        console.error("저장 실패", e);
        if (e && e.name === "QuotaExceededError") {
            alert("저장 공간이 부족합니다.\n오래된 발걸음 데이터를 정리하거나 사진을 일부 삭제해보세요.");
        }
    }
}

function loadState() {
    try {
        var raw = localStorage.getItem(STORAGE_KEY); if (!raw) return;
        var saved = JSON.parse(raw);
        if (Array.isArray(saved.pathCoordinates)) {
            pathCoordinates = saved.pathCoordinates
                .filter(function(p) { return isFinite(p.lat) && isFinite(p.lng) && isFinite(p.startTime) && isFinite(p.endTime); })
                .map(function(p) { return { lat: p.lat, lng: p.lng, startTime: p.startTime, endTime: p.endTime, visits: isFinite(p.visits) ? p.visits : 1 }; });
        }
        if (Array.isArray(saved.memories)) {
            memories = saved.memories
                .filter(function(m) { return isFinite(m.lat) && isFinite(m.lng) && typeof m.name === "string"; })
                .map(function(m) {
                    return {
                        id: typeof m.id === "string" ? m.id : String(m.time),
                        lat: m.lat, lng: m.lng, name: m.name, time: m.time,
                        dateString: m.dateString,
                        timeString: typeof m.timeString === "string" ? m.timeString
                            : new Date(m.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
                    };
                });
        }
        if (isFinite(saved.totalDistance)) totalDistance = saved.totalDistance;
        if (Array.isArray(saved.photos)) {
            photos = saved.photos.filter(function(p) { return isFinite(p.lat) && isFinite(p.lng) && p.id; });
        }
        var savedFog = localStorage.getItem(FOG_ENABLED_KEY);
        if (savedFog !== null) isFogEnabled = savedFog === "true";
        compactPathData();
    } catch (e) { console.error("복원 실패", e); }
}

// ── 사진 처리 ──
function processPhoto(img, now, lat, lng) {
    var popup = resizeImage(img, 200);
    var thumb = resizeImage(img, 40);
    var id = String(now.getTime()) + Math.random().toString(36).slice(2);
    var data = {
        id: id, lat: lat, lng: lng,
        photo: popup, thumb: thumb,
        time: now.getTime(),
        dateString: now.toLocaleDateString("ko-KR", { year:"numeric", month:"long", day:"numeric" }),
        timeString: now.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit" })
    };
    photos.push(data);
    idbSavePhoto(id, popup, thumb).catch(function(e) { console.warn("IDB 저장 실패", e); });
    createPhotoMarker(data, true);
    updateStats(); scheduleSave(); updatePhotoList();
}

function handlePhotos(event) {
    var files = Array.from(event.target.files);
    if (!files.length) return;
    var processed = 0;

    var finishOne = function() {
        processed++;
        if (processed === files.length) {
            updateStats(); scheduleSave(); updatePhotoList();
            event.target.value = "";
        }
    };

    files.forEach(function(file) {
        EXIF.getData(file, function() {
            var lat = null, lng = null;
            var latVal = EXIF.getTag(this, "GPSLatitude");
            var latRef = EXIF.getTag(this, "GPSLatitudeRef");
            var lngVal = EXIF.getTag(this, "GPSLongitude");
            var lngRef = EXIF.getTag(this, "GPSLongitudeRef");

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
                    var center = map.getCenter();
                    lat = center.lat;
                    lng = center.lng;
                }
            }

            var reader = new FileReader();
            reader.onload = function(e) {
                var now = new Date();
                var img = new Image();
                img.onerror = function() {
                    fetch(e.target.result)
                        .then(function(r) { return r.blob(); })
                        .then(function(blob) {
                            if (typeof heic2any !== "undefined") {
                                return heic2any({ blob: blob, toType: "image/jpeg", quality: 0.85 });
                            }
                            throw new Error("heic2any 없음");
                        })
                        .then(function(jpegBlob) {
                            var url = URL.createObjectURL(jpegBlob);
                            var img2 = new Image();
                            img2.onload = function() {
                                processPhoto(img2, now, lat, lng);
                                finishOne();
                                URL.revokeObjectURL(url);
                            };
                            img2.src = url;
                        })
                        .catch(function() {
                            finishOne();
                        });
                };
                img.onload = function() {
                    processPhoto(img, now, lat, lng);
                    finishOne();
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    });
}

function resizeImage(img, maxSize) {
    var canvas = document.createElement("canvas");
    var w = img.width, h = img.height;
    if (w > h && w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; }
    else if (h > maxSize)     { w = Math.round(w * maxSize / h); h = maxSize; }
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.7);
}

function createPhotoMarker(data, openPopup) {
    var size = getPhotoMarkerSize();
    var marker = L.marker([data.lat, data.lng], {
        pane: "photoPane",
        icon: L.divIcon({
            className: "photo-marker",
            html: '<img src="' + data.thumb + '" style="width:' + size + 'px;height:' + size + 'px;object-fit:cover;border-radius:6px;border:2px solid #fff;" />',
            iconSize: [size, size],
            iconAnchor: [size / 2, size]
        })
    });
    marker._photoData = data;
    var popupEl = document.createElement("div"); popupEl.className = "photo-popup";
    var img = document.createElement("img"); img.src = data.photo;
    img.style.cssText = "width:200px;border-radius:8px;margin-bottom:8px;display:block;";
    var info = document.createElement("div");
    info.style.cssText = "font-size:12px;color:rgba(255,255,255,0.6);text-align:center;margin:6px 0 8px;";
    info.textContent = data.dateString + " " + data.timeString;
    var delBtn = document.createElement("button"); delBtn.className = "popup-delete-btn"; delBtn.textContent = "사진 삭제";
    delBtn.addEventListener("click", function() { deletePhoto(data.id); marker.closePopup(); });
    popupEl.appendChild(img); popupEl.appendChild(info); popupEl.appendChild(delBtn);
    marker.bindPopup(popupEl);
    photoClusterGroup.addLayer(marker);
    if (openPopup) marker.openPopup();
}

function deletePhoto(id) {
    photos = photos.filter(function(p) { return p.id !== id; });
    var marker = findPhotoMarker(id);
    if (marker) photoClusterGroup.removeLayer(marker);
    idbDeletePhoto(id).catch(function(e) { console.warn("IDB 삭제 실패", e); });
    updateStats(); scheduleSave();
}

function escapeHtml(value) {
    return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function renderStoredMarkers() { memories.forEach(function(m) { createMemoryMarker(m, false); }); }
function renderStoredPhotoMarkers() {
    if (photos.length === 0) return;
    idbGetAllPhotos().then(function(idbList) {
        var idbMap = new Map(idbList.map(function(r) { return [r.id, r]; }));
        photos.forEach(function(p) {
            var img = idbMap.get(p.id);
            if (img) {
                p.photo = img.photo;
                p.thumb = img.thumb;
                createPhotoMarker(p, false);
            }
        });
    }).catch(function(e) { console.warn("IDB 불러오기 실패", e); });
}

function initGpxDial() { dialHours = 12; updateDialUI(); }

function initHudTapTargets() {
    var distItem  = document.querySelector(".hud-prog-item:nth-child(1)");
    var memItem   = document.querySelector(".hud-prog-item:nth-child(2)");
    var photoItem = document.querySelector(".hud-prog-item:nth-child(3)");
    if (distItem) {
        distItem.style.cursor = "pointer";
        distItem.addEventListener("click", function() { toggleSidebar(true); switchTab("gpx"); });
    }
    if (memItem) {
        memItem.style.cursor = "pointer";
        memItem.addEventListener("click", function() { toggleSidebar(true); switchTab("memory"); });
    }
    if (photoItem) {
        photoItem.style.cursor = "pointer";
        photoItem.addEventListener("click", function() { toggleSidebar(true); switchTab("photo"); });
    }
}

function init() {
    resizeCanvas();
    loadState();
    loadBonusState();
    renderStoredMarkers();
    renderStoredPhotoMarkers();
    updateStats();
    updateMemoryList();
    syncRecordingUI();
    syncFogButton();
    scheduleRender();
    initGpxDial();
    initHudTapTargets();

    setTimeout(function() {
        if (!isRecording) toggleRecording();
    }, 5000);
}

map.whenReady(function() { init(); });

// ── TourAPI 관광지 추천 ──
var TOUR_API_KEY = "c6995449e23f94083d88f198fe2617a8f957a2063bc6ac0d19816c9f27a0ed6c";
var TOUR_ENDPOINT = "https://apis.data.go.kr/B551011/KorService2/locationBasedList2";
var tourItems = [];
var tourExpanded = false;
var tourPanelOpen = false;
var tourFetchTimer = null;
var tourMarkers = [];
var TOUR_VISIBLE_COUNT = 3;

var TOUR_TYPE_NAMES = {
    "12": "관광지", "14": "문화시설", "15": "축제/행사",
    "25": "여행코스", "28": "레포츠", "32": "숙박",
    "38": "쇼핑", "39": "음식점"
};
var TOUR_COLORS = [
    "#ff6b6b","#ffd93d","#6bcb77","#ff922b",
    "#cc5de8","#20c997","#f06595","#a9e34b",
    "#ff8787","#ffe066","#63e6be","#ffa94d",
    "#e599f7","#38d9a9","#f783ac","#c0eb75",
    "#ff6b9d","#ffb347","#7bed9f","#ff4757"
];

function fetchTourSpots() {
    var bounds = map.getBounds();
    var center = map.getCenter();
    var ne = bounds.getNorthEast();
    var radiusM = Math.round(center.distanceTo(ne));
    radiusM = Math.max(500, Math.min(radiusM, 20000));

    var listEl = document.getElementById("tour-list");
    var loadingEl = document.getElementById("tour-loading");
    var emptyEl = document.getElementById("tour-empty");
    var expandBtn = document.getElementById("tour-expand-btn");
    var countEl = document.getElementById("tour-count");

    if (!listEl || !loadingEl || !emptyEl || !expandBtn || !countEl) return;

    // 패널이 닫혀있으면 데이터만 받고 렌더링 안 함
    listEl.innerHTML = "";
    expandBtn.style.display = "none";
    emptyEl.style.display = "none";

    var url = TOUR_ENDPOINT
        + "?serviceKey=" + TOUR_API_KEY
        + "&mapX=" + center.lng.toFixed(6)
        + "&mapY=" + center.lat.toFixed(6)
        + "&radius=" + radiusM
        + "&numOfRows=20&pageNo=1"
        + "&MobileOS=ETC&MobileApp=Giloa"
        + "&_type=json&arrange=E";

    fetch(url)
        .then(function(res) { return res.json(); })
        .then(function(data) {
            loadingEl.style.display = "none";
            var body = data && data.response && data.response.body;
            var items = [];
            if (body && body.items && body.items.item) {
                items = Array.isArray(body.items.item) ? body.items.item : [body.items.item];
                items = items.filter(function(item) { return item.contenttypeid !== "39"; });
            }

            clearTourMarkers();
            tourItems = items;
            countEl.textContent = items.length + "곳";

            if (tourPanelOpen) {
                if (items.length === 0) {
                    emptyEl.style.display = "";
                } else {
                    renderTourCards();
                }
            }
        })
        .catch(function(err) {
            loadingEl.style.display = "none";
            if (tourPanelOpen) {
                emptyEl.style.display = "";
                emptyEl.textContent = "불러오기 실패";
            }
            countEl.textContent = "";
            console.warn("TourAPI 에러", err);
        });
}

function renderTourCards() {
    var listEl = document.getElementById("tour-list");
    var expandBtn = document.getElementById("tour-expand-btn");
    if (!listEl || !expandBtn) return;
    listEl.innerHTML = "";

    var center = map.getCenter();
    var showCount = tourItems.length;  // 패널 열리면 전체 표시

    for (var i = 0; i < showCount; i++) {
        (function(item, idx) {
            var color = TOUR_COLORS[idx % TOUR_COLORS.length];

            var card = document.createElement("div");
            card.className = "tour-card";
            card.style.display = "flex";
            card.style.alignItems = "flex-start";
            card.style.gap = "8px";

            var dot = document.createElement("div");
            dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:" + color + ";flex-shrink:0;margin-top:3px;box-shadow:0 0 6px " + color + "99;";

            var textWrap = document.createElement("div");
            textWrap.style.cssText = "flex:1;min-width:0;";

            var nameEl = document.createElement("div");
            nameEl.className = "tour-card-name";
            nameEl.textContent = item.title || "이름 없음";

            var typeEl = document.createElement("div");
            typeEl.className = "tour-card-type";
            typeEl.textContent = TOUR_TYPE_NAMES[item.contenttypeid] || "관광";

            var distEl = document.createElement("div");
            distEl.className = "tour-card-dist";
            var distM = center.distanceTo([parseFloat(item.mapy), parseFloat(item.mapx)]);
            distEl.textContent = distM < 1000 ? Math.round(distM) + "m" : (distM / 1000).toFixed(1) + "km";

            textWrap.appendChild(nameEl);
            textWrap.appendChild(typeEl);
            textWrap.appendChild(distEl);

            card.appendChild(dot);
            card.appendChild(textWrap);

            card.addEventListener("click", function() {
                var lat = parseFloat(item.mapy);
                var lng = parseFloat(item.mapx);
                map.flyTo([lat, lng], 17);
                showTourPopup(item, color);
                // 해당 마커 강조
                if (tourMarkers[idx]) {
                    tourMarkers[idx].setRadius(13);
                    setTimeout(function() {
                        if (tourMarkers[idx]) tourMarkers[idx].setRadius(7);
                    }, 1500);
                }
            });

            listEl.appendChild(card);
        })(tourItems[i], i);
    }


    addTourMarkers();
}

function toggleTourPanel() {
    tourPanelOpen = !tourPanelOpen;
    var listEl = document.getElementById("tour-list");
    var emptyEl = document.getElementById("tour-empty");
    var expandBtn = document.getElementById("tour-expand-btn");
    var headerEl = document.getElementById("tour-header");

    if (tourPanelOpen) {
        headerEl.style.borderBottomLeftRadius = "0";
        headerEl.style.borderBottomRightRadius = "0";
        if (tourItems.length === 0) {
            emptyEl.style.display = "";
        } else {
            renderTourCards();
        }
    } else {
        if (listEl) listEl.innerHTML = "";
        if (emptyEl) emptyEl.style.display = "none";
        if (expandBtn) expandBtn.style.display = "none";
        headerEl.style.borderBottomLeftRadius = "10px";
        headerEl.style.borderBottomRightRadius = "10px";
        clearTourMarkers();
    }
}

function showTourPopup(item, color) {
    var lat = parseFloat(item.mapy);
    var lng = parseFloat(item.mapx);
    var typeName = TOUR_TYPE_NAMES[item.contenttypeid] || "관광";
    var addr = item.addr1 || "";
    var dotColor = color || "#78dc8c";
    var popupHtml = '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + dotColor + ';margin-right:6px;vertical-align:middle;"></span>'
        + "<b>" + escapeHtml(item.title || "") + "</b><br>"
        + '<small style="color:' + dotColor + ';">' + typeName + "</small><br>"
        + '<small>' + escapeHtml(addr) + "</small>";
    L.popup({ className: "tour-popup" })
        .setLatLng([lat, lng])
        .setContent(popupHtml)
        .openOn(map);
}

function clearTourMarkers() {
    tourMarkers.forEach(function(m) { map.removeLayer(m); });
    tourMarkers = [];
}

function addTourMarkers() {
    clearTourMarkers();
   
    // 관광지 전용 pane이 없으면 생성 (안개 위, z-index 620)
    if (!map.getPane("tourPane")) {
        map.createPane("tourPane");
        map.getPane("tourPane").style.zIndex = "620";
        map.getPane("tourPane").style.pointerEvents = "auto";
    }

    
    tourItems.forEach(function(item, idx) {
        var lat = parseFloat(item.mapy);
        var lng = parseFloat(item.mapx);
        if (!isFinite(lat) || !isFinite(lng)) return;
        var color = TOUR_COLORS[idx % TOUR_COLORS.length];
        item._color = color;  // 카드 렌더링 때 참조
        var marker = L.circleMarker([lat, lng], {
            pane: "tourPane",
            radius: 7,
            color: "#fff",
            fillColor: color,
            fillOpacity: 0.9,
            weight: 1.5,
            opacity: 0.95
        }).addTo(map);
        marker._tourIdx = idx;
        marker.on("click", function() { showTourPopup(item, color); });
        // 호버 시 마커 강조
        marker.on("mouseover", function() { marker.setRadius(11); });
        marker.on("mouseout",  function() { marker.setRadius(7);  });
        tourMarkers.push(marker);
    });
}

function scheduleTourFetch() {
    if (tourFetchTimer) clearTimeout(tourFetchTimer);
    tourFetchTimer = setTimeout(function() {
        tourFetchTimer = null;
        tourExpanded = false;
        fetchTourSpots();
    }, 1200);
}

map.on("moveend", scheduleTourFetch);
scheduleTourFetch();
