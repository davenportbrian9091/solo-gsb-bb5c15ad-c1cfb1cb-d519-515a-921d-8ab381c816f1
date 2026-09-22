'use strict';

/**
 * 显微灰度图纹理分区核心算法
 *
 * 流程：
 *  1. Sobel 局部梯度 → 结构张量 J（窗口积分），得到梯度强度 S 与
 *     方向一致性 C（各向异性比）、无向梯度方向 theta ∈ [-pi/2, pi/2)
 *  2. 以强度分位阈值 + 一致性阈值生成候选纹理掩码
 *  3. 掩码腐蚀 + 局部极大值提取标记，连通域过滤后做「标记控制的分水岭」
 *     泛洪（仅在候选掩码内），从源头避免相邻纹理区域粘连
 *  4. 依据相邻区域间方向差 × 一致性构建邻接图，低于合并阈值的边做
 *     Union-Find 合并（分水岭式合并）
 *  5. 区域边界按两侧平均一致性标注高/低置信度
 */

// ---------- 基础工具 ----------

function boxBlur(src, w, h, radius) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const k = radius * 2 + 1;
  // 水平
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -radius; x <= radius; x++) {
      acc += src[row + Math.max(0, Math.min(w - 1, x))];
    }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / k;
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(w - 1, x + radius + 1);
      acc += src[row + x2] - src[row + x1];
    }
  }
  // 垂直
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) {
      acc += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / k;
      const y1 = Math.max(0, y - radius);
      const y2 = Math.min(h - 1, y + radius + 1);
      acc += tmp[y2 * w + x] - tmp[y1 * w + x];
    }
  }
  return out;
}

function buildIntegral(src, w, h) {
  const W = w + 1;
  const ii = new Float64Array(W * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    const rowOff = (y - 1) * w;
    for (let x = 1; x <= w; x++) {
      rowSum += src[rowOff + x - 1];
      ii[y * W + x] = ii[(y - 1) * W + x] + rowSum;
    }
  }
  return ii;
}

function windowSum(ii, W, H, x, y, r) {
  const x0 = Math.max(0, x - r);
  const x1 = Math.min(W - 1, x + r + 1);
  const y0 = Math.max(0, y - r);
  const y1 = Math.min(H - 1, y + r + 1);
  return ii[y1 * (W + 1) + x1] - ii[y0 * (W + 1) + x1]
       - ii[y1 * (W + 1) + x0] + ii[y0 * (W + 1) + x0];
}

// 最小二叉堆，按 priority 升序
class MinHeap {
  constructor() {
    this.idx = [];
    this.prio = new Float64Array(0);
    this._p = [];
    this._c = [];
    this.seq = 0;
  }
  push(id, priority) {
    const i = this.idx.length;
    this.idx.push(id);
    this._p.push(priority);
    this._c.push(this.seq++);
    this._siftUp(i);
  }
  pop() {
    const top = this.idx[0];
    const last = this.idx.length - 1;
    this._swap(0, last);
    this.idx.pop(); this._p.pop(); this._c.pop();
    this._siftDown(0);
    return top;
  }
  get size() { return this.idx.length; }
  _less(a, b) {
    return this._p[a] < this._p[b] ||
      (this._p[a] === this._p[b] && this._c[a] < this._c[b]);
  }
  _swap(a, b) {
    [this.idx[a], this.idx[b]] = [this.idx[b], this.idx[a]];
    const t = this._p[a]; this._p[a] = this._p[b]; this._p[b] = t;
    const u = this._c[a]; this._c[a] = this._c[b]; this._c[b] = u;
  }
  _siftUp(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._less(i, p)) { this._swap(i, p); i = p; } else break;
    }
  }
  _siftDown(i) {
    const n = this.idx.length;
    for (;;) {
      let best = i;
      const l = i * 2 + 1, r = l + 1;
      if (l < n && this._less(l, best)) best = l;
      if (r < n && this._less(r, best)) best = r;
      if (best === i) break;
      this._swap(i, best);
      i = best;
    }
  }
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[pos];
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ---------- 方向场计算（结果缓存在 image 对象上） ----------

