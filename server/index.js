'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { PNG } = require('pngjs');

const algo = require('./imageproc');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const IMG_DIR = path.join(DATA_DIR, 'images');
const DB_PATH = path.join(DATA_DIR, 'workbench.db');
const MAX_ANALYSIS_DIM = 1000;
const MAX_UPLOAD_MB = 30;

fs.mkdirSync(IMG_DIR, { recursive: true });

// ---------- 数据库 ----------

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS images (
    id            TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    orig_width    INTEGER NOT NULL,
    orig_height   INTEGER NOT NULL,
    width         INTEGER NOT NULL,
    height        INTEGER NOT NULL,
    downscale     REAL NOT NULL,
    scale_um_per_px REAL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id    TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    params_json TEXT NOT NULL,
    stats_json  TEXT NOT NULL,
    regions_json TEXT NOT NULL,
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(image_id, version)
  );
`);

// ---------- 图像内存缓存（分析分辨率灰度图） ----------
/** @type {Map<string, {gray:Uint8Array,w:number,h:number,scaleUmPerPx:number}>} */
const imageCache = new Map();

// 分割结果缓存：每图保留最近若干组参数的结果（滑阈值时避免重复计算）
const segCache = new Map(); // imageId -> Map(key, seg)
const SEG_CACHE_PER_IMAGE = 6;

function getSegmentation(img, id, rawParams) {
  const p = { ...algo.DEFAULTS, ...(rawParams || {}) };
  const key = `${p.strengthThresh}|${p.coherenceThresh}|${p.mergeCutoff}`;
  let map = segCache.get(id);
  if (!map) { map = new Map(); segCache.set(id, map); }
  if (map.has(key)) return map.get(key);
  const seg = algo.segmentate(img, p);
  map.set(key, seg);
  if (map.size > SEG_CACHE_PER_IMAGE) {
    map.delete(map.keys().next().value); // Map 保持插入序，删最旧
  }
  return seg;
}

function loadImage(id) {
  if (imageCache.has(id)) return imageCache.get(id);
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  if (!row) return null;
  const data = fs.readFileSync(row.file_path);
  const png = PNG.sync.read(data);
  const gray = new Uint8Array(png.width * png.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = png.data[i * 4]; // 存储时已转灰度
  }
  // 尺度按原图 µm/px 记录；分析图若被缩小，则分析像素尺度 = 原尺度 / downscale
  const img = {
    gray, w: png.width, h: png.height,
    scaleUmPerPx: row.scale_um_per_px ? row.scale_um_per_px / row.downscale : 0
  };
  imageCache.set(id, img);
  return img;
}

function encodePng(rgb, w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgb[i * 3];
    png.data[i * 4 + 1] = rgb[i * 3 + 1];
    png.data[i * 4 + 2] = rgb[i * 3 + 2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ---------- 应用 ----------

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 上传灰度显微图
app.post('/api/images', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '缺少 image 文件字段' });
    let scale = parseFloat(req.body.scale_um_per_px);
    if (!isFinite(scale) || scale <= 0) scale = null;

    const meta = await sharp(req.file.buffer).metadata();
    const longest = Math.max(meta.width, meta.height);
    const downscale = longest > MAX_ANALYSIS_DIM ? MAX_ANALYSIS_DIM / longest : 1;

    const pipeline = sharp(req.file.buffer)
      .grayscale()
      .rotate(); // 尊重 EXIF 方向
    if (downscale < 1) {
      pipeline.resize({
        width: Math.round(meta.width * downscale),
        height: Math.round(meta.height * downscale),
        fit: 'fill'
      });
    }
    const pngBuf = await pipeline.png().toBuffer();
    const resized = PNG.sync.read(pngBuf);

    const id = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(IMG_DIR, `${id}.png`);
    fs.writeFileSync(filePath, pngBuf);

    db.prepare(`INSERT INTO images
      (id, original_name, file_path, orig_width, orig_height, width, height, downscale, scale_um_per_px)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.file.originalname, filePath, meta.width, meta.height,
        resized.width, resized.height, downscale, scale);

    res.json({
      id,
      originalName: req.file.originalname,
      origWidth: meta.width,
      origHeight: meta.height,
      width: resized.width,
      height: resized.height,
      downscale: +downscale.toFixed(4),
      scaleUmPerPx: scale,
      note: downscale < 1
        ? `图像较长边超过 ${MAX_ANALYSIS_DIM}px，分析时已缩小至 ${resized.width}x${resized.height}（原图保留原分辨率信息）`
        : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '图像处理失败: ' + err.message });
  }
});

app.get('/api/images', (_req, res) => {
  const rows = db.prepare(`SELECT id, original_name, orig_width, orig_height,
      width, height, scale_um_per_px, created_at FROM images ORDER BY created_at DESC`).all();
  res.json(rows);
});

