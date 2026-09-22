'use strict';
// 合成一张带明显方向性纹理的测试图（512x512）：若干方向不同的纹理条带 + 噪声平滑区
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const W = 512, H = 512;
const png = new PNG({ width: W, height: H });

function setGray(x, y, g) {
  const i = (y * W + x) * 4;
  png.data[i] = png.data[i + 1] = png.data[i + 2] = Math.max(0, Math.min(255, g | 0));
  png.data[i + 3] = 255;
}

// 区域 A: 左上 0..255, 0..255 —— 垂直条纹（梯度水平）
// 区域 B: 右上 256..511, 0..255 —— 水平条纹
// 区域 C: 左下 0..255, 256..511 —— 45° 条纹
// 区域 D: 右下 256..511, 256..511 —— 平滑低纹理区
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let v = 128 + (Math.random() - 0.5) * 14;
    if (x < 256 && y < 256) {
      v = 128 + 60 * Math.sign(Math.sin(x / 6)) * 0.5 + (Math.random() - 0.5) * 18;
    } else if (x >= 256 && y < 256) {
      v = 128 + 60 * Math.sign(Math.sin(y / 6)) * 0.5 + (Math.random() - 0.5) * 18;
    } else if (x < 256 && y >= 256) {
      v = 128 + 60 * Math.sign(Math.sin((x + y) / 8)) * 0.5 + (Math.random() - 0.5) * 18;
    }
    setGray(x, y, v);
  }
}
const dir = path.join(__dirname);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'synthetic.png'), PNG.sync.write(png));
console.log('written synthetic.png');