function ensureField(img) {
  if (img.field) return img.field;
  const { w, h, gray } = img;
  const n = w * h;

  const blurred = boxBlur(Float32Array.from(gray), w, h, 1);

  // Sobel 梯度
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const S = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
      const yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1);
      const sx = blurred[yu * w + xr] + 2 * blurred[y * w + xr] + blurred[yd * w + xr]
               - blurred[yu * w + xl] - 2 * blurred[y * w + xl] - blurred[yd * w + xl];
      const sy = blurred[yd * w + xl] + 2 * blurred[yd * w + x] + blurred[yd * w + xr]
               - blurred[yu * w + xl] - 2 * blurred[yu * w + x] - blurred[yu * w + xr];
      const p = y * w + x;
      gx[p] = sx; gy[p] = sy;
      S[p] = Math.hypot(sx, sy);
    }
  }

  // 结构张量分量（积分图加速窗口求和）
  const jxx = new Float32Array(n), jyy = new Float32Array(n), jxy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    jxx[i] = gx[i] * gx[i];
    jyy[i] = gy[i] * gy[i];
    jxy[i] = gx[i] * gy[i];
  }
  const ixx = buildIntegral(jxx, w, h);
  const iyy = buildIntegral(jyy, w, h);
  const ixy = buildIntegral(jxy, w, h);

  const C = new Float32Array(n);
  const theta = new Float32Array(n);
  const E = new Float32Array(n); // 窗口梯度能量（平滑后的纹理强度）= sqrt(trace J)
  const R = 2; // 张量平滑窗口半径
  const sortedE = new Float32Array(n);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = windowSum(ixx, w, h, x, y, R);
      const b = windowSum(iyy, w, h, x, y, R);
      const c = windowSum(ixy, w, h, x, y, R);
      const diff = (a - b) / 2;
      const root = Math.sqrt(diff * diff + c * c);
      const l1 = (a + b) / 2 + root;
      const l2 = (a + b) / 2 - root;
      C[p] = l1 + l2 > 1e-6 ? (l1 - l2) / (l1 + l2) : 0;
      E[p] = Math.sqrt(Math.max(0, a + b));
      // 结构张量主轴（纹理走向），与梯度方向相差 pi/2
      theta[p] = 0.5 * Math.atan2(2 * c, a - b);
    }
  }
  sortedE.set(E);
  sortedE.sort();

  img.field = { S, C, theta, E, sortedE };
  return img.field;
}

// 展示用平滑方向场（大窗口二次积分）：用于方向场叠加层，不参与分割
function smoothField(img) {
  const f = ensureField(img);
  if (f.smooth) return f.smooth;
  const { w, h } = img;
  const n = w * h;
  // 对 sin(2θ)/cos(2θ) 按一致性加权平滑，避免角度卷绕
  const sinT = new Float32Array(n), cosT = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sinT[i] = Math.sin(2 * f.theta[i]) * f.C[i];
    cosT[i] = Math.cos(2 * f.theta[i]) * f.C[i];
  }
  const iSin = buildIntegral(sinT, w, h), iCos = buildIntegral(cosT, w, h);
  const iC = buildIntegral(f.C, w, h);
  const thetaS = new Float32Array(n), CS = new Float32Array(n);
  const R = 7;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = windowSum(iSin, w, h, x, y, R);
      const c = windowSum(iCos, w, h, x, y, R);
      const cc = windowSum(iC, w, h, x, y, R);
      thetaS[y * w + x] = 0.5 * Math.atan2(s, c);
      CS[y * w + x] = cc > 1e-6 ? Math.hypot(s, c) / cc : 0;
    }
  }
  f.smooth = { theta: thetaS, C: CS };
  return f.smooth;
}

// ---------- 标记提取 ----------
// 候选掩码腐蚀后取大块连通域，每块一个标记（形态学标记控制分水岭的标准做法）
// 使用 4 邻域连通，避免不同纹理块在角点处对角渗漏而被并成同一标记

