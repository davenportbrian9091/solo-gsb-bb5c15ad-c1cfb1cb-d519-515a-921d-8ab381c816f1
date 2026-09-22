'use strict';
// 端到端 API 回归测试：启动时请确保服务在 BASE 上运行
const BASE = process.env.BASE || 'http://localhost:8080';

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓', name); }
  else { failures++; console.log('  ✗', name, extra || ''); }
}
async function j(method, url, body, isForm) {
  const opt = { method, headers: {} };
  if (body !== undefined && !isForm) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  } else if (isForm) {
    opt.body = body;
  }
  const r = await fetch(BASE + url, opt);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data };
}

(async () => {
  // health
  {
    const { status, data } = await j('GET', '/api/health');
    check('health 200', status === 200 && data.ok === true);
  }

  // upload
  let imgId;
  {
    const fs = require('fs');
    const FormData = globalThis.FormData;
    const fd = new FormData();
    const buf = fs.readFileSync(__dirname + '/smooth.png');
    fd.append('image', new Blob([buf]), 'smooth.png');
    fd.append('scale_um_per_px', '0.5');
    const { status, data } = await j('POST', '/api/images', fd, true);
    check('upload 200', status === 200, JSON.stringify(data));
    imgId = data.id;
    check('scale stored', data.scaleUmPerPx === 0.5);
    check('dims', data.width === 512 && data.height === 512);
  }

  // original png
  {
    const { status, data } = await j('GET', `/api/images/${imgId}/original.png`);
    check('original.png 200 PNG', status === 200 && data[0] === 0x89 && data[1] === 0x50);
  }

  // segment with default + custom params
  let segStats;
  {
    const { status, data } = await j('GET', `/api/images/${imgId}/segment`);
    check('segment defaults', status === 200 && data.stats.regionCount > 0);
    check('regions have fields', data.regions[0] &&
      'areaUm2' in data.regions[0] && 'meanOrientationDeg' in data.regions[0]);
  }
  {
    const { status, data } = await j('GET',
      `/api/images/${imgId}/segment?strengthThresh=60&coherenceThresh=0.6&mergeCutoff=0.1`);
    check('segment custom 200', status === 200);
    check('params echoed',
      data.params.strengthThresh === 60 &&
      data.params.coherenceThresh === 0.6 &&
      data.params.mergeCutoff === 0.1,
      JSON.stringify(data.params));
    segStats = data.stats;
  }

  // physical scale: areaUm2 = areaPx * (0.5)^2
  {
    const { data } = await j('GET', `/api/images/${imgId}/segment?strengthThresh=35`);
    const r0 = data.regions[0];
    check('areaUm2 = areaPx*0.25', Math.abs(r0.areaUm2 - r0.areaPx * 0.25) < 0.1,
      `${r0.areaUm2} vs ${r0.areaPx * 0.25}`);
  }

  // overlays
  for (const layer of ['original', 'field', 'regions']) {
    const { status, data } = await j('GET',
      `/api/images/${imgId}/overlay.png?layer=${layer}&strengthThresh=50`);
    check(`overlay ${layer}`, status === 200 && data[0] === 0x89 && data.length > 1000,
      `status ${status}`);
  }

  // invalid param clamps
  {
    const { data } = await j('GET', `/api/images/${imgId}/segment?strengthThresh=999`);
    check('param clamped', data.params.strengthThresh <= 95);
  }

  // versions
  let v1, v2;
  {
    const { status, data } = await j('POST', `/api/images/${imgId}/versions`,
      { params: { strengthThresh: 40, coherenceThresh: 0.4, mergeCutoff: 0.3 }, note: 'n1' });
    check('save v1', status === 200 && data.version === 1);
    v1 = data.version;
  }
  {
    const { data } = await j('POST', `/api/images/${imgId}/versions`,
      { params: { strengthThresh: 55, coherenceThresh: 0.5, mergeCutoff: 0.2 }, note: 'n2' });
    check('save v2 autoincrement', data.version === 2);
    v2 = data.version;
  }
  {
    const { data } = await j('GET', `/api/images/${imgId}`);
    check('detail lists versions', data.versions.length === 2 &&
      data.versions[0].version === 2 && data.versions[1].note === 'n1');
  }
  {
    const { data } = await j('GET', `/api/images/${imgId}/versions/${v1}`);
    check('get v1', data.version === 1 && data.note === 'n1');
  }
  {
    const { status } = await j('DELETE', `/api/images/${imgId}/versions/${v2}`);
    check('delete v2', status === 200);
    const { data } = await j('GET', `/api/images/${imgId}`);
    check('one version left', data.versions.length === 1);
  }

  // scale update invalid
  {
    const { status } = await j('PUT', `/api/images/${imgId}/scale`, { scaleUmPerPx: -1 });
    check('scale rejects negative', status === 400);
  }
  {
    const { status, data } = await j('PUT', `/api/images/${imgId}/scale`, { scaleUmPerPx: 0.1 });
    check('scale update', status === 200 && data.scaleUmPerPx === 0.1);
  }

  // 404s
  {
    const { status } = await j('GET', '/api/images/deadbeef/segment');
    check('missing image 404', status === 404);
  }
  {
    const { status } = await j('GET', '/api/images/' + imgId + '/versions/99');
    check('missing version 404', status === 404);
  }

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