app.get('/api/images/:id', (req, res) => {
  const row = db.prepare(`SELECT id, original_name, orig_width, orig_height,
      width, height, downscale, scale_um_per_px, created_at
      FROM images WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: '图像不存在' });
  const versions = db.prepare(
    'SELECT id, version, params_json, stats_json, note, created_at FROM versions WHERE image_id = ? ORDER BY version DESC'
  ).all(req.params.id).map((v) => ({
    id: v.id, version: v.version, params: JSON.parse(v.params_json),
    stats: JSON.parse(v.stats_json), note: v.note, createdAt: v.created_at
  }));
  res.json({ ...row, versions });
});

// 更新像素尺度（µm/px，指原始图像像素）
app.put('/api/images/:id/scale', (req, res) => {
  let scale = parseFloat(req.body.scaleUmPerPx);
  if (!isFinite(scale) || scale <= 0) {
    return res.status(400).json({ error: '尺度需为正数 (µm/px)' });
  }
  const info = db.prepare('UPDATE images SET scale_um_per_px = ? WHERE id = ?')
    .run(scale, req.params.id);
  if (!info.changes) return res.status(404).json({ error: '图像不存在' });
  const img = imageCache.get(req.params.id);
  if (img) {
    const row = db.prepare('SELECT downscale FROM images WHERE id = ?').get(req.params.id);
    img.scaleUmPerPx = scale / row.downscale;
  }
  segCache.delete(req.params.id); // 物理尺寸统计依赖尺度
  res.json({ ok: true, scaleUmPerPx: scale });
});

// 原图（灰度 PNG）
app.get('/api/images/:id/original.png', (req, res) => {
  const row = db.prepare('SELECT file_path FROM images WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send('not found');
  res.set('Content-Type', 'image/png');
  fs.createReadStream(row.file_path).pipe(res);
});

function readParams(query) {
  const p = {};
  if (query.strengthThresh !== undefined)
    p.strengthThresh = clamp(parseFloat(query.strengthThresh), 0, 95);
  if (query.coherenceThresh !== undefined)
    p.coherenceThresh = clamp(parseFloat(query.coherenceThresh), 0, 1);
  if (query.mergeCutoff !== undefined)
    p.mergeCutoff = clamp(parseFloat(query.mergeCutoff), 0, 1);
  return p;
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// 计算分割（不保存）
app.get('/api/images/:id/segment', (req, res) => {
  const img = loadImage(req.params.id);
  if (!img) return res.status(404).json({ error: '图像不存在' });
  const seg = getSegmentation(img, req.params.id, readParams(req.query));
  res.json(buildSegmentResponse(seg));
});

// 叠加层 PNG: layer = original | field | regions
app.get('/api/images/:id/overlay.png', (req, res) => {
  const img = loadImage(req.params.id);
  if (!img) return res.status(404).send('not found');
  const layer = req.query.layer || 'original';
  let buf;
  if (layer === 'field') {
    buf = encodePng(algo.renderOrientationOverlay(img), img.w, img.h);
  } else if (layer === 'regions') {
    const seg = getSegmentation(img, req.params.id, readParams(req.query));
    buf = encodePng(algo.renderRegionsOverlay(img, seg), img.w, img.h);
  } else {
    buf = encodePng(algo.renderOriginal(img), img.w, img.h);
  }
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(buf);
});

function buildSegmentResponse(seg) {
  return {
    width: seg.w,
    height: seg.h,
    params: seg.params,
    stats: {
      regionCount: seg.regions.length,
      candidateFraction: seg.candidateFraction,
      strengthCut: seg.strengthCut,
      mergedEdges: seg.mergedEdges
    },
    regions: seg.regions.map((r) => ({
      id: r.id,
      areaPx: r.areaPx,
      areaUm2: r.areaUm2,
      widthUm: r.widthUm,
      heightUm: r.heightUm,
      bbox: [r.minX, r.minY, r.maxX, r.maxY],
      meanCoherence: +r.meanC.toFixed(3),
      meanStrength: +r.meanS.toFixed(2),
      meanOrientationDeg: +(r.meanTheta * 180 / Math.PI).toFixed(1),
      alignment: +r.dirAlignment.toFixed(3),
      perimeterPx: r.perimeterPx
    }))
  };
}

// 保存带版本号的结果
app.post('/api/images/:id/versions', (req, res) => {
  const img = loadImage(req.params.id);
  if (!img) return res.status(404).json({ error: '图像不存在' });
  const seg = algo.segmentate(img, req.body.params || {});
  const payload = buildSegmentResponse(seg);

  const nextVersion = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM versions WHERE image_id = ?')
    .get(req.params.id)).v;
  const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : null;

  const info = db.prepare(`INSERT INTO versions
    (image_id, version, params_json, stats_json, regions_json, note)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.params.id, nextVersion,
      JSON.stringify(payload.params),
      JSON.stringify(payload.stats),
      JSON.stringify(payload.regions),
      note);

  res.json({ id: info.lastInsertRowid, version: nextVersion, ...payload, note });
});

app.get('/api/images/:id/versions/:version', (req, res) => {
  const v = db.prepare('SELECT * FROM versions WHERE image_id = ? AND version = ?')
    .get(req.params.id, parseInt(req.params.version, 10));
  if (!v) return res.status(404).json({ error: '版本不存在' });
  res.json({
    id: v.id, version: v.version,
    params: JSON.parse(v.params_json),
    stats: JSON.parse(v.stats_json),
    regions: JSON.parse(v.regions_json),
    note: v.note, createdAt: v.created_at
  });
});

app.delete('/api/images/:id/versions/:version', (req, res) => {
  const info = db.prepare('DELETE FROM versions WHERE image_id = ? AND version = ?')
    .run(req.params.id, parseInt(req.params.version, 10));
  if (!info.changes) return res.status(404).json({ error: '版本不存在' });
  res.json({ ok: true });
});

app.delete('/api/images/:id', (req, res) => {
  const row = db.prepare('SELECT file_path FROM images WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '图像不存在' });
  db.prepare('DELETE FROM images WHERE id = ?').run(req.params.id);
  fs.rmSync(row.file_path, { force: true });
  imageCache.delete(req.params.id);
  segCache.delete(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`显微纹理审阅台已启动: http://localhost:${PORT}`);
});