function erodeMask(src, w, h, radius) {
  const out = new Uint8Array(w * h);
  for (let y = radius; y < h - radius; y++) {
    for (let x = radius; x < w - radius; x++) {
      const p = y * w + x;
      if (!src[p]) continue;
      let inner = true;
      for (let dy = -radius; dy <= radius && inner; dy++) {
        const row = p + dy * w;
        for (let dx = -radius; dx <= radius; dx++) {
          if (!src[row + dx]) { inner = false; break; }
        }
      }
      if (inner) out[p] = 1;
    }
  }
  return out;
}

function extractMarkers(eroded, w, h, minSize) {
  const n = w * h;
  const markers = new Int32Array(n);
  const stack = [];
  let label = 0;
  for (let i = 0; i < n; i++) {
    if (!eroded[i] || markers[i]) continue;
    label++;
    stack.length = 0;
    stack.push(i);
    markers[i] = label;
    const members = [];
    while (stack.length) {
      const p = stack.pop();
      members.push(p);
      const x = p % w, y = (p / w) | 0;
      // 4 邻域，防止对角角点渗漏
      if (x > 0) tryQ(p - 1);
      if (x < w - 1) tryQ(p + 1);
      if (y > 0) tryQ(p - w);
      if (y < h - 1) tryQ(p + w);
    }
    function tryQ(q) {
      if (eroded[q] && !markers[q]) { markers[q] = label; stack.push(q); }
    }
    if (members.length < minSize) {
      for (const p of members) markers[p] = 0;
      label--;
    }
  }
  // 压缩编号
  const used = new Set();
  for (let i = 0; i < n; i++) if (markers[i]) used.add(markers[i]);
  if (used.size) {
    const remap = new Map();
    let next = 0;
    for (const v of used) remap.set(v, ++next);
    for (let i = 0; i < n; i++) if (markers[i]) markers[i] = remap.get(markers[i]);
  }
  return markers;
}


// ---------- 主分割 ----------

const DEFAULTS = {
  strengthThresh: 35,   // 梯度强度分位阈值 0..95（保留高于该分位的像素）
  coherenceThresh: 0.35, // 方向一致性阈值 0..1
  mergeCutoff: 0.30      // 相邻区域合并代价阈值 0..1（越大合并越激进）
};

