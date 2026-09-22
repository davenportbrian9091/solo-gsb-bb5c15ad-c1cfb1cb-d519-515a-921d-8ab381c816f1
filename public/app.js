'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  image: null,
  params: { strengthThresh: 35, coherenceThresh: 0.35, mergeCutoff: 0.30 },
  seg: null,
  activeVersion: null,
  debounceTimer: null
};

// ---------- 初始化 ----------

window.addEventListener('DOMContentLoaded', async () => {
  bindControls();
  await refreshImageList();
});

function bindControls() {
  $('uploadForm').addEventListener('submit', onUpload);
  $('imageSelect').addEventListener('change', (e) => loadImage(e.target.value));

  for (const id of ['strengthThresh', 'coherenceThresh', 'mergeCutoff']) {
    $(id).addEventListener('input', () => {
      readSliders();
      updateSliderLabels();
      scheduleRefresh(200);
    });
  }

  for (const id of ['layerBase', 'layerField', 'layerRegions']) {
    $(id).addEventListener('change', applyLayerVisibility);
  }
  $('fieldOpacity').addEventListener('input', () => {
    $('fieldOpacityVal').textContent = $('fieldOpacity').value + '%';
    applyLayerVisibility();
  });
  $('regionOpacity').addEventListener('input', () => {
    $('regionOpacityVal').textContent = $('regionOpacity').value + '%';
    applyLayerVisibility();
  });

  $('saveBtn').addEventListener('click', onSave);
}

function readSliders() {
  state.params = {
    strengthThresh: parseFloat($('strengthThresh').value),
    coherenceThresh: parseFloat($('coherenceThresh').value),
    mergeCutoff: parseFloat($('mergeCutoff').value)
  };
}

function writeSliders() {
  $('strengthThresh').value = state.params.strengthThresh;
  $('coherenceThresh').value = state.params.coherenceThresh;
  $('mergeCutoff').value = state.params.mergeCutoff;
  updateSliderLabels();
}

function updateSliderLabels() {
  $('strengthVal').textContent = state.params.strengthThresh + ' 分位';
  $('coherenceVal').textContent = state.params.coherenceThresh.toFixed(2);
  $('mergeVal').textContent = state.params.mergeCutoff.toFixed(2);
}

// ---------- 图像列表 / 上传 ----------

async function refreshImageList() {
  const images = await api('/api/images');
  const sel = $('imageSelect');
  sel.innerHTML = '';
  if (!images.length) {
    $('imageListSection').hidden = true;
    return;
  }
  $('imageListSection').hidden = false;
  for (const im of images) {
    const opt = document.createElement('option');
    opt.value = im.id;
    opt.textContent = `${im.original_name} (${im.width}×${im.height})`;
    sel.appendChild(opt);
  }
  if (state.image) sel.value = state.image.id;
}

async function onUpload(e) {
  e.preventDefault();
  const file = $('fileInput').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file);
  const scale = $('scaleInput').value;
  if (scale) fd.append('scale_um_per_px', scale);
  const btn = e.target.querySelector('button');
  btn.disabled = true; btn.textContent = '处理中…';
  try {
    const info = await fetch('/api/images', { method: 'POST', body: fd }).then(handleJson);
    if (info.note) console.info(info.note);
    await refreshImageList();
    $('imageSelect').value = info.id;
    await loadImage(info.id);
  } catch (err) {
    alert('上传失败: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '上传并分析';
  }
}

async function loadImage(id) {
  const info = await api('/api/images/' + id);
  state.image = {
    id: info.id,
    name: info.original_name,
    width: info.width,
    height: info.height,
    origWidth: info.orig_width,
    origHeight: info.orig_height,
    scaleUmPerPx: info.scale_um_per_px,
    downscale: info.downscale,
    versions: info.versions
  };
  state.activeVersion = null;

  $('welcome').hidden = true;
  $('viewer').hidden = false;
  $('controlSection').hidden = false;

  buildStage();
  const last = info.versions && info.versions[0];
  if (last) {
    state.params = { ...last.params };
  } else {
    state.params = { strengthThresh: 35, coherenceThresh: 0.35, mergeCutoff: 0.3 };
  }
  writeSliders();
  renderTitle();
  renderVersions();
  await refreshSegmentation();
}

