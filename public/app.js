/* 我的轨迹 — 前端逻辑 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'tt_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let currentUser = null;
  let trips = [];
  let customLogos = {}; // 航司代码 → 用户手动指定的 logo 地址；为空时用 Kiwi 自动匹配
  let airports = [];
  let airportByIata = {};
  let stations = [];
  let map = null;
  let routeLayer = null;
  let leaderLayer = null; // 标签到站点的引导线图层
  let tripType = 'flight';
  let editingId = null;

  // ---------- 工具 ----------
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3200);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDateOnly(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '未注明日期';
    const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${w}`;
  }
  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    const data = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
    if (!res.ok && !data.error) data.error = '请求失败（' + res.status + '）';
    return data;
  }
  function authHeaders() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  }
  function setAuth(t) {
    token = t || '';
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  // ---------- 视图切换 ----------
  function showView(name) {
    $('auth-view').classList.toggle('hidden', name !== 'auth');
    $('main-view').classList.toggle('hidden', name !== 'main');
  }
  function showAuthPanel(panel) {
    ['login-form', 'register-form', 'verify-form', 'forgot-form', 'reset-form'].forEach((id) => {
      $(id).classList.add('hidden');
    });
    $(panel).classList.remove('hidden');
    $('tab-login').classList.toggle('active', panel === 'login-form');
    $('tab-register').classList.toggle('active', panel === 'register-form' || panel === 'verify-form');
  }
  $('tab-login').addEventListener('click', () => showAuthPanel('login-form'));
  $('tab-register').addEventListener('click', () => showAuthPanel('register-form'));
  $('show-forgot').addEventListener('click', () => showAuthPanel('forgot-form'));
  $('back-to-login').addEventListener('click', () => showAuthPanel('login-form'));
  $('back-to-login-2').addEventListener('click', () => showAuthPanel('login-form'));
  $('back-to-register').addEventListener('click', () => showAuthPanel('register-form'));

  // ---------- 深色模式（设置页里切换） ----------
  const savedTheme = localStorage.getItem('tt_theme');
  if (savedTheme === 'dark') {
    document.body.classList.add('dark');
    $('theme-ico').textContent = '☀️';
    $('theme-label').textContent = '浅色模式';
  }
  $('theme-toggle').addEventListener('click', () => {
    const dark = document.body.classList.toggle('dark');
    $('theme-ico').textContent = dark ? '☀️' : '🌙';
    $('theme-label').textContent = dark ? '浅色模式' : '深色模式';
    localStorage.setItem('tt_theme', dark ? 'dark' : 'light');
  });

  // ---------- 液态玻璃透明度（设置页滑杆，无级调节） ----------
  const GLASS_KEY = 'tt_glass_opacity';
  const glassSlider = $('glass-opacity');
  const glassVal = $('glass-opacity-val');
  function applyGlassOpacity(pct) {
    document.documentElement.style.setProperty('--glass-opacity', (pct / 100).toFixed(2));
    glassVal.textContent = pct + '%';
  }
  const savedGlass = localStorage.getItem(GLASS_KEY);
  const initialGlass = savedGlass !== null ? Math.max(0, Math.min(100, parseInt(savedGlass, 10) || 0)) : 12;
  glassSlider.value = String(initialGlass);
  applyGlassOpacity(initialGlass);
  glassSlider.addEventListener('input', () => {
    const pct = parseInt(glassSlider.value, 10);
    applyGlassOpacity(pct);
    localStorage.setItem(GLASS_KEY, String(pct));
  });

  // ---------- 地图源切换（设置页自定义下拉框：原生 select 的展开列表是系统样式改不了，所以用按钮 + 列表自己画；存在本地，切换后立即换底图） ----------
  const MAP_SOURCE_LABELS = { amap: '高德地图', osm: 'OpenStreetMap' };
  const mapSourceWrap = $('map-source-select');
  const mapSourceBtn = $('map-source-btn');
  const mapSourceLabel = $('map-source-label');
  const mapSourceList = $('map-source-list');
  function renderMapSourceDropdown(src) {
    mapSourceLabel.textContent = MAP_SOURCE_LABELS[src] || MAP_SOURCE_LABELS.amap;
    mapSourceList.querySelectorAll('.custom-select-option').forEach((opt) => {
      const on = opt.dataset.value === src;
      opt.classList.toggle('selected', on);
      opt.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  function setMapSource(src) {
    src = src === 'osm' ? 'osm' : 'amap';
    localStorage.setItem('tt_map_source', src);
    applyMapSource(src);
    renderMapSourceDropdown(src);
    toast(src === 'osm' ? '已切换到 OpenStreetMap' : '已切换到高德地图');
  }
  function closeMapSourceDropdown() {
    mapSourceList.hidden = true;
    mapSourceBtn.setAttribute('aria-expanded', 'false');
  }
  renderMapSourceDropdown(getMapSource());
  mapSourceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = mapSourceList.hidden;
    mapSourceList.hidden = !willOpen;
    mapSourceBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  mapSourceList.addEventListener('click', (e) => {
    const opt = e.target.closest('.custom-select-option');
    if (!opt) return;
    setMapSource(opt.dataset.value);
    closeMapSourceDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!mapSourceWrap.contains(e.target)) closeMapSourceDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMapSourceDropdown();
  });

  // ---------- 密码显示 / 隐藏开关（登录、注册、重置密码三个密码框） ----------
  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    });
  });

  // ---------- 显示地名开关（设置页复选框，存在本地） ----------
  // 打开：地图自带地名正常显示；关闭：底图换成无地名的干净底图，只留轨迹两端的地名标签
  const showLabelsBox = $('show-labels');
  showLabelsBox.checked = getShowLabels();
  showLabelsBox.addEventListener('change', () => {
    localStorage.setItem('tt_show_labels', showLabelsBox.checked ? '1' : '0');
    applyMapSource(getMapSource());
    toast(showLabelsBox.checked ? '已显示地图地名' : '已隐藏地图地名，只留轨迹地名');
  });

  // ---------- 认证 ----------
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    const email = $('login-email').value.trim();
    const password = $('login-password').value;
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (!data.ok) {
      $('login-error').textContent = data.error || '登录失败';
      return;
    }
    setAuth(data.token);
    currentUser = data.user;
    toast('登录成功');
    await enterMain();
  });

  $('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('reg-error').textContent = '';
    const email = $('reg-email').value.trim();
    const password = $('reg-password').value;
    const name = $('reg-name').value.trim();
    if (password.length < 8) {
      $('reg-error').textContent = '密码至少需要 8 位';
      return;
    }
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
    if (!data.ok) {
      $('reg-error').textContent = data.error || '注册失败';
      return;
    }
    // 第一个注册的用户即管理员，无需邮箱验证，可直接登录
    if (data.firstUser) {
      toast(data.message || '注册成功，可直接登录');
      $('login-email').value = email;
      showAuthPanel('login-form');
      return;
    }
    $('verify-email-text').textContent = email;
    $('verify-email-text').dataset.email = email;
    showAuthPanel('verify-form');
    toast(data.message || '验证码已发送');
  });

  $('verify-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('verify-error').textContent = '';
    const email = $('verify-email-text').dataset.email;
    const code = $('verify-code').value.trim();
    const data = await api('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    });
    if (!data.ok) {
      $('verify-error').textContent = data.error || '验证失败';
      return;
    }
    toast('邮箱验证成功，请登录');
    $('login-email').value = email;
    showAuthPanel('login-form');
  });

  $('forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('forgot-error').textContent = '';
    const email = $('forgot-email').value.trim();
    const data = await api('/api/auth/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (!data.ok) {
      $('forgot-error').textContent = data.error || '发送失败';
      return;
    }
    $('reset-email-text').textContent = email;
    $('reset-email-text').dataset.email = email;
    showAuthPanel('reset-form');
    toast(data.message || '验证码已发送');
  });

  $('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('reset-error').textContent = '';
    const email = $('reset-email-text').dataset.email;
    const code = $('reset-code').value.trim();
    const newPassword = $('reset-password').value;
    if (newPassword.length < 8) {
      $('reset-error').textContent = '新密码至少需要 8 位';
      return;
    }
    const data = await api('/api/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ email, code, newPassword }),
    });
    if (!data.ok) {
      $('reset-error').textContent = data.error || '重置失败';
      return;
    }
    toast('密码已重置，请使用新密码登录');
    $('login-email').value = email;
    showAuthPanel('login-form');
  });

  function doLogout(msg) {
    setAuth('');
    currentUser = null;
    trips = [];
    showView('auth');
    showAuthPanel('login-form');
    toast(msg || '已退出登录');
  }
  $('logout-btn').addEventListener('click', () => doLogout('已退出登录'));
  $('switch-user-btn').addEventListener('click', () => doLogout('已退出登录，请用其他账号登录'));

  // ---------- 地图 ----------
  // 地图源存在本地（每台设备各自选）：amap 高德 / osm OpenStreetMap。
  function getMapSource() {
    return localStorage.getItem('tt_map_source') || 'amap';
  }
  // 地名开关：默认显示；存在本地 tt_show_labels（'0' = 隐藏）
  function getShowLabels() {
    return localStorage.getItem('tt_show_labels') !== '0';
  }
  // 底图按「地图源 × 显示地名」组合：开 = 正常带地名的底图（卫星图另叠一层地名标注）；
  // 关 = 换成无地名的干净底图（标准图用 Esri 深灰底图——浅灰底图太淡，道路几乎看不见；
  // 卫星图本身无地名），轨迹两端的地名标签不受影响。
  // OSM 源只有「标准地图 / 卫星地图」两种底图。
  function buildLayers(source) {
    const showLabels = getShowLabels();
    if (source === 'osm') {
      if (showLabels) {
        return {
          base: {
            '标准地图': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }),
            '卫星地图': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
          },
          overlay: {
            '地名标注': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
          },
          defaultBase: '标准地图',
          autoLabel: '地名标注',
          satelliteBase: '卫星地图',
        };
      }
      return {
        base: {
          '标准地图': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
          '卫星地图': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
        },
        overlay: {},
        defaultBase: '标准地图',
        autoLabel: null,
        satelliteBase: '卫星地图',
      };
    }
    if (showLabels) {
      return {
        base: {
          '高德标准': L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}', { subdomains: '1234', maxZoom: 18 }),
          '高德卫星': L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', { subdomains: '1234', maxZoom: 18 }),
        },
        overlay: {
          '路网标注': L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}', { subdomains: '1234', maxZoom: 18 }),
        },
        defaultBase: '高德标准',
        autoLabel: '路网标注',
        satelliteBase: '高德卫星',
      };
    }
    return {
      base: {
        '高德标准': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
        '高德卫星': L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', { subdomains: '1234', maxZoom: 18 }),
      },
      overlay: {},
      defaultBase: '高德标准',
      autoLabel: null,
      satelliteBase: '高德卫星',
    };
  }
  let layerControl = null;
  let currentLayers = null;
  let currentBaseName = '';
  // 当前底图是不是深灰底图（地名关 + 标准图）：深灰底图上黑线看不见，路线要换浅色
  function isDarkBase() {
    return !getShowLabels() && (currentBaseName === '标准地图' || currentBaseName === '高德标准');
  }
  function routeColors() {
    return isDarkBase()
      ? { flight: '#8ec2ff', train: '#ffffff' }
      : { flight: '#2f7bff', train: '#000000' };
  }
  function initMap() {
    if (map) return;
    map = L.map('map', { worldCopyJump: true, zoomControl: false, attributionControl: false }).setView([35, 105], 3);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    applyMapSource(getMapSource());
    routeLayer = L.layerGroup().addTo(map);
    leaderLayer = L.layerGroup().addTo(map);
    map.on('click', () => {
      showPanel(null);
    });
    // 缩放 / 尺寸变化会改变标签重叠情况，重算防重叠并重画引导线
    // （平移不改变相对位置，moveend 里一起覆盖）
    map.on('moveend', () => requestAnimationFrame(relayoutLabels));
    map.on('resize', () => requestAnimationFrame(relayoutLabels));
  }
  // 切换地图源：拆掉旧底图/标注，换上新源的底图（默认第一张），重建图层切换器
  function applyMapSource(source) {
    if (!map) return;
    const layers = buildLayers(source);
    if (currentLayers) {
      Object.values(currentLayers.base).forEach((l) => map.removeLayer(l));
      Object.values(currentLayers.overlay).forEach((l) => map.removeLayer(l));
      if (layerControl) { map.removeControl(layerControl); layerControl = null; }
    }
    currentLayers = layers;
    layers.base[layers.defaultBase].addTo(map);
    currentBaseName = layers.defaultBase;
    layerControl = L.control.layers(layers.base, null, { position: 'topright', collapsed: true }).addTo(map);
    map.off('baselayerchange');
    // 卫星图本身没有地名：地名开时，切到卫星图自动叠加地名标注层；切回标准图时自动去掉
    if (layers.autoLabel) {
      map.on('baselayerchange', (e) => {
        currentBaseName = e.name;
        if (e.name === layers.satelliteBase) layers.overlay[layers.autoLabel].addTo(map);
        else map.removeLayer(layers.overlay[layers.autoLabel]);
        drawRoutes(false);
      });
    } else {
      // 地名关时没有标注层要管，但切标准/卫星图会改变底图明暗，路线颜色要跟着重画
      map.on('baselayerchange', (e) => {
        currentBaseName = e.name;
        drawRoutes(false);
      });
    }
    // 换了地图源，坐标系也可能变了（高德 GCJ-02 / OSM WGS-84），按新坐标系重画路线，不动当前视野
    drawRoutes(false);
  }
  // ---------- 面板与 Dock ----------
  const PANELS = ['panel-add', 'panel-list', 'panel-stats', 'settings-card'];
  function showPanel(id) {
    PANELS.forEach((pid) => $(pid).classList.add('hidden'));
    document.querySelectorAll('.dock-btn[data-panel]').forEach((b) => b.classList.remove('active'));
    if (id) {
      $(id).classList.remove('hidden');
      const btn = document.querySelector(`.dock-btn[data-panel="${id}"]`);
      if (btn) btn.classList.add('active');
      if (id === 'settings-card') loadSettings();
      if (map) setTimeout(() => map.invalidateSize(), 50);
    }
  }
  document.querySelectorAll('.dock-btn[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.panel;
      const isActive = btn.classList.contains('active');
      showPanel(isActive ? null : id);
    });
  });
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => showPanel(null));
  });
  // 飞行弧线：用中点垂向偏移近似大圆弧线
  // offsetFactor 越大弧度越大；同一对地点多条线路时依次增大弧度，画成平行弧线
  function arcPoints(a, b, segments, offsetFactor = 0.18) {
    const midLat = (a[0] + b[0]) / 2;
    const midLon = (a[1] + b[1]) / 2;
    const dLat = b[0] - a[0];
    const dLon = b[1] - a[1];
    const dist = Math.sqrt(dLat * dLat + dLon * dLon) || 1;
    const off = dist * offsetFactor;
    const mx = midLat + (-dLon / dist) * off;
    const my = midLon + (dLat / dist) * off;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const lat = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * mx + t * t * b[0];
      const lon = (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * my + t * t * b[1];
      pts.push([lat, lon]);
    }
    return pts;
  }
  // 地名标签防重叠：每条路线的两个端点标签都记在这里，画完后统一检测重叠、挪位置
  let labelMarkers = [];
  function drawRoutes(fit = true) {
    if (!map || !routeLayer) return;
    routeLayer.clearLayers();
    if (leaderLayer) leaderLayer.clearLayers();
    labelMarkers = [];
    // 同一个站是多条行程的端点时只标一次（比如犀浦站同时是两条线的终点）
    const seenEndpoints = new Set();
    const bounds = [];
    // 同一对地点 + 同类型 的多条线路：按出现顺序依次增大弧度，避免完全重叠
    const routeCount = new Map();
    trips.forEach((t) => {
      if (t.dep_lat == null || t.dep_lon == null || t.arr_lat == null || t.arr_lon == null) return;
      // 库里存的是 WGS-84，画线时按当前地图源换算（高德 → GCJ-02，OSM → 原样）
      const a = toMapCoords(t.dep_lat, t.dep_lon);
      const b = toMapCoords(t.arr_lat, t.arr_lon);
      const cols = routeColors();
      const color = t.type === 'flight' ? cols.flight : cols.train;
      const key = `${t.type}|${t.dep_lat},${t.dep_lon}|${t.arr_lat},${t.arr_lon}`;
      const k = routeCount.get(key) || 0;
      routeCount.set(key, k + 1);
      // 飞机：基础弧度 0.18，每多一条 +0.15；火车：第一条直线（0），之后每条 +0.12
      const offsetFactor = t.type === 'flight' ? 0.18 + k * 0.15 : k * 0.12;
      const pts = arcPoints(a, b, 40, offsetFactor);
      L.polyline(pts, { color, weight: 3, opacity: 0.85 }).addTo(routeLayer);
      // 端点画一个小圆点 + 地名文字标签（小圆角 pill）；标签被防重叠挪开后，靠圆点和引导线认出是哪个站
      // 标签上不显示机场代码：手动填的“全称 (CODE)”、以及历史遗留的带代码名字
      // （如“合肥新桥国际机场 (HFE)”）在显示时都去掉末尾的“ (CODE)”，只留全称。
      const labelName = (name) => String(name || '').replace(/\s*\([A-Za-z0-9]{2,4}\)\s*$/, '');
      const labelMarker = (latlon, name) => {
        const key = latlon.join(',');
        if (seenEndpoints.has(key)) return;
        seenEndpoints.add(key);
        // 圆点标出站点的真实位置（白边 + 路线色，亮底深底都看得见）
        L.circleMarker(latlon, { radius: 4.5, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(routeLayer);
        const m = L.marker(latlon, {
          icon: L.divIcon({ className: 'place-label-marker', html: '', iconSize: [0, 0] }),
          interactive: false,
        })
          .bindTooltip(name, { permanent: true, direction: 'bottom', offset: [0, 8], className: 'place-label-tip' })
          .addTo(routeLayer);
        m._labelPlace = 'bottom:0,8';
        m._leaderColor = color;
        labelMarkers.push(m);
        return m;
      };
      labelMarker(a, labelName(t.dep_name));
      labelMarker(b, labelName(t.arr_name));
      bounds.push(a, b);
    });
    const flightCount = trips.filter((t) => t.type === 'flight').length;
    const trainCount = trips.filter((t) => t.type === 'train').length;
    // 提示里带颜色示意：一小段航线色和一小段铁路线色，与地图上的线同色（深灰底图上是浅蓝/白）
    const cols = routeColors();
    map.getContainer().classList.toggle('dark-base', isDarkBase());
    $('map-hint').innerHTML =
      trips.length === 0
        ? '还没有行程，点击下方「添加行程」记录第一条轨迹。'
        : `已加载 ${flightCount} 条航线<span class="legend-line" style="background:${cols.flight}"></span>，${trainCount} 条铁路线<span class="legend-line" style="background:${cols.train}"></span>。`;
    if (fit && bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
    requestAnimationFrame(relayoutLabels);
  }

  // ---------- 地名标签防重叠 ----------
  // 标签默认放在端点正下方；两个端点靠得近时 pill 会叠在一起（如都江堰站和青城山）。
  // 画完后检测重叠：按顺序保留先画的标签，后面的依次尝试上 / 左 / 右 / 斜角 / 远处等空位，
  // 放到第一个不重叠、且在地图框内的位置；实在没空位就保持默认正下方。
  // 平移不改变标签之间的相对位置，只有缩放 / 尺寸变化会改变重叠情况，所以只在 moveend（缩放结束也会触发）
  // 和 resize 后重算；换地图源、切底图都会重画路线，画完也会重算。
  function deoverlapLabels() {
    if (!map || !labelMarkers.length) return;
    const box = map.getContainer().getBoundingClientRect();
    const placed = [];
    const GAP = 4;
    const overlaps = (r) => placed.some((p) => r.left < p.right + GAP && r.right > p.left - GAP && r.top < p.bottom + GAP && r.bottom > p.top - GAP);
    for (const marker of labelMarkers) {
      const tip = marker.getTooltip && marker.getTooltip();
      if (!tip) continue;
      const el = tip.getElement();
      if (!el) continue;
      const pt = map.latLngToContainerPoint(marker.getLatLng());
      const w = el.offsetWidth, h = el.offsetHeight;
      if (!w || !h) continue;
      // 候选位置（方向 + 偏移）：先试正下方（现状），再试上 / 左 / 右 / 斜角 / 远处
      const candidates = [
        ['bottom', 0, 8], ['top', 0, -8], ['right', 8, 0], ['left', -8, 0],
        ['bottom', w / 2 + 4, 8], ['bottom', -w / 2 - 4, 8],
        ['top', w / 2 + 4, -8], ['top', -w / 2 - 4, -8],
        ['bottom', 0, h + 12], ['top', 0, -h - 12],
        ['right', 8, -h], ['right', 8, h], ['left', -8, -h], ['left', -8, h],
      ];
      let chosen = null;
      for (const [dir, dx, dy] of candidates) {
        let left, top;
        if (dir === 'bottom') { left = pt.x - w / 2 + dx; top = pt.y + dy; }
        else if (dir === 'top') { left = pt.x - w / 2 + dx; top = pt.y + dy - h; }
        else if (dir === 'right') { left = pt.x + dx; top = pt.y - h / 2 + dy; }
        else { left = pt.x + dx - w; top = pt.y - h / 2 + dy; }
        const r = { left, top, right: left + w, bottom: top + h };
        const inside = r.left >= 2 && r.top >= 2 && r.right <= box.width - 2 && r.bottom <= box.height - 2;
        if (inside && !overlaps(r)) { chosen = { dir, dx, dy, rect: r }; break; }
      }
      if (!chosen) {
        // 实在没空位：保持现状，把当前实际位置记下来，避免后面的标签再往这儿挤
        const cr = el.getBoundingClientRect();
        placed.push({ left: cr.left - box.left, top: cr.top - box.top, right: cr.right - box.left, bottom: cr.bottom - box.top });
        continue;
      }
      placed.push(chosen.rect);
      const placeKey = chosen.dir + ':' + chosen.dx + ',' + chosen.dy;
      if (marker._labelPlace === placeKey) continue;
      marker._labelPlace = placeKey;
      const name = tip.getContent();
      marker.unbindTooltip();
      marker.bindTooltip(name, { permanent: true, direction: chosen.dir, offset: [chosen.dx, chosen.dy], className: 'place-label-tip' });
    }
  }

  // 标签挪位后重画引导线（防重叠是同步改 tooltip，下一帧再量位置画线才准）
  function relayoutLabels() {
    deoverlapLabels();
    requestAnimationFrame(drawLeaders);
  }

  // 引导线：每个标签到它那个站点的圆点连一条细线，标签被挪开也能认出是哪个站
  function drawLeaders() {
    if (!map || !leaderLayer || !labelMarkers.length) return;
    leaderLayer.clearLayers();
    const box = map.getContainer().getBoundingClientRect();
    for (const marker of labelMarkers) {
      const tip = marker.getTooltip && marker.getTooltip();
      if (!tip) continue;
      const el = tip.getElement();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const w = r.width, h = r.height;
      if (!w || !h) continue;
      const cx = r.left - box.left + w / 2;
      const cy = r.top - box.top + h / 2;
      const pt = map.latLngToContainerPoint(marker.getLatLng());
      // 线只画到标签边上（从标签中心指向站点的射线与标签矩形的交点），不伸进标签底下
      const dx = pt.x - cx, dy = pt.y - cy;
      let ex = cx, ey = cy;
      if (dx || dy) {
        const tx = dx !== 0 ? (w / 2) / Math.abs(dx) : Infinity;
        const ty = dy !== 0 ? (h / 2) / Math.abs(dy) : Infinity;
        const t = Math.min(tx, ty);
        ex = cx + dx * t; ey = cy + dy * t;
      }
      const edgeLatLng = map.containerPointToLatLng([ex, ey]);
      L.polyline([marker.getLatLng(), edgeLatLng], { color: marker._leaderColor || '#666', weight: 1, opacity: 0.55 }).addTo(leaderLayer);
    }
  }

  // ---------- 行程列表 ----------
  // 列表按类型分开显示（全部 / 飞行 / 火车），与添加行程的切换按钮同款；
  // 飞行条目前面显示对应航司的小 logo（Kiwi），拿不到 logo 时回退到 ✈️。
  let listFilter = 'all'; // 'all' | 'flight' | 'train'
  function setListFilter(f) {
    listFilter = f;
    ['all', 'flight', 'train'].forEach((k) => $('list-filter-' + k).classList.toggle('active', k === f));
    renderTrips();
  }
  // 统计按类型分开显示（飞行 / 火车，不在同一页），与列表的切换按钮同款
  let statsType = 'flight'; // 'flight' | 'train'
  function setStatsType(t) {
    statsType = t;
    $('stats-type-flight').classList.toggle('active', t === 'flight');
    $('stats-type-train').classList.toggle('active', t === 'train');
    $('stats-flight').classList.toggle('hidden', t !== 'flight');
    $('stats-train').classList.toggle('hidden', t !== 'train');
  }
  function renderTrips() {
    const list = $('trip-list');
    list.innerHTML = '';
    const visible = trips.filter((t) => listFilter === 'all' || t.type === listFilter);
    if (!visible.length) {
      const emptyText =
        listFilter === 'flight' ? '还没有飞行记录。' :
        listFilter === 'train' ? '还没有火车行程。' :
        '还没有行程记录，先添加一条吧。';
      list.innerHTML = `<p class="empty-text">${emptyText}</p>`;
      return;
    }
    const groups = {};
    visible.forEach((t) => {
      const key = fmtDateOnly(t.dep_time);
      (groups[key] = groups[key] || []).push(t);
    });
    Object.keys(groups).forEach((date) => {
      const g = document.createElement('div');
      g.className = 'trip-group';
      g.innerHTML = `<h3>${date}</h3>`;
      groups[date].forEach((t) => {
        const logoUrl = t.type === 'flight' ? airlineLogoUrl(t.flight_number) : null;
        const logoCode = t.type === 'flight' ? airlineCodeOf(t.flight_number) : null;
        const iconHtml = logoUrl
          ? `<img class="trip-airline-logo" src="${logoUrl}" alt="" referrerpolicy="no-referrer" data-logo-code="${logoCode || ''}" title="点击修改 logo">`
          : (t.type === 'flight' ? '✈️' : '🚄');
        const code = t.type === 'flight' ? (t.flight_number || '') : (t.train_number || '');
        const route = `${t.dep_name}${t.dep_code ? ' (' + t.dep_code + ')' : ''} → ${t.arr_name}${t.arr_code ? ' (' + t.arr_code + ')' : ''}`;
        const meta = [code, t.airline, t.aircraft ? '机型 ' + t.aircraft : '', fmtDate(t.dep_time) + (t.arr_time ? ' — ' + fmtDate(t.arr_time) : ''), t.seat ? '座位 ' + t.seat : '']
          .filter(Boolean)
          .join(' · ');
        const item = document.createElement('div');
        item.className = 'trip-item';
        item.innerHTML =
          `<span class="trip-icon">${iconHtml}</span>` +
          `<div class="trip-body"><div class="trip-route">${escapeHtml(route)}</div>` +
          `<div class="trip-meta">${escapeHtml(meta)}</div>` +
          (t.notes ? `<div class="trip-notes">${escapeHtml(t.notes)}</div>` : '') +
          `</div>` +
          `<div class="trip-actions">` +
          `<button class="mini-btn" data-edit="${t.id}">编辑</button>` +
          `<button class="mini-btn danger" data-del="${t.id}">删除</button></div>`;
        g.appendChild(item);
      });
      list.appendChild(g);
    });
    // 航司 logo 加载失败时回退：手动指定的先回退到 Kiwi 自动匹配，再失败才回落到 ✈️
    list.querySelectorAll('.trip-airline-logo').forEach((img) => {
      const fallback = () => {
        const code = img.dataset.logoCode;
        if (code && img.src !== kiwiLogoUrl(code) && customLogos[code]) {
          img.src = kiwiLogoUrl(code);
          return;
        }
        const s = img.closest('.trip-icon');
        if (s) s.textContent = '✈️';
      };
      img.addEventListener('error', fallback);
      if (img.complete && img.naturalWidth === 0) fallback();
      img.addEventListener('click', () => {
        const code = img.dataset.logoCode;
        if (code) openLogoModal(code);
      });
    });
    list.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => startEdit(parseInt(btn.dataset.edit, 10)));
    });
    list.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => deleteTrip(parseInt(btn.dataset.del, 10)));
    });
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function deleteTrip(id) {
    if (!confirm('确定要删除这条行程吗？')) return;
    const res = await fetch('/api/trips/' + id, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      toast(data.error || '删除失败');
      return;
    }
    toast('已删除');
    await loadData();
  }

  // ---------- 添加 / 编辑行程 ----------
  function setType(type) {
    tripType = type;
    $('type-flight').classList.toggle('active', type === 'flight');
    $('type-train').classList.toggle('active', type === 'train');
    document.querySelectorAll('.field-flight-only').forEach((el) => el.classList.toggle('hidden', type !== 'flight'));
    document.querySelectorAll('.field-train-only').forEach((el) => el.classList.toggle('hidden', type !== 'train'));
    $('dep-label').textContent = type === 'flight' ? '出发机场' : '出发车站';
    $('arr-label').textContent = type === 'flight' ? '到达机场' : '到达车站';
    $('f-dep').placeholder = type === 'flight' ? '输入出发机场' : '输入出发车站';
    $('f-arr').placeholder = type === 'flight' ? '输入到达机场' : '输入到达车站';
  }
  $('type-flight').addEventListener('click', () => setType('flight'));
  $('type-train').addEventListener('click', () => setType('train'));
  $('list-filter-all').addEventListener('click', () => setListFilter('all'));
  $('list-filter-flight').addEventListener('click', () => setListFilter('flight'));
  $('list-filter-train').addEventListener('click', () => setListFilter('train'));
  $('stats-type-flight').addEventListener('click', () => setStatsType('flight'));
  $('stats-type-train').addEventListener('click', () => setStatsType('train'));

  // ---------- 航班查询：填航班号 + 出发日期，自动查起降机场 ----------
  // 把 "2026-11-15T08:00:00+00:00" 转成 datetime-local 要的 "2026-11-15T08:00"
  // （取航班当地时间，不做时区换算）
  function isoToLocalInput(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return m ? `${m[1]}T${m[2]}` : '';
  }
  function fillAirport(prefix, iata, fallbackName) {
    const ap = airportByIata[String(iata || '').toUpperCase()];
    if (ap) {
      $(`f-${prefix}`).value = `${ap.name} (${ap.code})`;
      return true;
    }
    // 不在内置机场列表里：显示“名字 (代码)”（如“合肥新桥 (HFE)”），坐标在保存时走高德地理编码
    const code = String(iata || '').toUpperCase();
    if (fallbackName && code) $(`f-${prefix}`).value = `${fallbackName} (${code})`;
    else if (fallbackName) $(`f-${prefix}`).value = fallbackName;
    else if (code) $(`f-${prefix}`).value = code;
    return false;
  }
  // 取一段航段的起降时间：实际时间优先，没有实际时间用计划时间，再没有用预计时间
  function pickFlightTime(seg) {
    return (seg && (seg.actual || seg.scheduled || seg.estimated)) || '';
  }
  // 用一段查询结果填表：起降机场、起降时间、航空公司 + 航司 logo
  function fillFlightOption(opt, cached) {
    const depOk = fillAirport('dep', opt.departure.iata, opt.departure.airport);
    const arrOk = fillAirport('arr', opt.arrival.iata, opt.arrival.airport);
    const depT = isoToLocalInput(pickFlightTime(opt.departure));
    const arrT = isoToLocalInput(pickFlightTime(opt.arrival));
    if (depT) $('f-dep-time').value = depT;
    if (arrT) $('f-arr-time').value = arrT;
    if (opt.airline) $('f-airline').value = opt.airline;
    if (opt.aircraft) $('f-aircraft').value = opt.aircraft;
    updateAirlineLogo();
    validateTimes();
    const missing = [];
    if (!depOk) missing.push('出发机场不在列表里，保存时自动查坐标');
    if (!arrOk) missing.push('到达机场不在列表里，保存时自动查坐标');
    const timeSrc = opt.departure.actual || opt.arrival.actual ? '实际' : (opt.departure.scheduled || opt.arrival.scheduled ? '计划' : '预计');
    toast(
      `已查到 ${opt.flight}（${opt.flight_date}）：${opt.departure.iata || '?'} → ${opt.arrival.iata || '?'}（${timeSrc}时间）${cached ? '（缓存）' : ''}` +
        (missing.length ? '；' + missing.join('；') : '')
    );
  }
  // 同一航班号一日多段：弹窗列出各段，让用户选一段再填表
  function showFlightOptions(flight, date, options, cached) {
    $('flight-modal-title').textContent = `选择航段：${flight}`;
    $('flight-modal-hint').textContent = `${flight} 在 ${date} 共有 ${options.length} 段，请选择你要记录的一段。`;
    const box = $('flight-options');
    box.innerHTML = '';
    options.forEach((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'flight-option';
      const depT = fmtDate(pickFlightTime(opt.departure));
      const arrT = fmtDate(pickFlightTime(opt.arrival));
      b.innerHTML =
        `<div class="opt-route">${opt.departure.iata} → ${opt.arrival.iata}</div>` +
        `<div class="opt-time">${opt.departure.airport} ${depT} → ${opt.arrival.airport} ${arrT}</div>` +
        (opt.airline ? `<div class="opt-airline">${opt.airline}</div>` : '') +
        (opt.aircraft ? `<div class="opt-airline">机型 ${opt.aircraft}</div>` : '');
      b.addEventListener('click', () => {
        closeFlightModal();
        fillFlightOption(opt, cached);
      });
      box.appendChild(b);
    });
    $('flight-modal').classList.remove('hidden');
  }
  function closeFlightModal() {
    $('flight-modal').classList.add('hidden');
  }
  $('flight-modal-close').addEventListener('click', closeFlightModal);
  $('flight-modal').addEventListener('click', (e) => {
    if (e.target === $('flight-modal')) closeFlightModal();
  });

  $('flight-lookup-btn').addEventListener('click', async () => {
    const flight = $('f-flight-number').value.trim().toUpperCase();
    if (!flight) {
      $('trip-error').textContent = '请先填写航班号，例如 CA1831';
      return;
    }
    // 只按航班号 + 出发时间里的日期部分查询，不带时间；没填出发时间就查今天
    const depTime = $('f-dep-time').value;
    const date = depTime ? depTime.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const btn = $('flight-lookup-btn');
    btn.disabled = true;
    btn.textContent = '查询中…';
    $('trip-error').textContent = '';
    try {
      const res = await fetch(
        `/api/flights/lookup?flight=${encodeURIComponent(flight)}&date=${encodeURIComponent(date)}`,
        { headers: authHeaders() }
      );
      const data = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
      if (!data.ok) {
        $('trip-error').textContent = data.error || '查询失败';
        return;
      }
      const options = Array.isArray(data.options) && data.options.length ? data.options : [data];
      if (options.length > 1) {
        showFlightOptions(flight, date, options, data.cached);
        toast(`已查到 ${flight}（${date}）${options.length} 段，请选择一段`);
      } else {
        fillFlightOption(options[0], data.cached);
      }
    } catch (e) {
      $('trip-error').textContent = '查询失败，请检查网络后重试';
    } finally {
      btn.disabled = false;
      btn.textContent = '🔍 查航班';
    }
  });

  // 根据输入文本匹配机场/车站，自动填经纬度
  function matchPlace(text) {
    if (!text) return null;
    const src = tripType === 'flight' ? airports : stations;
    const t = text.trim();
    if (!t) return null;
    // 1) 精确匹配（“都江堰站”、代码、或“名称 (CODE)”）
    const exact =
      src.find((p) => (tripType === 'flight' ? `${p.name} (${p.code})` === t : p.name === t)) ||
      src.find((p) => p.name === t) ||
      (tripType === 'flight' ? src.find((p) => p.code === t.toUpperCase()) : null);
    if (exact) return exact;
    // 2) 宽松匹配：去掉“站/机场”后缀再比（“都江堰”→“都江堰站”），或前缀匹配
    const norm = (s) => s.replace(/(站|机场)$/, '');
    const nq = norm(t);
    return (
      src.find((p) => norm(p.name) === nq) ||
      src.find((p) => p.name.startsWith(t) || t.startsWith(norm(p.name)))
    );
  }
  async function resolvePlace(text) {
    const m = matchPlace(text);
    if (m) return { name: m.name, code: m.code || '', lat: m.lat, lon: m.lon };
    // 不在内置库里：调用高德地理编码查真实坐标（需要管理员在设置里配高德 API Key）。
    // 查不到或未配置 Key 时仍保存行程，只是没有经纬度、地图上不画线。
    const name = text.trim();
    if (!name) return { name: '', code: '', lat: null, lon: null };
    // 去掉末尾的“ (CODE)”再去地理编码（“合肥新桥 (HFE)”→“合肥新桥”），否则高德查不到
    const geoName = name.replace(/\s*\([A-Z]{3}\)\s*$/, '');
    // 火车行程：站名后没带“站”时，搜索时自动补上（“青城山”→搜“青城山站”），
    // 否则高德会返回风景区/镇子而不是火车站；存库的名字仍按用户填的原样，不改。
    const queryName = tripType === 'train' && !/站$/.test(geoName) ? geoName + '站' : geoName;
    try {
      const r = await fetch('/api/places/geocode?name=' + encodeURIComponent(queryName), { headers: authHeaders() });
      const d = await r.json();
      // 高德地理编码返回的是 GCJ-02，存库前转回 WGS-84（库里统一存 WGS-84）
      if (d.ok) {
        const [wgsLng, wgsLat] = gcj02ToWgs84(Number(d.lon), Number(d.lat));
        return { name: geoName, code: '', lat: wgsLat, lon: wgsLng };
      }
    } catch (e) {
      // 解析失败时不阻塞保存
    }
    return { name: geoName, code: '', lat: null, lon: null };
  }

  // 航司 logo：取航班号前两位 IATA 代码（CA1831 → CA），优先用用户手动指定的 logo，
  // 没有手动指定时用 Kiwi 的免费航司 logo（64x64）自动匹配。
  // 识别到航司后自动显示在航空公司输入框右侧；没有对应 logo 时自动隐藏。
  // 行程列表里每条飞行记录前面也用同一张 logo。
  function airlineCodeOf(flightNumber) {
    const m = String(flightNumber || '').trim().toUpperCase().match(/^([A-Z0-9]{2})[0-9]/);
    return m ? m[1] : null;
  }
  // 维基百科 / 维基共享资源的文件页链接（…/wiki/File:xxx.svg）打开是网页、不是图片，
  // 直接当 <img> 用会显示空白；转成同站的 Special:FilePath 直链，浏览器跟随跳转后能正常显示。
  // 已保存的旧链接也在显示时自动转换，不用重新保存。
  function normalizeLogoUrl(url) {
    const u = String(url || '').trim();
    const m = u.match(/^https?:\/\/([a-z0-9-]+\.)?(wikipedia\.org|wikimedia\.org)\/wiki\/(?:File|Image):([^#?]+)/i);
    if (!m) return u;
    const host = (m[1] || '') + m[2];
    let name = m[3] || '';
    try { name = decodeURIComponent(name); } catch (e) { /* 保持原样 */ }
    name = name.replace(/ /g, '_');
    return `https://${host}/wiki/Special:FilePath/${encodeURIComponent(name)}`;
  }
  function airlineLogoUrl(flightNumber) {
    const code = airlineCodeOf(flightNumber);
    if (!code) return null;
    if (customLogos[code]) return normalizeLogoUrl(customLogos[code]);
    return `https://images.kiwi.com/airlines/64x64/${code}.png`;
  }
  function kiwiLogoUrl(code) {
    return `https://images.kiwi.com/airlines/64x64/${code}.png`;
  }
  function updateAirlineLogo() {
    const logo = $('airline-logo');
    const url = airlineLogoUrl($('f-flight-number').value);
    if (!url) {
      logo.classList.add('hidden');
      logo.removeAttribute('src');
      return;
    }
    logo.onerror = () => logo.classList.add('hidden');
    logo.onload = () => logo.classList.remove('hidden');
    logo.src = url;
  }
  $('f-flight-number').addEventListener('input', updateAirlineLogo);

  // ---------- 航司 logo 手动修改 ----------
  // 点行程列表里或表单里的小 logo 打开弹窗，粘贴图片地址保存后立即生效；
  // 留空保存或点“恢复自动匹配”则删掉手动指定，回到 Kiwi 自动匹配。
  let logoEditCode = null;
  function openLogoModal(code) {
    if (!code) return;
    logoEditCode = code;
    $('logo-modal-title').textContent = `修改航司 logo：${code}`;
    $('logo-modal-hint').textContent = customLogos[code]
      ? '当前是手动指定的 logo，清空后恢复自动匹配。'
      : '当前是自动匹配的 logo，粘贴图片地址或上传本地图片可手动指定。';
    $('logo-url').value = customLogos[code] && !customLogos[code].startsWith('data:') ? customLogos[code] : '';
    $('logo-file').value = '';
    $('logo-modal-error').textContent = '';
    updateLogoPreview();
    $('logo-modal').classList.remove('hidden');
    $('logo-url').focus();
  }
  function closeLogoModal() {
    $('logo-modal').classList.add('hidden');
    logoEditCode = null;
  }
  function updateLogoPreview() {
    const url = $('logo-url').value.trim();
    const img = $('logo-preview');
    if (!url) {
      img.removeAttribute('src');
      img.style.visibility = 'hidden';
      return;
    }
    img.style.visibility = 'visible';
    img.onerror = () => {
      img.style.visibility = 'hidden';
      $('logo-modal-error').textContent = '这张图片打不开：请确认贴的是图片直链（以 .png / .jpg / .svg 等结尾），而不是网页链接。';
    };
    img.onload = () => {
      img.style.visibility = 'visible';
      if ($('logo-modal-error').textContent.startsWith('这张图片打不开')) $('logo-modal-error').textContent = '';
    };
    img.src = normalizeLogoUrl(url);
  }
  // 本地上传：选图片后自动缩小到 128px 以内，转成 data URL 填进地址框并预览。
  // 支持 PNG、JPG、GIF、WebP、SVG、BMP、ICO 等常见图片格式。
  function handleLogoFile(file) {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
      $('logo-modal-error').textContent = '请选择图片文件（PNG、JPG、GIF、WebP、SVG 等）';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      $('logo-modal-error').textContent = '图片太大，请选 5MB 以内的图片';
      return;
    }
    $('logo-modal-error').textContent = '';
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // 等比缩小到最长边 128px（小图保持原尺寸），再转 data URL，控制保存体积
        const maxSide = 128;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        // SVG 没有位图尺寸，走原图 data URL；其他格式统一转 PNG
        const dataUrl = file.type === 'image/svg+xml' ? String(reader.result) : canvas.toDataURL('image/png');
        $('logo-url').value = dataUrl;
        updateLogoPreview();
      };
      img.onerror = () => {
        $('logo-modal-error').textContent = '这张图片读不出来，换一张试试';
      };
      img.src = String(reader.result);
    };
    reader.onerror = () => {
      $('logo-modal-error').textContent = '读取图片失败，换一张试试';
    };
    reader.readAsDataURL(file);
  }
  async function saveLogoOverride() {
    if (!logoEditCode) return;
    const url = normalizeLogoUrl($('logo-url').value.trim());
    const res = await fetch('/api/airline-logos', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ code: logoEditCode, url }),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      $('logo-modal-error').textContent = data.error || '保存失败';
      return;
    }
    if (url) customLogos[logoEditCode] = url;
    else delete customLogos[logoEditCode];
    toast(data.message || '已保存');
    closeLogoModal();
    renderTrips();
    updateAirlineLogo();
  }
  async function clearLogoOverride() {
    if (!logoEditCode) return;
    const res = await fetch('/api/airline-logos/' + encodeURIComponent(logoEditCode), {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      $('logo-modal-error').textContent = data.error || '操作失败';
      return;
    }
    delete customLogos[logoEditCode];
    toast(data.message || '已恢复自动匹配');
    closeLogoModal();
    renderTrips();
    updateAirlineLogo();
  }
  $('logo-modal-close').addEventListener('click', closeLogoModal);
  $('logo-modal').addEventListener('click', (e) => {
    if (e.target === $('logo-modal')) closeLogoModal();
  });
  $('logo-url').addEventListener('input', () => {
    $('logo-file').value = '';
    updateLogoPreview();
  });
  $('logo-file').addEventListener('change', (e) => {
    handleLogoFile(e.target.files && e.target.files[0]);
  });
  $('logo-save').addEventListener('click', saveLogoOverride);
  $('logo-clear').addEventListener('click', clearLogoOverride);
  // 表单里的小 logo 也可点：按当前航班号的航司代码改
  $('airline-logo').addEventListener('click', () => {
    const code = airlineCodeOf($('f-flight-number').value);
    if (code) openLogoModal(code);
  });

  // 到达时间不能早于出发时间（手动选也不行）：填表时实时提示，提交时拦截
  function validateTimes() {
    const dep = $('f-dep-time').value;
    const arr = $('f-arr-time').value;
    if (dep && arr && arr < dep) {
      $('trip-error').textContent = '到达时间不能早于出发时间';
      return false;
    }
    if ($('trip-error').textContent === '到达时间不能早于出发时间') $('trip-error').textContent = '';
    return true;
  }
  $('f-dep-time').addEventListener('change', validateTimes);
  $('f-arr-time').addEventListener('change', validateTimes);

  // 行程去重（与服务端同一规则）：同一类型、同一起降地（地名去末尾“站/机场”再比），
  // 双方都有班次号时同一天 + 同一班次号，至少一方无班次号时同一出发时刻；编辑时排除自身。
  function dupKey(t) {
    const normName = (s) => String(s || '').trim().replace(/(站|机场)$/, '');
    const num = t.type === 'flight'
      ? String(t.flight_number || '').trim().toUpperCase()
      : String(t.train_number || '').trim().toUpperCase();
    return {
      type: t.type,
      num,
      date: String(t.dep_time || '').slice(0, 10),
      dep: normName(t.dep_name),
      arr: normName(t.arr_name),
      depTime: String(t.dep_time || ''),
    };
  }
  function isDuplicateTrip(a, b) {
    if (a.type !== b.type || a.dep !== b.dep || a.arr !== b.arr) return false;
    if (a.num && b.num) return a.num === b.num && a.date === b.date;
    return a.depTime !== '' && a.depTime === b.depTime;
  }
  function findDuplicateTripLocal(fields, excludeId) {
    const key = dupKey(fields);
    return trips.find((r) => r.id !== excludeId && isDuplicateTrip(key, dupKey(r))) || null;
  }
  function dupLabel(t) {
    const num = t.type === 'flight' ? t.flight_number : t.train_number;
    const date = String(t.dep_time || '').slice(0, 10);
    return `${num ? num + ' ' : ''}${t.dep_name} → ${t.arr_name}（${date}）`;
  }

  $('trip-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('trip-error').textContent = '';
    if (!validateTimes()) return;
    const dep = await resolvePlace($('f-dep').value);
    const arr = await resolvePlace($('f-arr').value);
    if (!dep.name || !arr.name) {
      $('trip-error').textContent = '请填写出发地和目的地';
      return;
    }
    const depTime = $('f-dep-time').value;
    if (!depTime) {
      $('trip-error').textContent = '请填写出发时间';
      return;
    }
    const body = {
      type: tripType,
      flight_number: $('f-flight-number').value.trim(),
      airline: $('f-airline').value.trim(),
      aircraft: $('f-aircraft').value.trim(),
      train_number: $('f-train-number').value.trim(),
      seat: $('f-seat').value.trim(),
      dep_code: dep.code,
      dep_name: dep.name,
      dep_lat: dep.lat,
      dep_lon: dep.lon,
      arr_code: arr.code,
      arr_name: arr.name,
      arr_lat: arr.lat,
      arr_lon: arr.lon,
      dep_time: depTime,
      arr_time: $('f-arr-time').value || '',
      notes: $('f-notes').value.trim(),
    };
    const dup = findDuplicateTripLocal(body, editingId);
    if (dup) {
      $('trip-error').textContent = `已有相同行程：${dupLabel(dup)}，请勿重复添加`;
      return;
    }
    let res;
    if (editingId) {
      res = await fetch('/api/trips/' + editingId, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
    } else {
      res = await fetch('/api/trips', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
    }
    const data = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
    if (!data.ok) {
      $('trip-error').textContent = data.error || '保存失败';
      return;
    }
    toast(editingId ? '行程已更新' : '行程已保存');
    resetTripForm();
    await loadData();
    showPanel(null);
  });

  function startEdit(id) {
    const t = trips.find((x) => x.id === id);
    if (!t) return;
    editingId = id;
    setType(t.type);
    $('f-flight-number').value = t.flight_number || '';
    $('f-airline').value = t.airline || '';
    $('f-aircraft').value = t.aircraft || '';
    $('f-train-number').value = t.train_number || '';
    $('f-seat').value = t.seat || '';
    $('f-dep').value = t.dep_code ? `${t.dep_name} (${t.dep_code})` : t.dep_name;
    $('f-arr').value = t.arr_code ? `${t.arr_name} (${t.arr_code})` : t.arr_name;
    $('f-dep-time').value = toLocalInput(t.dep_time);
    $('f-arr-time').value = toLocalInput(t.arr_time);
    $('f-notes').value = t.notes || '';
    $('trip-submit').textContent = '保存修改';
    $('trip-cancel').classList.remove('hidden');
    updateAirlineLogo();
    showPanel('panel-add');
  }
  function toLocalInput(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d)) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function resetTripForm() {
    editingId = null;
    $('trip-form').reset();
    $('airline-logo').classList.add('hidden');
    $('airline-logo').removeAttribute('src');
    $('trip-submit').textContent = '保存行程';
    $('trip-cancel').classList.add('hidden');
  }
  $('trip-cancel').addEventListener('click', resetTripForm);

  // ---------- 数据加载 ----------
  async function loadData() {
    const [tripsRes, statsRes, logosRes] = await Promise.all([
      fetch('/api/trips', { headers: authHeaders() }),
      fetch('/api/stats', { headers: authHeaders() }),
      fetch('/api/airline-logos', { headers: authHeaders() }),
    ]);
    const tripsData = await tripsRes.json().catch(() => ({ ok: false }));
    const statsData = await statsRes.json().catch(() => ({ ok: false }));
    const logosData = await logosRes.json().catch(() => ({ ok: false }));
    if (logosData.ok) customLogos = logosData.logos || {};
    if (!tripsRes.ok || !tripsData.ok) {
      if (tripsRes.status === 401) {
        setAuth('');
        showView('auth');
        showAuthPanel('login-form');
        toast('登录已过期，请重新登录');
      }
      return;
    }
    trips = tripsData.trips || [];
    if (statsData.ok) {
      $('stat-flights').textContent = statsData.flights;
      $('stat-trains').textContent = statsData.trains;
      $('stat-flight-time').textContent = fmtDuration(statsData.flightMinutes);
      $('stat-train-time').textContent = fmtDuration(statsData.trainMinutes);
    }
    renderTrips();
    renderAirportRank();
    renderStationRank();
    drawRoutes();
  }

  // ---------- 统计：时长 + 机场排行榜 ----------
  // 分钟 → “X小时Y分”（不足 1 小时只显示分钟）
  function fmtDuration(min) {
    min = Math.max(0, Math.round(min || 0));
    if (min < 60) return min + '分钟';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? h + '小时' : h + '小时' + m + '分';
  }
  // 去过的地方 Top 10：出发和到达都算一次，按次数排。机场以代码为准（没有代码时用去掉了
  // 末尾“ (CODE)”的名字），显示为“全称 (CODE)”；车站直接按名字算。次数相同按名字排。
  function topPlaces(tripType, useCode) {
    const counts = {};
    const names = {};
    const add = (code, name) => {
      const cleanName = String(name || '').replace(/\s*\([A-Za-z0-9]{2,4}\)\s*$/, '').trim();
      if (!cleanName) return;
      if (useCode) {
        const m = String(name || '').match(/\(([A-Za-z0-9]{2,4})\)\s*$/);
        const c = (code || '').trim() || (m ? m[1].toUpperCase() : '');
        const key = c || cleanName;
        counts[key] = (counts[key] || 0) + 1;
        names[key] = cleanName + (c ? ' (' + c + ')' : '');
      } else {
        counts[cleanName] = (counts[cleanName] || 0) + 1;
        names[cleanName] = cleanName;
      }
    };
    (trips || []).forEach((t) => {
      if (t.type !== tripType) return;
      add(t.dep_code, t.dep_name);
      add(t.arr_code, t.arr_name);
    });
    return Object.keys(counts)
      .map((key) => ({ name: names[key], n: counts[key] }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'zh-CN'))
      .slice(0, 10);
  }
  function renderRankList(box, ranked, emptyText) {
    if (!ranked.length) {
      box.innerHTML = '<p class="empty-text">' + emptyText + '</p>';
      return;
    }
    box.innerHTML = ranked
      .map(
        (r, i) =>
          `<li class="rank-item"><span class="rank-num">${i + 1}</span>` +
          `<span class="rank-name">${escapeHtml(r.name)}</span>` +
          `<span class="rank-count">${r.n}次</span></li>`
      )
      .join('');
  }
  function renderAirportRank() {
    renderRankList($('airport-rank'), topPlaces('flight', true), '还没有飞行记录。');
  }
  function renderStationRank() {
    renderRankList($('station-rank'), topPlaces('train', false), '还没有火车行程。');
  }

  async function enterMain() {
    const res = await fetch('/api/auth/me', { headers: authHeaders() });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!res.ok || !data.ok) {
      setAuth('');
      showView('auth');
      showAuthPanel('login-form');
      return;
    }
    currentUser = data.user;
    $('settings-user-name').textContent = currentUser.name || currentUser.email;
    // 管理员设置区仅管理员可见；设置入口对所有登录用户开放
    $('admin-settings').classList.toggle('hidden', !currentUser.is_admin);
    showView('main');
    initMap();
    await loadData();
    if (currentUser.is_admin) loadSettings();
  }

  // ---------- 管理员：邮件设置 ----------
  async function loadSettings() {
    const res = await fetch('/api/admin/settings', { headers: authHeaders() });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok || !data.settings) return;
    const s = data.settings;
    $('s-smtp-host').value = s.smtp_host || '';
    $('s-smtp-port').value = s.smtp_port || '';
    $('s-smtp-user').value = s.smtp_user || '';
    $('s-smtp-from').value = s.smtp_from || '';
    $('s-smtp-pass').value = '';
    $('s-smtp-pass').placeholder = s.has_password ? '已设置（留空不修改）' : '请填写邮箱授权码';
    $('s-flight-api-key').value = '';
    $('s-flight-api-key').placeholder = s.has_flight_api_key
      ? '已设置（留空不修改）'
      : '飞常准 CMCP Key，未设置时航班查询不可用';
    $('s-amap-api-key').value = '';
    $('s-amap-api-key').placeholder = s.has_amap_api_key
      ? '已设置（留空不修改）'
      : '高德 Web 服务 Key，未设置时只有内置库地名能画线';
    $('settings-ok').textContent = data.mail_configured
      ? '发件邮箱已配置，验证码可以正常发送。'
      : '尚未配置发件邮箱，注册验证码暂时无法发送（会打印到服务器日志）。';
  }

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('settings-error').textContent = '';
    $('settings-ok').textContent = '';
    const body = {
      smtp_host: $('s-smtp-host').value.trim(),
      smtp_port: $('s-smtp-port').value.trim(),
      smtp_user: $('s-smtp-user').value.trim(),
      smtp_pass: $('s-smtp-pass').value,
      smtp_from: $('s-smtp-from').value.trim(),
      flight_api_key: $('s-flight-api-key').value.trim(),
      amap_api_key: $('s-amap-api-key').value.trim(),
    };
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
    if (!data.ok) {
      $('settings-error').textContent = data.error || '保存失败';
      return;
    }
    $('s-smtp-pass').value = '';
    $('s-flight-api-key').value = '';
    $('s-amap-api-key').value = '';
    $('settings-ok').textContent = (data.message || '已保存') + (data.mail_configured ? '，发件邮箱已配置。' : '，但发件邮箱尚未完整配置。');
    toast('设置已保存');
  });

  $('test-email-btn').addEventListener('click', async () => {
    $('settings-error').textContent = '';
    $('settings-ok').textContent = '正在发送测试邮件…';
    const res = await fetch('/api/admin/test-email', { method: 'POST', headers: authHeaders() });
    const data = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
    if (!data.ok) {
      $('settings-ok').textContent = '';
      $('settings-error').textContent = data.error || '发送失败';
      return;
    }
    $('settings-ok').textContent = data.message || '测试邮件已发送';
    toast('测试邮件已发送');
  });

  // ---------- 坐标系：两套定位逻辑 ----------
  // 数据库和内置机场/车站存的都是国际标准 WGS-84（GPS 坐标）。
  // 高德地图用 GCJ-02（国测局加密坐标），同一个点在国内会差约 100~700 米；
  // OSM 用 WGS-84，不用转换。
  // 所以画线时按当前地图源换算：高德 → WGS-84 转 GCJ-02 再画；OSM → 直接用 WGS-84。
  // 高德地理编码接口返回的是 GCJ-02，存库前要先转回 WGS-84。
  // 转换用公开的逆向算法（近似值，误差在米级以内）；中国境外的点不做转换（GCJ-02 只在国内生效）。
  const _PI = Math.PI;
  const _A = 6378245.0;
  const _EE = 0.00669342162296594323;
  function _transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * _PI) + 20.0 * Math.sin(2.0 * x * _PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * _PI) + 40.0 * Math.sin(y / 3.0 * _PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(y / 12.0 * _PI) + 300.0 * Math.sin(y / 30.0 * _PI)) * 2.0 / 3.0;
    return ret;
  }
  function _transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * _PI) + 20.0 * Math.sin(2.0 * x * _PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * _PI) + 40.0 * Math.sin(x / 3.0 * _PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * _PI) + 300.0 * Math.sin(x / 30.0 * _PI)) * 2.0 / 3.0;
    return ret;
  }
  function wgs84ToGcj02(lng, lat) {
    if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
    const dLat = _transformLat(lng - 105.0, lat - 35.0);
    const dLng = _transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * _PI;
    let magic = Math.sin(radLat);
    magic = 1 - _EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    const dLat2 = (dLat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtMagic) * _PI);
    const dLng2 = (dLng * 180.0) / (_A / sqrtMagic * Math.cos(radLat) * _PI);
    return [lng + dLng2, lat + dLat2];
  }
  function gcj02ToWgs84(lng, lat) {
    if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
    const dLat = _transformLat(lng - 105.0, lat - 35.0);
    const dLng = _transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * _PI;
    let magic = Math.sin(radLat);
    magic = 1 - _EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    const dLat2 = (dLat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtMagic) * _PI);
    const dLng2 = (dLng * 180.0) / (_A / sqrtMagic * Math.cos(radLat) * _PI);
    const mglat = lat + dLat2;
    const mglng = lng + dLng2;
    return [lng * 2 - mglng, lat * 2 - mglat];
  }
  // 把 WGS-84 坐标换算成当前地图源要用的坐标：高德 → GCJ-02，OSM → 原样
  function toMapCoords(lat, lon) {
    if (getMapSource() === 'amap') {
      const [gcjLng, gcjLat] = wgs84ToGcj02(Number(lon), Number(lat));
      return [gcjLat, gcjLng];
    }
    return [Number(lat), Number(lon)];
  }

  async function loadPlaceData() {
    try {
      const [a, s] = await Promise.all([
        fetch('airports.json').then((r) => r.json()),
        fetch('stations.json').then((r) => r.json()),
      ]);
      // 内置坐标是 WGS-84，直接存着用；画到地图上时按当前地图源换算（见 toMapCoords）
      airports = a;
      stations = s;
      airportByIata = {};
      airports.forEach((p) => {
        if (p.code) airportByIata[String(p.code).toUpperCase()] = p;
      });
    } catch (e) {
      console.error('地点数据加载失败', e);
    }
  }

  // ---------- 启动 ----------
  loadPlaceData();
  if (token) {
    enterMain();
  } else {
    showView('auth');
    showAuthPanel('login-form');
  }
})();