function segmentate(img, rawParams) {
  const params = { ...DEFAULTS, ...(rawParams || {}) };
  const { w, h } = img;
  const n = w * h;
  const { S, C, theta, E, sortedE } = ensureField(img);

  // 1) 候选纹理掩码：平滑窗口能量分位阈值 + 一致性阈值
  const eCut = quantile(sortedE, params.strengthThresh / 100);
  const cand = new Uint8Array(n);
  let candCount = 0;
  for (let i = 0; i < n; i++) {
    if (E[i] >= eCut && C[i] >= params.coherenceThresh) {
      cand[i] = 1; candCount++;
    }
  }

  // 1b) 多尺度方向不连续度 B：跨 2/4 像素比较纹理方向，取最大锐角差。
  //     交界处结构张量虽会混合，但拉开采样距离后接缝正中仍呈现高方向梯度；
  //     均匀纹理内部方向平滑，B 很小。以此作为泛洪地形，高 B 处天然成为分水线。
  const B = new Float32Array(n);
  const offsets = [2, 4];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let worst = 0;
      for (const k of offsets) {
        if (x - k >= 0) worst = Math.max(worst, acute(theta[p], theta[p - k]));
        if (x + k < w) worst = Math.max(worst, acute(theta[p], theta[p + k]));
        if (y - k >= 0) worst = Math.max(worst, acute(theta[p], theta[p - k * w]));
        if (y + k < h) worst = Math.max(worst, acute(theta[p], theta[p + k * w]));
      }
      B[p] = worst;
    }
  }
  function acute(a, b) {
    let d = Math.abs(a - b) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d;
  }
  // 泛洪域 = 候选纹理区 且 方向连续（B 低于屏障角）
  const BARRIER_ANGLE = Math.PI / 6; // 30°
  const domain = new Uint8Array(n);
  for (let i = 0; i < n; i++) domain[i] = cand[i] && B[i] < BARRIER_ANGLE ? 1 : 0;

  // 2) 域腐蚀 → 每片大块纹理核一个标记
  const erodeR = 3;
  const eroded = erodeMask(domain, w, h, erodeR);
  const markerComp = extractMarkers(eroded, w, h, 64);
  const labels = new Int32Array(n); // 0=背景/方向屏障, -1=分水线, >0=区域
  const heap = new MinHeap();
  let regionCount = 0;

  const pushNeighbors = (p) => {
    const x = p % w, y = (p / w) | 0;
    if (x > 0) tryPush(p - 1);
    if (x < w - 1) tryPush(p + 1);
    if (y > 0) tryPush(p - w);
    if (y < h - 1) tryPush(p + w);
  };
  const tryPush = (q) => {
    if (domain[q] && labels[q] === 0) heap.push(q, B[q]);
  };

  for (let i = 0; i < n; i++) {
    if (markerComp[i] && labels[i] === 0) {
      regionCount++;
      // 整个连通标记作为同源
      const stack = [i];
      labels[i] = regionCount;
      const target = markerComp[i];
      while (stack.length) {
        const p = stack.pop();
        pushNeighbors(p);
        const x = p % w, y = (p / w) | 0;
        const m4 = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1,
                    y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        for (const q of m4) {
          if (q >= 0 && markerComp[q] === target && labels[q] === 0) {
            labels[q] = regionCount;
            stack.push(q);
          }
        }
      }
    }
  }

  // 3) 标记控制的分水岭泛洪：方向连续度高（B 小）的像素先漫，
  //    方向突变处在最后相遇成分水线，且泛洪不穿越屏障域
  while (heap.size) {
    const p = heap.pop();
    if (labels[p] !== 0) continue;
    const x = p % w, y = (p / w) | 0;
    let r1 = 0, r2 = 0;
    const neighbors = [];
    if (x > 0) neighbors.push(p - 1);
    if (x < w - 1) neighbors.push(p + 1);
    if (y > 0) neighbors.push(p - w);
    if (y < h - 1) neighbors.push(p + w);
    for (const q of neighbors) {
      const l = labels[q];
      if (l > 0) {
        if (!r1) r1 = l;
        else if (l !== r1 && !r2) r2 = l;
      }
    }
    if (!r1) continue;
    if (r2) { labels[p] = -1; continue; } // 两个水源相遇 → 分水线
    labels[p] = r1;
    pushNeighbors(p);
  }

  // 域内未被泛洪覆盖的大块（无标记的纹理区）补为独立区域
  const seen = new Uint8Array(n);
  const MIN_BLOB = 64;
  for (let i = 0; i < n; i++) {
    if (!domain[i] || labels[i] !== 0 || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    const blob = [];
    while (stack.length) {
      const p = stack.pop();
      blob.push(p);
      const x = p % w, y = (p / w) | 0;
      // 4 邻域，不穿过屏障
      if (x > 0) tryB(p - 1);
      if (x < w - 1) tryB(p + 1);
      if (y > 0) tryB(p - w);
      if (y < h - 1) tryB(p + w);
    }
    function tryB(q) {
      if (domain[q] && labels[q] === 0 && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    if (blob.length >= MIN_BLOB) {
      regionCount++;
      for (const p of blob) labels[p] = regionCount;
    }
  }

  // 4) 区域统计（初步）+ 跨隙同方向合并
  //    相邻纹理条纹常被暗色间隔（非候选像素）或分水线隔开，直接邻接图无法合并。
  //    先计算每个区域的平均方向/一致性，再以膨胀邻域（跨 GAP 像素）配对，
  //    仅当平均方向角差 < 合并阈值时 Union-Find 合并；方向屏障两侧自然不会合并。
  const rSumSin = new Float64Array(regionCount + 1);
  const rSumCos = new Float64Array(regionCount + 1);
  const rCnt = new Int32Array(regionCount + 1);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l <= 0) continue;
    rCnt[l]++;
    rSumSin[l] += Math.sin(2 * theta[i]);
    rSumCos[l] += Math.cos(2 * theta[i]);
  }
  const rTheta = new Float64Array(regionCount + 1);
  for (let l = 1; l <= regionCount; l++) {
    if (!rCnt[l]) continue;
    rTheta[l] = 0.5 * Math.atan2(rSumSin[l], rSumCos[l]);
  }
  // 每个区域的像素列表，供膨胀初始化使用
  const rPixels = Array.from({ length: regionCount + 1 }, () => []);
  for (let i = 0; i < n; i++) if (labels[i] > 0) rPixels[labels[i]].push(i);

  // 每个区域在标签场上做 GAP 步 4 邻域膨胀，记录膨胀足迹遇到的其他区域，
  // 由此得到跨非候选间隙的区域邻接对（按区域复用缓冲区）
  const GAP = 12;
  const nearPairs = new Set();
  const owner = new Int32Array(n); // 0=未访问, >0=本次膨胀已访问（存区域号）
  const queue = new Int32Array(n);
  const dist = new Uint16Array(n);
  for (let seed = 1; seed <= regionCount; seed++) {
    if (!rCnt[seed]) continue;
    let head = 0, tail = 0;
    for (const i of rPixels[seed]) { owner[i] = seed; dist[i] = 0; queue[tail++] = i; }
    while (head < tail) {
      const p = queue[head++];
      const d = dist[p];
      const x = p % w, y = (p / w) | 0;
      const nbrs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1,
                    y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nbrs) {
        if (q < 0) continue;
        const lq = labels[q];
        if (lq > 0 && lq !== seed) {
          const a = Math.min(seed, lq), b = Math.max(seed, lq);
          nearPairs.add(a * 100003 + b);
        } else if (d < GAP && lq <= 0 && owner[q] !== seed) {
          owner[q] = seed;
          dist[q] = d + 1;
          queue[tail++] = q;
        }
      }
    }
  }

  const parent = new Int32Array(regionCount + 1);
  for (let i = 1; i <= regionCount; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };

  const mergeLimit = params.mergeCutoff * (Math.PI / 2);
  let mergedEdges = 0;
  const pairArr = [...nearPairs].sort((u, v) => u - v);
  // 代价升序合并：方向最接近的区域对优先
  const scored = pairArr.map((key) => {
    const a = Math.floor(key / 100003), b = key % 100003;
    let d = Math.abs(rTheta[a] - rTheta[b]) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return { a, b, d };
  }).sort((u, v) => u.d - v.d);
  for (const e of scored) {
    if (e.d > mergeLimit) break;
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) { parent[rb] = ra; mergedEdges++; }
  }

  // 重排区域号
  const rootToId = new Map();
  let nextId = 1;
  for (let i = 1; i <= regionCount; i++) {
    const r = find(i);
    if (!rootToId.has(r)) rootToId.set(r, nextId++);
  }
  const finalLabels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) finalLabels[i] = rootToId.get(find(labels[i]));
    else finalLabels[i] = labels[i]; // 0 / -1
  }
  const regionN = nextId - 1;

  // 5) 区域统计
  const scale = img.scaleUmPerPx > 0 ? img.scaleUmPerPx : 1;
  const regs = [];
  for (let id = 1; id <= regionN; id++) {
    regs.push({
      id, areaPx: 0, areaUm2: 0,
      minX: w, minY: h, maxX: 0, maxY: 0,
      sumC: 0, sumS: 0, sumSin2: 0, sumCos2: 0,
      perimeterPx: 0
    });
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const id = finalLabels[p];
      if (id <= 0) continue;
      const r = regs[id - 1];
      r.areaPx++;
      r.sumC += C[p];
      r.sumS += E[p];
      r.sumSin2 += Math.sin(2 * theta[p]);
      r.sumCos2 += Math.cos(2 * theta[p]);
      if (x < r.minX) r.minX = x;
      if (y < r.minY) r.minY = y;
      if (x > r.maxX) r.maxX = x;
      if (y > r.maxY) r.maxY = y;
    }
  }
  for (const r of regs) {
    r.meanC = r.sumC / r.areaPx;
    r.meanS = r.sumS / r.areaPx;
    r.meanTheta = 0.5 * Math.atan2(r.sumSin2, r.sumCos2);
    r.dirAlignment = Math.hypot(r.sumSin2, r.sumCos2) / r.areaPx;
    r.areaUm2 = +(r.areaPx * scale * scale).toFixed(2);
    r.widthUm = +((r.maxX - r.minX + 1) * scale).toFixed(2);
    r.heightUm = +((r.maxY - r.minY + 1) * scale).toFixed(2);
    delete r.sumC; delete r.sumS; delete r.sumSin2; delete r.sumCos2;
  }

  // 6) 边界与置信度
  // code: 0 无, 1 高置信度区域边界, 2 低置信度边界, 3 候选掩码边缘
  // 多源 BFS：从所有区域像素出发，在非区域像素上扩散 D 像素，
  // 每个非区域像素记录到达它的不同区域（至多 2 个）与最近距离。
  //   被 ≥2 个区域触及的方向屏障带 → 低置信（红色，边界精确位置不确定）
  //   只被 1 个区域触及的候选区边缘 → 掩码边缘（白色）
  //   直接相邻的区域公共边 → 按两侧方向对齐度判高/低置信
  const boundary = new Uint8Array(n);
  const setCode = (p, code) => { if (boundary[p] < code) boundary[p] = code; };
  const LOW_CONF = 0.55; // 两侧区域平均方向对齐度低于此值 → 低置信边界
  const pairConf = (a, b) => (regs[a - 1].dirAlignment + regs[b - 1].dirAlignment) / 2;

  // 直接相邻的区域边界
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const lp = finalLabels[p];
      if (x < w - 1) considerPair(p, p + 1, lp, finalLabels[p + 1]);
      if (y < h - 1) considerPair(p, p + w, lp, finalLabels[p + w]);
    }
  }
  function considerPair(p, q, lp, lq) {
    if (lp > 0 && lq > 0 && lp !== lq) {
      setCode(p, pairConf(lp, lq) < LOW_CONF ? 2 : 1);
    }
  }

  // 非区域像素的多源扩散
  {
    const D = 8;
    const owner1 = new Int32Array(n);
    const owner2 = new Int32Array(n);
    const bd = new Uint16Array(n); // 最近区域距离
    const q = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
      if (finalLabels[i] > 0) { owner1[i] = finalLabels[i]; q[tail++] = i; }
    }
    while (head < tail) {
      const p = q[head++];
      const d = bd[p];
      const x = p % w, y = (p / w) | 0;
      const src = owner1[p] || owner2[p];
      const nbrs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1,
                    y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const np of nbrs) {
        if (np < 0 || finalLabels[np] > 0) continue;
        if (!owner1[np]) {
          owner1[np] = src; bd[np] = d + 1;
          if (d + 1 <= D) q[tail++] = np;
        } else if (owner1[np] !== src && !owner2[np]) {
          owner2[np] = src;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (finalLabels[i] !== 0) continue;
      if (owner1[i] && owner2[i]) setCode(i, 2);      // 两区域之间的屏障带 → 低置信
      else if (owner1[i] && bd[i] <= 2) setCode(i, 3); // 贴区域的候选边缘 → 白
    }
  }
  // 分水线像素：按相邻区域方向对齐度判定（高优先覆盖屏障分类）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (finalLabels[p] !== -1) continue;
      const near = new Set();
      if (x > 0 && finalLabels[p - 1] > 0) near.add(finalLabels[p - 1]);
      if (x < w - 1 && finalLabels[p + 1] > 0) near.add(finalLabels[p + 1]);
      if (y > 0 && finalLabels[p - w] > 0) near.add(finalLabels[p - w]);
      if (y < h - 1 && finalLabels[p + w] > 0) near.add(finalLabels[p + w]);
      if (near.size >= 2) {
        let c = 0;
        for (const id of near) c += regs[id - 1].dirAlignment;
        c /= near.size;
        boundary[p] = Math.max(boundary[p], c < LOW_CONF ? 2 : 1);
      } else if (near.size === 1) {
        setCode(p, 3);
      }
    }
  }

  // 周长统计
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (boundary[p] === 1 || boundary[p] === 2) {
        regs[finalLabels[p] - 1] && (regs[finalLabels[p] - 1].perimeterPx++);
      }
    }
  }

  // 按面积降序
  regs.sort((a, b) => b.areaPx - a.areaPx);

  return {
    w, h, params, finalLabels, boundary, regions: regs,
    candidateFraction: +(candCount / n).toFixed(4),
    strengthCut: +eCut.toFixed(2),
    mergedEdges
  };
}