// ---------- 舞台叠加 ----------

function buildStage() {
  const stage = $('stage');
  stage.innerHTML = '';
  stage.style.width = state.image.width + 'px';
  stage.style.height = state.image.height + 'px';

  const base = document.createElement('img');
  base.className = 'base';
  base.id = 'imgBase';
  base.src = `/api/images/${state.image.id}/original.png`;
  stage.appendChild(base);

  const field = document.createElement('img');
  field.id = 'imgField';
  field.src = `/api/images/${state.image.id}/overlay.png?layer=field`;
  stage.appendChild(field);

  const regions = document.createElement('img');
  regions.id = 'imgRegions';
  regions.src = '';
  stage.appendChild(regions);

  const marker = document.createElement('div');
  marker.id = 'marker';
  marker.hidden = true;
  stage.appendChild(marker);

  // 大图自动收缩
  const wrapWidth = Math.min(window.innerWidth - 360, 1400);
  if (state.image.width > wrapWidth) {
    stage.style.width = wrapWidth + 'px';
    stage.style.height = (state.image.height * wrapWidth / state.image.width) + 'px';
  }
  applyLayerVisibility();
}

function applyLayerVisibility() {
  if (!state.image) return;
  $('imgBase').style.display = $('layerBase').checked ? 'block' : 'none';
  const fieldEl = $('imgField');
  fieldEl.style.display = $('layerField').checked ? 'block' : 'none';
  fieldEl.style.opacity = $('fieldOpacity').value / 100;
  const regEl = $('imgRegions');
  regEl.style.display = $('layerRegions').checked ? 'block' : 'none';
  regEl.style.opacity = $('regionOpacity').value / 100;
}

function scheduleRefresh(ms) {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(refreshSegmentation, ms);
}

function overlayQuery() {
  const p = state.params;
  return `strengthThresh=${p.strengthThresh}&coherenceThresh=${p.coherenceThresh}&mergeCutoff=${p.mergeCutoff}`;
}

async function refreshSegmentation() {
  if (!state.image) return;
  const url = `/api/images/${state.image.id}/segment?${overlayQuery()}`;
  const seg = await api(url);
  state.seg = seg;
  state.params = { ...seg.params };

  // 更新区域叠加层（防缓存）
  $('imgRegions').src =
    `/api/images/${state.image.id}/overlay.png?layer=regions&${overlayQuery()}&t=${Date.now()}`;

  renderStats();
  renderRegions();
}

function renderTitle() {
  const im = state.image;
  const scaleTxt = im.scaleUmPerPx
    ? `<button id="scaleBtn" title="点击修改">尺度 ${im.scaleUmPerPx} µm/px</button>`
    : '<button id="scaleBtn">设置像素尺度</button>';
  $('imageTitle').innerHTML =
    `${escapeHtml(im.name)}　${scaleTxt}　` +
    `<span class="hint" style="margin:0">分析分辨率 ${im.width}×${im.height}` +
    (im.downscale < 1 ? `（原图 ${im.origWidth}×${im.origHeight}，缩放 ${(im.downscale * 100).toFixed(0)}%）` : '') +
    '</span>';
  $('scaleBtn').addEventListener('click', editScale);
}

async function editScale() {
  const cur = state.image.scaleUmPerPx || '';
  const v = prompt('输入原始图像的像素尺度 (µm/px)：', cur);
  if (v === null) return;
  const num = parseFloat(v);
  if (!isFinite(num) || num <= 0) return alert('需为正数');
  await fetch(`/api/images/${state.image.id}/scale`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scaleUmPerPx: num })
  }).then(handleJson);
  state.image.scaleUmPerPx = num;
  renderTitle();
  await refreshSegmentation();
}

function renderStats() {
  const s = state.seg.stats;
  $('stats').innerHTML =
    `区域数 <b>${s.regionCount}</b>　` +
    `候选像素 <b>${(s.candidateFraction * 100).toFixed(1)}%</b>　` +
    `强度截断 <b>${s.strengthCut}</b>　` +
    `合并边 <b>${s.mergedEdges}</b>`;
}

