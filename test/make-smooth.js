'use strict';
// 连续灰度流动纹理测试图（更接近真实显微图）：
// 三个不同主方向的平滑纹理场 + 一块各向同性噪声区，软边界过渡
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const W = 512, H = 512;
const png = new PNG({ width: W, height: H });

// 平滑伪随机噪声（双频正弦叠加）
function flow(x, y, angle, scale = 9) {
  const u = Math.cos(angle) * x + Math.sin(angle) * y;
  const v = -Math.sin(angle) * x + Math.cos(angle) * y;
  return 26 * Math.sin(u / scale)
       + 14 * Math.sin((u * 1.7 + v * 0.5) / scale)
       + 8 * Math.sin((u * 0.6 - v * 1.3) / scale)
       + 6 * Math.sin(v / (scale * 2.1));
}
// 软混合权重
function zoneWeight(x, y) {
  // 垂直分界 x=256，水平分界 y=256，过渡宽 14
  const ax = 1 / (1 + Math.exp(-(x - 256) / 6));
  const ay = 1 / (1 + Math.exp(-(y - 256) / 6));
  return {
    tl: (1 - ax) * (1 - ay),
    tr: ax * (1 - ay),
    bl: (1 - ax) * ay,
    br: ax * ay
  };
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const z = zoneWeight(x, y);
    let v = 128
      + z.tl * flow(x, y, 0)
      + z.tr * flow(x, y, Math.PI / 2)
      + z.bl * flow(x, y, Math.PI / 4)
      + z.br * (Math.random() - 0.5) * 46; // 右下：各向同性噪声
    v += (Math.random() - 0.5) * 7;
    v = Math.max(0, Math.min(255, v));
    const i = (y * W + x) * 4;
    png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
    png.data[i + 3] = 255;
  }
}
fs.writeFileSync(path.join(__dirname, 'smooth.png'), PNG.sync.write(png));
console.log('written smooth.png');