// ---------- 叠加层渲染（RGB Buffer） ----------

function renderRegionsOverlay(img, seg) {
  const { w, h } = img;
  const n = w * h;
  const out = Buffer.alloc(n * 3);
  // 区域固定调色板（黄金角分布的色相）
  const palette = new Map();
  const colorFor = (id) => {
    if (!palette.has(id)) {
      palette.set(id, hsvToRgb((id * 0.61803398875) % 1, 0.55, 1));
    }
    return palette.get(id);
  };
  for (let i = 0; i < n; i++) {
    const g = img.gray[i];
    let r = g, gg = g, b = g;
    const id = seg.finalLabels[i];
    if (id > 0) {
      const [cr, cg, cb] = colorFor(id);
      const a = 0.32;
      r = g * (1 - a) + cr * a;
      gg = g * (1 - a) + cg * a;
      b = g * (1 - a) + cb * a;
    } else if (id === -1) {
      r = gg = b = g * 0.6;
    }
    const code = seg.boundary[i];
    if (code === 1) { r = 46; gg = 230; b = 168; }        // 高置信度：青绿
    else if (code === 2) { r = 255; gg = 77; b = 77; }     // 低置信度：红
    else if (code === 3) { r = 255; gg = 255; b = 255; }   // 掩码边缘：白
    out[i * 3] = r; out[i * 3 + 1] = gg; out[i * 3 + 2] = b;
  }
  return out;
}