function renderRegions() {
  const tbody = document.querySelector('#regionTable tbody');
  tbody.innerHTML = '';
  for (const r of state.seg.regions) {
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    const areaTxt = state.image.scaleUmPerPx ? fmt(r.areaUm2) : '—';
    tr.innerHTML =
      `<td>${r.id}</td><td>${r.areaPx}</td><td>${areaTxt}</td>` +
      `<td>${state.image.scaleUmPerPx ? r.widthUm : '—'}</td>` +
      `<td>${state.image.scaleUmPerPx ? r.heightUm : '—'}</td>` +
      `<td>${r.meanOrientationDeg}</td><td>${r.alignment}</td>` +
      `<td>${r.meanCoherence}</td><td>${r.meanStrength}</td>`;
    tr.addEventListener('click', () => highlightRegion(r, tr));
    tbody.appendChild(tr);
  }
}

function highlightRegion(r, tr) {
  document.querySelectorAll('#regionTable tr.active').forEach((el) => el.classList.remove('active'));
  tr.classList.add('active');
  const [x0, y0, x1, y1] = r.bbox;
  const stage = $('stage');
  const marker = $('marker');
  const sx = stage.clientWidth / state.image.width;
  const sy = stage.clientHeight / state.image.height;
  marker.style.left = (x0 * sx - 2) + 'px';
  marker.style.top = (y0 * sy - 2) + 'px';
  marker.style.width = ((x1 - x0 + 1) * sx + 4) + 'px';
  marker.style.height = ((y1 - y0 + 1) * sy + 4) + 'px';
  marker.hidden = false;
  clearTimeout(marker._timer);
  marker._timer = setTimeout(() => { marker.hidden = true; }, 2500);
}

// ---------- 版本 ----------

async function onSave() {
  const note = $('noteInput').value;
  const btn = $('saveBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const saved = await fetch(`/api/images/${state.image.id}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: state.params, note })
    }).then(handleJson);
    state.activeVersion = saved.version;
    $('noteInput').value = '';
    await refreshImageList();
    const info = await api(`/api/images/${state.image.id}`);
    state.image.versions = info.versions;
    renderVersions();
  } catch (err) {
    alert('保存失败: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '保存当前结果';
  }
}

function renderVersions() {
  const box = $('versionList');
  box.innerHTML = '';
  const versions = state.image.versions || [];
  if (!versions.length) {
    box.innerHTML = '<p class="hint">尚无已保存版本。调整阈值后点击「保存当前结果」。</p>';
    return;
  }
  for (const v of versions) {
    const div = document.createElement('div');
    div.className = 'version-item' + (v.version === state.activeVersion ? ' active' : '');
    div.innerHTML =
      `<div class="v-head">v${v.version}` +
      `<button class="v-del" title="删除版本">✕</button></div>` +
      `<div class="v-meta">区域 ${v.stats.regionCount} 个 · 候选 ${(v.stats.candidateFraction * 100).toFixed(1)}%` +
      ` · ${v.createdAt}</div>` +
      (v.note ? `<div class="v-meta">📝 ${escapeHtml(v.note)}</div>` : '');
    div.addEventListener('click', async (e) => {
      if (e.target.classList.contains('v-del')) {
        if (!confirm(`删除版本 v${v.version}？`)) return;
        await fetch(`/api/images/${state.image.id}/versions/${v.version}`, { method: 'DELETE' });
        const info = await api(`/api/images/${state.image.id}`);
        state.image.versions = info.versions;
        if (state.activeVersion === v.version) state.activeVersion = null;
        renderVersions();
        return;
      }
      state.params = { ...v.params };
      state.activeVersion = v.version;
      writeSliders();
      await refreshSegmentation();
      renderVersions();
    });
    box.appendChild(div);
  }
}

// ---------- 工具 ----------

async function api(url) {
  return fetch(url).then(handleJson);
}
async function handleJson(resp) {
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || resp.statusText);
  return data;
}
function fmt(x) {
  if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (x >= 1e3) return (x / 1e3).toFixed(2) + 'k';
  return x.toString();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