function renderOrientationOverlay(img) {
  const { w, h } = img;
  const n = w * h;
  const { theta, C } = smoothField(img);
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const g = img.gray[i];
    // 方向色相（θ ∈ [-π/2,π/2) 映射到 0..1），饱和度随一致性；
    // 低一致性区域退回灰度，避免噪声彩色
    const c = Math.min(1, Math.max(0, C[i]));
    const sat = Math.max(0, (c - 0.15) / 0.85) * 0.8;
    const hue = (theta[i] + Math.PI / 2) / Math.PI;
    const [r0, g0, b0] = hsvToRgb(hue, sat, 0.5 + 0.5 * (g / 255));
    const a = 0.2 + 0.55 * c;
    out[i * 3] = g * (1 - a) + r0 * a;
    out[i * 3 + 1] = g * (1 - a) + g0 * a;
    out[i * 3 + 2] = g * (1 - a) + b0 * a;
  }
  // 方向短线 glyph（间隔 10px，低一致性不绘制）
  const gap = 10, len = 3.2;
  const plot = (x, y, r, gg, b) => {
    x = x | 0; y = y | 0;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    out[i] = r; out[i + 1] = gg; out[i + 2] = b;
  };
  for (let y = gap / 2; y < h; y += gap) {
    for (let x = gap / 2; x < w; x += gap) {
      const p = (y | 0) * w + (x | 0);
      if (C[p] < 0.4) continue;
      const dx = Math.cos(theta[p]), dy = Math.sin(theta[p]);
      for (let t = -len; t <= len; t += 0.5) {
        plot(x + dx * t, y + dy * t, 20, 22, 28);
      }
    }
  }
  return out;
}

function renderOriginal(img) {
  const n = img.w * img.h;
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = img.gray[i];
  }
  return out;
}

module.exports = {
  DEFAULTS,
  ensureField,
  erodeMask,
  extractMarkers,
  segmentate,
  renderRegionsOverlay,
  renderOrientationOverlay,
  renderOriginal
};
