/* Đánh dấu PDF v2 – ghi nhận hiện trường trên bản vẽ PDF (Dự án → Bản vẽ → Điểm ghi nhận).
   Dữ liệu lưu cục bộ trên điện thoại (IndexedDB). Không gửi dữ liệu đi đâu. */
import * as pdfjsLib from './pdf.min.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.js', import.meta.url).href;

const APP_VERSION = '2.2.0';
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad2 = n => String(n).padStart(2, '0');
const fmtDate = t => { const d = new Date(t); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
const safeName = s => (s || 'file').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'file';
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fmtISO = s => s ? s.split('-').reverse().join('/') : '';

/* ======================= CATEGORIES / STATUS / SYMBOLS ======================= */
const CATS = {
  VM: { name: 'Vướng mắc', shape: 'circle', glyph: '?', cloud: true, title: 'BÁO CÁO VƯỚNG MẮC HIỆN TRƯỜNG',
        fields: [['proposal', 'Đề xuất xử lý'], ['reply', 'Phản hồi của các bên']] },
  PS: { name: 'Phát sinh', shape: 'diamond', glyph: '+', title: 'BÁO CÁO GHI NHẬN PHÁT SINH',
        fields: [['basis', 'Căn cứ / lý do phát sinh']] },
  TD: { code: 'TĐ', name: 'Thay đổi thiết kế', shape: 'triangle', glyph: 'Δ', cloud: true, title: 'BÁO CÁO THAY ĐỔI THIẾT KẾ',
        fields: [['basis', 'Căn cứ (văn bản, chỉ thị, bản vẽ sửa đổi)']] },
  KK: { name: 'Lỗi / khiếm khuyết', shape: 'square', glyph: '×', title: 'BÁO CÁO LỖI / KHIẾM KHUYẾT',
        fields: [['fix', 'Yêu cầu khắc phục']] },
  AT: { name: 'An toàn', shape: 'octagon', glyph: '!', title: 'BÁO CÁO AN TOÀN LAO ĐỘNG',
        fields: [['fix', 'Biện pháp khắc phục']] },
  NT: { name: 'Nghiệm thu', shape: 'dcircle', glyph: '✓', title: 'BÁO CÁO KIỂM TRA / NGHIỆM THU', fields: [] },
  HT: { name: 'Hiện trạng', shape: 'hexagon', glyph: 'H', title: 'BIÊN BẢN GHI NHẬN HIỆN TRẠNG', fields: [] },
  GC: { name: 'Ghi chú', shape: 'rsquare', glyph: 'i', title: 'BÁO CÁO GHI NHẬN HIỆN TRƯỜNG', fields: [] },
};
const CAT_KEYS = Object.keys(CATS);
const catCode = c => CATS[c]?.code || c;
const markCode = m => `${catCode(m.cat)}-${pad2(m.n)}`;
const ST = {
  todo: { label: 'Cần xử lý', color: '#e5484d' }, doing: { label: 'Đang xử lý', color: '#f59e0b' }, done: { label: 'Đã xong', color: '#16a34a', closed: true },
  vm_new: { label: 'Mới ghi nhận', color: '#e5484d' }, vm_sent: { label: 'Đã gửi', color: '#f59e0b' },
  vm_ans: { label: 'Đã phản hồi', color: '#2563eb' }, vm_closed: { label: 'Đã đóng', color: '#16a34a', closed: true },
  ps_new: { label: 'Ghi nhận', color: '#e5484d' }, ps_sub: { label: 'Đã trình', color: '#f59e0b' },
  ps_ok: { label: 'Đã duyệt', color: '#16a34a', closed: true }, ps_rej: { label: 'Từ chối', color: '#64748b', closed: true },
};
const FLOW = { VM: ['vm_new', 'vm_sent', 'vm_ans', 'vm_closed'], PS: ['ps_new', 'ps_sub', 'ps_ok', 'ps_rej'], _: ['todo', 'doing', 'done'] };
const flowOf = c => FLOW[c] || FLOW._;
const stOf = m => ST[m.status] || ST[flowOf(m.cat)[0]];
const isClosed = m => !!stOf(m).closed;
const isOverdue = m => !!m.due && !isClosed(m) && m.due < todayISO();
function mapStatus(oldSt, newCat) {
  const fl = flowOf(newCat);
  if (fl.includes(oldSt)) return oldSt;
  if (ST[oldSt]?.closed) return fl.find(s => ST[s].closed);
  const oldFl = Object.values(FLOW).find(f => f.includes(oldSt)) || FLOW._;
  const i = Math.max(0, oldFl.indexOf(oldSt));
  const open = fl.filter(s => !ST[s].closed);
  return open[Math.min(i, open.length - 1)];
}
const KINDS = { point: 'Điểm', rect: 'Vùng', cloud: 'Vùng mây', arrow: 'Mũi tên' };

/* SVG path of a category shape centred at 0,0 (y down) with nominal radius r. */
function shapeD(shape, r) {
  const f = v => +v.toFixed(2);
  const P = pts => 'M ' + pts.map(p => `${f(p[0])} ${f(p[1])}`).join(' L ') + ' Z';
  const reg = (n, R, a0) => Array.from({ length: n }, (_, i) => { const a = a0 + i * 2 * Math.PI / n; return [R * Math.cos(a), R * Math.sin(a)]; });
  const k = 0.5523 * r;
  switch (shape) {
    case 'diamond': return P([[0, -1.22 * r], [1.22 * r, 0], [0, 1.22 * r], [-1.22 * r, 0]]);
    case 'triangle': return P([[0, -1.3 * r], [1.2 * r, 0.85 * r], [-1.2 * r, 0.85 * r]]);
    case 'square': return P([[-0.92 * r, -0.92 * r], [0.92 * r, -0.92 * r], [0.92 * r, 0.92 * r], [-0.92 * r, 0.92 * r]]);
    case 'octagon': return P(reg(8, 1.06 * r, Math.PI / 8));
    case 'hexagon': return P(reg(6, 1.1 * r, 0));
    case 'rsquare': { const s = 0.92 * r, c = 0.42 * r;
      return `M ${f(-s + c)} ${f(-s)} L ${f(s - c)} ${f(-s)} Q ${f(s)} ${f(-s)} ${f(s)} ${f(-s + c)} L ${f(s)} ${f(s - c)} Q ${f(s)} ${f(s)} ${f(s - c)} ${f(s)} L ${f(-s + c)} ${f(s)} Q ${f(-s)} ${f(s)} ${f(-s)} ${f(s - c)} L ${f(-s)} ${f(-s + c)} Q ${f(-s)} ${f(-s)} ${f(-s + c)} ${f(-s)} Z`; }
    default: return `M ${f(r)} 0 C ${f(r)} ${f(k)} ${f(k)} ${f(r)} 0 ${f(r)} C ${f(-k)} ${f(r)} ${f(-r)} ${f(k)} ${f(-r)} 0 C ${f(-r)} ${f(-k)} ${f(-k)} ${f(-r)} 0 ${f(-r)} C ${f(k)} ${f(-r)} ${f(r)} ${f(-k)} ${f(r)} 0 Z`;
  }
}
const glyphDy = shape => shape === 'triangle' ? 0.22 : 0;
/** Inline SVG body (no <svg>) for a symbol centred at cx,cy. */
function symbolInner(cat, color, label, r = 13, cx = 0, cy = 0) {
  const shp = CATS[cat].shape;
  const fs = label.length > 2 ? r * 0.74 : label.length > 1 ? r * 0.9 : r * 1.0;
  return `<g transform="translate(${cx} ${cy})"><path d="${shapeD(shp, r)}" fill="${color}" stroke="#fff" stroke-width="${(r * 0.19).toFixed(1)}" stroke-linejoin="round"/>` +
    (shp === 'dcircle' ? `<circle r="${r * 0.7}" fill="none" stroke="#fff" stroke-width="${(r * 0.12).toFixed(1)}"/>` : '') +
    `<text y="${r * glyphDy(shp)}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="${fs.toFixed(1)}" font-weight="800" fill="#fff">${esc(label)}</text></g>`;
}
const catIcon = (cat, color = '#64748b', cls = 'cat-ic') => `<svg class="${cls}" viewBox="-17 -17 34 34">${symbolInner(cat, color, CATS[cat].glyph, 12.5)}</svg>`;

/** Revision-cloud segments around a polygon (any coordinate system). Returns [[start],[ctrl,end]...]. */
function cloudSegs(poly, bump) {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  const segs = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]), n = Math.max(2, Math.round(L / bump));
    for (let j = 0; j < n; j++) {
      const a = [p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n], b = [p[0] + (q[0] - p[0]) * (j + 1) / n, p[1] + (q[1] - p[1]) * (j + 1) / n];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, sl = L / n;
      let nx = -(b[1] - a[1]) / sl, ny = (b[0] - a[0]) / sl;
      if (nx * (mx - cx) + ny * (my - cy) < 0) { nx = -nx; ny = -ny; }
      segs.push([a, [mx + nx * sl * 0.45, my + ny * sl * 0.45], b]);
    }
  }
  return segs;
}
const segsToD = (segs, fy = 1) => 'M ' + segs[0][0][0].toFixed(2) + ' ' + (fy * segs[0][0][1]).toFixed(2) + ' ' +
  segs.map(s => `Q ${s[1][0].toFixed(2)} ${(fy * s[1][1]).toFixed(2)} ${s[2][0].toFixed(2)} ${(fy * s[2][1]).toFixed(2)}`).join(' ') + ' Z';
const rectPoly = (a, b) => { const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]); return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; };

/* ======================= IndexedDB (v2) ======================= */
let _db;
function idb() {
  if (!_db) _db = new Promise((res, rej) => {
    const r = indexedDB.open('pdfmark', 3);
    r.onupgradeneeded = e => {
      const d = r.result, tx = r.transaction, old = e.oldVersion;
      if (old < 1) {
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('pdfs', { keyPath: 'id' });
        d.createObjectStore('markers', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        const p = d.createObjectStore('photos', { keyPath: 'id' });
        p.createIndex('projectId', 'projectId'); p.createIndex('markerId', 'markerId');
      }
      if (old < 2) {
        d.createObjectStore('drawings', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        tx.objectStore('markers').createIndex('drawingId', 'drawingId');
        if (old >= 1) migrateV1(tx);
      }
      if (old < 3) d.createObjectStore('reports', { keyPath: 'id' }).createIndex('projectId', 'projectId');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => toast('Hãy đóng các cửa sổ khác của app để cập nhật dữ liệu');
  });
  return _db;
}
/* v1: each "project" was one PDF. Turn it into a project with one drawing (same id) and convert markers. */
function migrateV1(tx) {
  let def = {}; try { def = JSON.parse(localStorage.getItem('pm.rpDefaults') || '{}'); } catch {}
  const ps = tx.objectStore('projects'), ds = tx.objectStore('drawings'), ms = tx.objectStore('markers');
  ps.openCursor().onsuccess = e => {
    const c = e.target.result; if (!c) return;
    const p = c.value, r = p.report || {};
    ds.put({ id: p.id, projectId: p.id, name: p.name, pages: p.pages, thumb: p.thumb, lastPage: p.lastPage || 1, created: p.created, updated: p.updated });
    c.update({ id: p.id, name: r.project || p.name, code: '', loc: '', owner: '', to: r.to || def.to || '',
      company: def.company || '', logo: def.logo || '', author: def.author || '', signers: def.signers || '',
      prefix: '', seq: 1, created: p.created, updated: p.updated, rp: { summary: r.summary || '' } });
    c.continue();
  };
  const smap = { todo: 'vm_new', doing: 'vm_sent', done: 'vm_closed' };
  ms.openCursor().onsuccess = e => {
    const c = e.target.result; if (!c) return;
    const m = c.value;
    if (!m.cat) { m.cat = 'VM'; m.kind = 'point'; m.drawingId = m.projectId; m.status = smap[m.status] || 'vm_new'; m.extra = {}; c.update(m); }
    c.continue();
  };
}
async function op(stores, mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    let out; const r = fn(t);
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Giao dịch bị hủy (có thể do hết dung lượng)'));
  });
}
const DB = {
  get: (s, k) => op(s, 'readonly', t => t.objectStore(s).get(k)),
  put: (s, v) => op(s, 'readwrite', t => t.objectStore(s).put(v)),
  del: (s, k) => op(s, 'readwrite', t => t.objectStore(s).delete(k)),
  all: s => op(s, 'readonly', t => t.objectStore(s).getAll()),
  byIdx: (s, i, v) => op(s, 'readonly', t => t.objectStore(s).index(i).getAll(v)),
  delByIdx: (s, i, v) => op(s, 'readwrite', t => {
    const st = t.objectStore(s);
    st.index(i).openKeyCursor(IDBKeyRange.only(v)).onsuccess = e => { const c = e.target.result; if (c) { st.delete(c.primaryKey); c.continue(); } };
  }),
};
async function deleteDrawingData(did) {
  const ms = await DB.byIdx('markers', 'drawingId', did);
  for (const m of ms) { for (const pid of m.photoIds || []) await DB.del('photos', pid); await DB.del('markers', m.id); }
  await DB.del('pdfs', did); await DB.del('drawings', did);
}
async function deleteProjectData(pid) {
  for (const d of await DB.byIdx('drawings', 'projectId', pid)) await DB.del('pdfs', d.id);
  await DB.delByIdx('drawings', 'projectId', pid); await DB.delByIdx('markers', 'projectId', pid);
  await DB.delByIdx('photos', 'projectId', pid); await DB.delByIdx('reports', 'projectId', pid); await DB.del('projects', pid);
}
let pdfLibP = null;
/** pdf-lib + fontkit are only needed for exports: load them on demand (cached offline by the service worker). */
function loadPdfLib() {
  if (window.PDFLib && window.fontkit) return Promise.resolve();
  if (!pdfLibP) pdfLibP = Promise.all(['pdf-lib.min.js', 'fontkit.umd.min.js'].map(src => new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = src; sc.async = true;
    sc.onload = res; sc.onerror = () => { pdfLibP = null; rej(new Error('Không tải được thư viện ' + src + ' – hãy mở app khi có mạng một lần.')); };
    document.head.appendChild(sc);
  })));
  return pdfLibP;
}
function requestPersist() { try { navigator.storage?.persist?.(); } catch {} }

/* ======================= UI helpers ======================= */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function busy(text) { $('#busyText').textContent = text || 'Đang xử lý…'; $('#busy').hidden = false; }
function unbusy() { $('#busy').hidden = true; }
function modal({ title, html = '', buttons = [{ label: 'OK', value: true, cls: 'primary' }], onOpen, cls = '' }) {
  return new Promise(resolve => {
    const m = $('#modal');
    m.querySelector('.modal-box').className = 'modal-box ' + cls;
    $('#mTitle').textContent = title || '';
    $('#mBody').innerHTML = html;
    const act = $('#mActions'); act.innerHTML = '';
    let done = false;
    const finish = v => { if (done) return; done = true; m.hidden = true; resolve(v); };
    buttons.forEach(b => {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.cls || ''); el.textContent = b.label;
      el.onclick = () => finish(typeof b.value === 'function' ? b.value() : b.value);
      act.appendChild(el);
    });
    m.onclick = e => { if (e.target === m) finish(undefined); };
    m.hidden = false;
    onOpen && onOpen($('#mBody'), finish);
  });
}
const confirmBox = (title, html, okLabel = 'Đồng ý', danger = false) =>
  modal({ title, html, buttons: [{ label: 'Hủy', value: false }, { label: okLabel, value: true, cls: danger ? 'primary danger-bg' : 'primary' }] });
async function promptBox(title, value = '', placeholder = '') {
  return modal({
    title, html: `<input type="text" id="pbIn" value="${esc(value)}" placeholder="${esc(placeholder)}">`,
    buttons: [{ label: 'Hủy', value: null }, { label: 'Lưu', value: () => $('#pbIn').value.trim(), cls: 'primary' }],
    onOpen: (b, finish) => { const i = $('#pbIn', b); setTimeout(() => { i.focus(); i.select(); }, 50); i.onkeydown = e => { if (e.key === 'Enter') finish(i.value.trim()); }; },
  });
}
function menu(items) {
  const bd = $('#menuBackdrop'), mn = $('#menu');
  mn.innerHTML = '';
  items.forEach(it => {
    if (it === '-') { mn.appendChild(document.createElement('hr')); return; }
    const b = document.createElement('button');
    if (it.danger) b.className = 'danger';
    b.innerHTML = (it.icon ? `<svg><use href="#${it.icon}"/></svg>` : '') + `<span>${esc(it.label)}</span>`;
    b.onclick = () => { bd.hidden = true; it.action(); };
    mn.appendChild(b);
  });
  bd.onclick = e => { if (e.target === bd) bd.hidden = true; };
  bd.hidden = false;
}
/* Back-button stack: Android back gesture closes the top layer. */
const layers = [];
function pushLayer(name, close) { layers.push({ name, close }); history.pushState({ layer: name, n: layers.length }, ''); }
function closeLayer(name) {
  if (!layers.length) return;
  let idx = layers.length - 1;
  if (name) { idx = layers.map(l => l.name).lastIndexOf(name); if (idx < 0) return; }
  history.go(-(layers.length - idx));
}
const hasLayer = n => layers.some(l => l.name === n);
window.addEventListener('popstate', e => {
  const depth = e.state?.n || 0;
  while (layers.length > depth) layers.pop().close();
});
const asciiName = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  .replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_(?=\.)/g, '');
const canShareFile = file => { try { return !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch { return false; } };
async function shareFile(file) {
  try { await navigator.share({ files: [file] }); return true; }
  catch (e) {
    if (e.name === 'AbortError') return false;
    try { await navigator.share({ files: [file], title: file.name }); return true; } catch (e2) { if (e2.name === 'AbortError') return false; }
    toast('Không mở được bảng chia sẻ – chuyển sang lưu file'); await saveFile(file); return false;
  }
}
async function saveFile(file) {
  if (window.showSaveFilePicker && !/Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: file.name, types: [{ description: 'File', accept: { [file.type || 'application/octet-stream']: ['.' + file.name.split('.').pop()] } }] });
      const w = await h.createWritable(); await w.write(file); await w.close(); toast('Đã lưu file'); return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadBlob(file, file.name);
  toast('Đã tải về – xem trong thư mục Tải xuống (Downloads)', 4000);
}
/** Show a dialog so share/save happens inside a real tap (required by iOS / Android). */
async function deliverFile(blob, filename, title = 'File đã sẵn sàng', note = '') {
  const file = new File([blob], asciiName(filename), { type: blob.type || 'application/octet-stream' });
  const share = canShareFile(file), ios = isIOS(), iosApp = ios && isStandalone();
  const btns = [{ label: 'Đóng', value: 'close' }];
  if (!iosApp) btns.push({ label: 'Lưu về máy', value: 'save', cls: share ? '' : 'primary' });
  if (share) btns.push({ label: 'Chia sẻ…', value: 'share', cls: 'primary' });
  await modal({
    title, cls: 'deliver',
    html: `<div class="dl-file"><svg><use href="#i-doc"/></svg><div><b>${esc(file.name)}</b><small>${fmtSize(blob.size)}</small></div></div>
      ${share ? `<p class="dl-tip"><b>Chia sẻ</b> để gửi thẳng sang Zalo, Email, Messenger, Google Drive, OneDrive…${ios ? ' hoặc chọn <b>“Lưu vào Tệp”</b> để lưu trên iPhone.' : ''}</p>` :
        `<p class="dl-tip">Thiết bị này không hỗ trợ chia sẻ trực tiếp – bấm <b>Lưu về máy</b> rồi gửi file từ thư mục Tải xuống.</p>`}
      ${note ? `<p class="dl-tip">${note}</p>` : ''}`,
    buttons: btns.map(b => ({ ...b, value: () => {
      if (b.value === 'share') shareFile(file);
      if (b.value === 'save') saveFile(file);
      return b.value; } })),
  });
}
function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const url = src instanceof Blob ? URL.createObjectURL(src) : src;
    const img = new Image();
    img.onload = () => { res(img); if (src instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 0); };
    img.onerror = () => rej(new Error('Không đọc được ảnh'));
    img.src = url;
  });
}
const canvasToBlob = (c, type = 'image/jpeg', q = 0.85) => new Promise(r => c.toBlob(r, type, q));
async function compressImage(blob, maxSide, q) {
  const img = await loadImage(blob);
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
  return { blob: await canvasToBlob(c, 'image/jpeg', q), w, h };
}
const urlCache = new Map();
function blobURL(key, blob) {
  if (!blob) return '';
  let u = urlCache.get(key);
  if (!u) { u = URL.createObjectURL(blob); urlCache.set(key, u); }
  return u;
}
function clearURLCache() { urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear(); }
function showScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }

/* ======================= STATE ======================= */
const S = {
  project: null, drawings: [], markers: [], photos: new Map(),
  drawing: null, pdfBlob: null, doc: null, pageNum: 1, page: null, base: null, baseRes: 1,
  view: { s: 1, tx: 0, ty: 0 },
  addMode: false, tool: { cat: 'VM', kind: 'point' }, moveId: null, cur: null, showThumbs: false,
  filter: { cats: [], st: 'all', owner: '', over: false },
};
try { S.showThumbs = localStorage.getItem('pm.thumbs') === '1'; const t = JSON.parse(localStorage.getItem('pm.tool') || 'null'); if (t && CATS[t.cat] && KINDS[t.kind]) S.tool = t; } catch {}
const dwgName = id => S.drawings.find(d => d.id === id)?.name || '';

/* ======================= HOME (projects) ======================= */
async function renderHome() {
  clearURLCache();
  const [ps, ds, ms] = await Promise.all([DB.all('projects'), DB.all('drawings'), DB.all('markers')]);
  ps.sort((a, b) => b.updated - a.updated);
  $('#emptyHome').hidden = ps.length > 0;
  const list = $('#projList'); list.innerHTML = '';
  for (const p of ps) {
    const dws = ds.filter(d => d.projectId === p.id).sort((a, b) => a.created - b.created);
    const mk = ms.filter(m => m.projectId === p.id);
    const open = mk.filter(m => !isClosed(m)).length, over = mk.filter(isOverdue).length;
    const el = document.createElement('div'); el.className = 'proj'; el.setAttribute('role', 'button');
    el.innerHTML = `<div class="th" style="background-image:url('${dws[0]?.thumb ? blobURL('dt' + dws[0].id, dws[0].thumb) : ''}')"></div>
      <div class="info"><div class="name">${esc(p.name)}</div>
        <div class="meta">${p.code ? esc(p.code) + ' · ' : ''}${dws.length} bản vẽ · ${mk.length} điểm</div>
        <div class="dots">${mk.length ? `<span class="dot"><i style="background:${open ? '#e5484d' : '#16a34a'}"></i>${open} chưa xong</span>` : ''}${over ? `<span class="dot" style="color:#dc2626"><i style="background:#dc2626"></i>${over} quá hạn</span>` : ''}<span class="dot">${fmtDate(p.updated)}</span></div></div>
      <button class="icon-btn dark more" aria-label="Tùy chọn"><svg><use href="#i-more"/></svg></button>`;
    el.onclick = e => { if (e.target.closest('.more')) projectMenu(p); else openProject(p.id); };
    list.appendChild(el);
  }
  try { const est = await navigator.storage?.estimate?.(); if (est) $('#storageInfo').textContent = `Đã dùng ${fmtSize(est.usage || 0)} bộ nhớ app · Phiên bản ${APP_VERSION}`; } catch {}
}
function projectMenu(p) {
  menu([
    { label: 'Mở dự án', icon: 'i-folder', action: () => openProject(p.id) },
    { label: 'Sửa thông tin dự án', icon: 'i-edit', action: async () => { await openProject(p.id); openProjPanel(S.project); } },
    { label: 'Sao lưu dự án (.pmk)', icon: 'i-export', action: () => backupProject(p.id) },
    '-',
    { label: 'Xóa dự án', icon: 'i-trash', danger: true, action: () => deleteProjectAsk(p) },
  ]);
}
async function deleteProjectAsk(p) {
  if (!await confirmBox('Xóa dự án?', `Xóa <b>${esc(p.name)}</b> cùng toàn bộ bản vẽ, điểm ghi nhận và ảnh. Không thể hoàn tác.<br><br>Nên <b>sao lưu (.pmk)</b> trước khi xóa.`, 'Xóa', true)) return false;
  busy('Đang xóa…'); await deleteProjectData(p.id); unbusy(); toast('Đã xóa dự án'); return true;
}

/* ======================= PROJECT INFO PANEL ======================= */
let ppLogo = '', ppEditing = null;
const lastDefaults = () => { try { return JSON.parse(localStorage.getItem('pm.projDefaults') || '{}'); } catch { return {}; } };
function openProjPanel(p) {
  ppEditing = p || null;
  const d = p || { ...lastDefaults(), name: '', code: '', loc: '', owner: '', prefix: '', seq: 1 };
  $('#ppTitle').textContent = p ? 'Thông tin dự án' : 'Dự án mới';
  $('#ppSave').textContent = p ? 'Lưu thông tin dự án' : 'Tạo dự án';
  const v = (id, val) => { $(id).value = val ?? ''; };
  v('#ppName', d.name); v('#ppCode', d.code); v('#ppLoc', d.loc); v('#ppOwner', d.owner); v('#ppTo', d.to);
  v('#ppCompany', d.company); v('#ppAuthor', d.author);
  v('#ppSigners', d.signers || 'Đại diện đơn vị lập\nĐại diện Tư vấn giám sát\nĐại diện Chủ đầu tư');
  v('#ppPrefix', d.prefix); v('#ppSeq', d.seq || 1);
  ppLogo = d.logo || ''; paintPpLogo();
  $('#projPanel').hidden = false;
  pushLayer('proj', () => { $('#projPanel').hidden = true; });
  if (!p) setTimeout(() => $('#ppName').focus(), 100);
}
function paintPpLogo() {
  $('#ppLogoImg').hidden = !ppLogo; $('#ppLogoNone').hidden = !!ppLogo; $('#ppLogoDel').hidden = !ppLogo;
  if (ppLogo) $('#ppLogoImg').src = ppLogo;
}
$('#ppClose').onclick = () => closeLayer('proj');
$('#ppLogoPick').onclick = () => $('#inLogo').click();
$('#ppLogoDel').onclick = () => { ppLogo = ''; paintPpLogo(); };
$('#inLogo').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const img = await loadImage(f);
    const k = Math.min(1, 600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    ppLogo = c.toDataURL('image/png'); paintPpLogo();
  } catch { toast('Không đọc được ảnh logo'); }
});
$('#ppSave').onclick = async () => {
  const name = $('#ppName').value.trim();
  if (!name) { toast('Hãy nhập tên dự án'); $('#ppName').focus(); return; }
  const data = { name, code: $('#ppCode').value.trim(), loc: $('#ppLoc').value.trim(), owner: $('#ppOwner').value.trim(),
    to: $('#ppTo').value.trim(), company: $('#ppCompany').value.trim(), author: $('#ppAuthor').value.trim(),
    signers: $('#ppSigners').value, prefix: $('#ppPrefix').value.trim(), seq: Math.max(1, parseInt($('#ppSeq').value, 10) || 1), logo: ppLogo };
  try { localStorage.setItem('pm.projDefaults', JSON.stringify({ company: data.company, author: data.author, signers: data.signers, logo: data.logo, to: data.to })); } catch {}
  const now = Date.now();
  if (ppEditing) {
    Object.assign(ppEditing, data, { updated: now });
    await DB.put('projects', ppEditing);
    closeLayer('proj'); renderProject(); toast('Đã lưu thông tin dự án');
    if (hasLayer('report')) fillReportProjectHint();
  } else {
    const p = { id: uid(), ...data, created: now, updated: now, rp: {} };
    await DB.put('projects', p); requestPersist();
    closeLayer('proj'); await sleep(80); await openProject(p.id);
    toast('Đã tạo dự án – thêm bản vẽ PDF để bắt đầu');
  }
};

/* ======================= PROJECT SCREEN ======================= */
async function openProject(pid) {
  busy('Đang mở dự án…');
  try {
    const p = await DB.get('projects', pid); if (!p) throw new Error('Không tìm thấy dự án');
    S.project = p;
    S.drawings = (await DB.byIdx('drawings', 'projectId', pid)).sort((a, b) => a.created - b.created);
    S.markers = await DB.byIdx('markers', 'projectId', pid);
    S.photos = new Map((await DB.byIdx('photos', 'projectId', pid)).map(ph => [ph.id, ph]));
    S.filter = { cats: [], st: 'all', owner: '', over: false };
    showScreen('project');
    if (!hasLayer('project')) pushLayer('project', closeProject);
    renderProject(); renderReports();
  } catch (e) { console.error(e); modal({ title: 'Lỗi', html: esc(e.message || e) }); }
  finally { unbusy(); }
}
function closeProject() { S.project = null; S.drawings = []; S.markers = []; S.photos = new Map(); showScreen('home'); renderHome(); }
function renderProject() {
  const p = S.project; if (!p) return;
  $('#pjName').textContent = p.name; $('#pjCode').textContent = [p.code, p.loc].filter(Boolean).join(' · ');
  const row = (k, v) => v ? `<div class="r"><span>${k}</span><b>${esc(v)}</b></div>` : '';
  $('#pjInfo').innerHTML = row('Chủ đầu tư', p.owner) + row('Đơn vị lập', p.company) + row('Người lập', p.author) +
    row('Số BC tiếp theo', (p.prefix || '') + pad2(p.seq || 1)) +
    (!(p.owner || p.company || p.author) ? '<div class="r"><span style="min-width:0">Chưa khai báo chủ đầu tư, đơn vị lập, logo…</span></div>' : '') +
    `<button class="btn ghost edit" id="pjEdit"><svg><use href="#i-edit"/></svg> Sửa thông tin dự án</button>`;
  $('#pjEdit').onclick = () => openProjPanel(S.project);
  $('#pjStats').innerHTML = CAT_KEYS.map(c => {
    const ms = S.markers.filter(m => m.cat === c), open = ms.filter(m => !isClosed(m)).length;
    return `<div class="cat-stat ${ms.length ? '' : 'zero'}">${catIcon(c, ms.length ? (open ? '#e5484d' : '#16a34a') : '#94a3b8')}<div><b>${ms.length}</b> ${esc(CATS[c].name)}<small>${ms.length ? open + ' chưa xong' : '—'}</small></div></div>`;
  }).join('');
  $('#pjDwgCount').textContent = S.drawings.length ? `(${S.drawings.length})` : '';
  $('#emptyDwg').hidden = S.drawings.length > 0;
  const list = $('#dwgList'); list.innerHTML = '';
  S.drawings.forEach(d => {
    const mk = S.markers.filter(m => m.drawingId === d.id), open = mk.filter(m => !isClosed(m)).length;
    const el = document.createElement('div'); el.className = 'proj'; el.setAttribute('role', 'button');
    el.innerHTML = `<div class="th" style="background-image:url('${blobURL('dt' + d.id, d.thumb)}')"></div>
      <div class="info"><div class="name">${esc(d.name)}</div><div class="meta">${d.pages} trang · ${mk.length} điểm${mk.length ? ` · ${open} chưa xong` : ''}</div>
      <div class="dots">${CAT_KEYS.map(c => { const n = mk.filter(m => m.cat === c).length; return n ? `<span class="dot">${catIcon(c, '#64748b', 'cat-ic sm')}${n}</span>` : ''; }).join('')}</div></div>
      <button class="icon-btn dark more" aria-label="Tùy chọn"><svg><use href="#i-more"/></svg></button>`;
    el.onclick = e => { if (e.target.closest('.more')) drawingMenu(d); else openDrawing(d.id); };
    list.appendChild(el);
  });
}
async function renderReports() {
  const box = $('#rptList'); if (!box || !S.project) return;
  const rs = (await DB.byIdx('reports', 'projectId', S.project.id)).sort((a, b) => b.created - a.created);
  $('#rptTitle').hidden = !rs.length; box.innerHTML = '';
  rs.forEach(r => {
    const el = document.createElement('div'); el.className = 'rpt'; el.setAttribute('role', 'button');
    el.innerHTML = `<svg class="rpt-ic"><use href="#i-doc"/></svg><div class="info"><div class="name">${esc(r.title || r.name)}</div>
      <div class="meta">${r.no ? 'Số ' + esc(r.no) + ' · ' : ''}${r.count || 0} điểm · ${fmtSize(r.size)} · ${fmtDate(r.created)}</div></div>
      <button class="btn primary sm-btn share">Chia sẻ</button><button class="icon-btn dark more" aria-label="Tùy chọn"><svg><use href="#i-more"/></svg></button>`;
    const file = () => new File([r.blob], r.name, { type: 'application/pdf' });
    el.querySelector('.share').onclick = e => { e.stopPropagation(); const f = file(); if (canShareFile(f)) shareFile(f); else saveFile(f); };
    el.onclick = e => {
      if (e.target.closest('.share')) return;
      menu([
        { label: 'Chia sẻ sang ứng dụng khác', icon: 'i-export', action: () => { const f = file(); if (canShareFile(f)) shareFile(f); else saveFile(f); } },
        ...(isIOS() && isStandalone() ? [] : [{ label: 'Lưu về máy', icon: 'i-doc', action: () => saveFile(file()) }]),
        '-',
        { label: 'Xóa báo cáo này', icon: 'i-trash', danger: true, action: async () => { if (await confirmBox('Xóa báo cáo?', esc(r.name), 'Xóa', true)) { await DB.del('reports', r.id); renderReports(); } } },
      ]);
    };
    box.appendChild(el);
  });
}
function drawingMenu(d) {
  menu([
    { label: 'Mở bản vẽ', icon: 'i-doc', action: () => openDrawing(d.id) },
    { label: 'Đổi tên bản vẽ', icon: 'i-edit', action: () => renameDrawing(d) },
    '-',
    { label: 'Xóa bản vẽ', icon: 'i-trash', danger: true, action: async () => {
      const n = S.markers.filter(m => m.drawingId === d.id).length;
      if (!await confirmBox('Xóa bản vẽ?', `Xóa <b>${esc(d.name)}</b> cùng ${n} điểm ghi nhận và ảnh kèm theo.`, 'Xóa', true)) return;
      busy('Đang xóa…'); await deleteDrawingData(d.id); unbusy();
      S.drawings = S.drawings.filter(x => x.id !== d.id); S.markers = S.markers.filter(m => m.drawingId !== d.id);
      touchProject(); renderProject(); toast('Đã xóa bản vẽ'); } },
  ]);
}
async function renameDrawing(d) {
  const n = await promptBox('Đổi tên bản vẽ', d.name); if (!n) return;
  d.name = n; d.updated = Date.now(); await DB.put('drawings', d);
  if (S.drawing?.id === d.id) $('#vTitle').textContent = n;
  renderProject();
}
$('#pjBack').onclick = () => closeLayer('project');
$('#pjAddDwg').onclick = () => $('#inPdf').click();
$('#pjReport').onclick = () => openReport();
$('#pjMenu').onclick = () => menu([
  { label: 'Sửa thông tin dự án', icon: 'i-edit', action: () => openProjPanel(S.project) },
  { label: 'Lập báo cáo PDF', icon: 'i-export', action: () => openReport() },
  { label: 'Xuất danh sách (Excel/CSV)', icon: 'i-list', action: exportCSV },
  { label: 'Sao lưu dự án (.pmk)', icon: 'i-doc', action: () => backupProject(S.project.id) },
  { label: 'Đánh số lại các điểm', icon: 'i-pin', action: renumber },
  '-',
  { label: 'Xóa dự án', icon: 'i-trash', danger: true, action: async () => { if (await deleteProjectAsk(S.project)) closeLayer('project'); } },
]);

async function renderPdfThumb(doc) {
  const page = await doc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 260 / Math.max(vp1.width, vp1.height) });
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvasToBlob(c, 'image/jpeg', 0.8);
}
async function addDrawings(files) {
  if (!S.project) return;
  let last = null;
  for (const [i, file] of files.entries()) {
    busy(`Đang thêm bản vẽ ${i + 1}/${files.length}…`);
    try {
      const buf = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
      const thumb = await renderPdfThumb(doc);
      const id = uid(), now = Date.now() + i;
      await DB.put('pdfs', { id, blob: new Blob([buf], { type: 'application/pdf' }) });
      const d = { id, projectId: S.project.id, name: file.name.replace(/\.pdf$/i, ''), pages: doc.numPages, thumb, lastPage: 1, created: now, updated: now };
      await DB.put('drawings', d); S.drawings.push(d); last = d;
      doc.destroy();
    } catch (err) {
      console.error(err);
      await modal({ title: 'Không mở được PDF', html: `<b>${esc(file.name)}</b><br>` + esc(err?.name === 'PasswordException' ? 'File PDF có mật khẩu – hãy gỡ mật khẩu trước.' : (err?.message || err)) });
    }
  }
  unbusy(); touchProject(); renderProject(); requestPersist();
  if (files.length === 1 && last) openDrawing(last.id);
}
$('#inPdf').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addDrawings(fs); });

let touchTimer;
function touchProject() {
  clearTimeout(touchTimer);
  touchTimer = setTimeout(() => { if (S.project) { S.project.updated = Date.now(); DB.put('projects', S.project); } }, 400);
}

/* ======================= VIEWER ======================= */
const stage = $('#stage'), content = $('#content'), cvBase = $('#cvBase'), cvDetail = $('#cvDetail'), mkLayer = $('#mkLayer'), geo = $('#geoLayer');
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const dwgMarkers = () => S.markers.filter(m => m.drawingId === S.drawing?.id);

async function openDrawing(did, page) {
  busy('Đang tải bản vẽ…');
  try {
    const d = S.drawings.find(x => x.id === did); const rec = await DB.get('pdfs', did);
    if (!d || !rec) throw new Error('Không tìm thấy dữ liệu bản vẽ');
    if (S.doc && S.drawing?.id !== did) { try { S.doc.destroy(); } catch {} S.doc = null; }
    S.drawing = d; S.pdfBlob = rec.blob;
    if (!S.doc) S.doc = await pdfjsLib.getDocument({ data: new Uint8Array(await rec.blob.arrayBuffer()) }).promise;
    S.addMode = false; S.moveId = null; S.cur = null;
    $('#vTitle').textContent = d.name; $('#vSub').textContent = S.project.name;
    $('#btnThumbs').classList.toggle('on', S.showThumbs);
    showScreen('viewer');
    if (!hasLayer('viewer')) pushLayer('viewer', closeViewer);
    setAddMode(false); updateCounts(); updateFilterUI();
    await gotoPage(clamp(page || d.lastPage || 1, 1, S.doc.numPages));
  } catch (err) { console.error(err); modal({ title: 'Lỗi', html: esc(err.message || err) }); }
  finally { unbusy(); }
}
function closeViewer() {
  setAddMode(false); setMoveMode(null); cancelRenders();
  try { S.doc?.destroy(); } catch {}
  S.doc = null; S.page = null; S.drawing = null; S.base = null;
  showScreen('project'); renderProject();
}

let renderGen = 0, baseTask = null, detailTask = null, detailTimer = null;
function cancelRenders() {
  renderGen++;
  try { baseTask?.cancel(); } catch {} try { detailTask?.cancel(); } catch {}
  baseTask = detailTask = null; clearTimeout(detailTimer);
}
async function gotoPage(n, opts = {}) {
  if (!S.doc) return;
  n = clamp(n, 1, S.doc.numPages);
  cancelRenders();
  const gen = renderGen;
  S.pageNum = n; $('#pageLoading').hidden = false;
  const page = await S.doc.getPage(n);
  if (gen !== renderGen) return;
  S.page = page; S.baseRes = 0; layoutBase();
  if (!opts.keepView) fitView();
  cvDetail.style.display = 'none';
  if (n === 1 && S.drawing.thumb) paintThumbPlaceholder(gen);
  else { const ctx = cvBase.getContext('2d'); cvBase.width = 8; cvBase.height = 8; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 8, 8); }
  renderMarks(); updatePager();
  if (S.drawing.lastPage !== n) { S.drawing.lastPage = n; DB.put('drawings', S.drawing); }
  await renderBase(gen);
  scheduleDetail(250);
}
async function paintThumbPlaceholder(gen) {
  try {
    const img = await loadImage(S.drawing.thumb);
    if (gen !== renderGen || S.baseRes > 0.01) return;
    cvBase.width = img.naturalWidth; cvBase.height = img.naturalHeight; cvBase.getContext('2d').drawImage(img, 0, 0);
  } catch {}
}
function layoutBase() {
  const W = stage.clientWidth, H = stage.clientHeight;
  const vp1 = S.page.getViewport({ scale: 1 });
  const fit = Math.min((W - 20) / vp1.width, (H - 20) / vp1.height);
  S.base = { fit, w: vp1.width * fit, h: vp1.height * fit, vp: S.page.getViewport({ scale: fit }) };
  content.style.width = S.base.w + 'px'; content.style.height = S.base.h + 'px';
  cvBase.style.width = S.base.w + 'px'; cvBase.style.height = S.base.h + 'px';
  geo.setAttribute('width', S.base.w); geo.setAttribute('height', S.base.h);
  geo.style.width = S.base.w + 'px'; geo.style.height = S.base.h + 'px';
  geo.setAttribute('viewBox', `0 0 ${S.base.w} ${S.base.h}`);
}
/** Two passes: a quick low-res draw so the drawing appears at once, then a sharper one. */
async function renderBase(gen) {
  const page = S.page, b = S.base, area = b.w * b.h;
  const passes = [Math.min(1, Math.sqrt(1.2e6 / area)), Math.min(DPR() * 1.25, 4096 / Math.max(b.w, b.h), Math.sqrt(4e6 / area))];
  for (const [i, k] of passes.entries()) {
    if (i === 1 && k <= passes[0] * 1.05) break;
    const vp = page.getViewport({ scale: b.fit * k });
    const off = document.createElement('canvas'); off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
    const ctx = off.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, off.width, off.height);
    try { baseTask = page.render({ canvasContext: ctx, viewport: vp }); await baseTask.promise; }
    catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn(e); return; }
    finally { baseTask = null; }
    if (gen !== renderGen) return;
    cvBase.width = off.width; cvBase.height = off.height; cvBase.getContext('2d').drawImage(off, 0, 0);
    S.baseRes = k;
    if (i === 0) { $('#pageLoading').hidden = false; }
  }
  $('#pageLoading').hidden = true;
}
function scheduleDetail(ms = 260) { clearTimeout(detailTimer); detailTimer = setTimeout(renderDetail, ms); }
async function renderDetail() {
  if (!S.page || !S.base) return;
  const { s, tx, ty } = S.view, b = S.base, eff = s * DPR();
  if (eff <= S.baseRes * 1.15) { cvDetail.style.display = 'none'; return; }
  const W = stage.clientWidth, H = stage.clientHeight;
  const x0 = clamp(-tx / s, 0, b.w), y0 = clamp(-ty / s, 0, b.h), x1 = clamp((W - tx) / s, 0, b.w), y1 = clamp((H - ty) / s, 0, b.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return;
  let k = eff;
  if ((x1 - x0) * (y1 - y0) * k * k > 4.5e6) k = Math.sqrt(4.5e6 / ((x1 - x0) * (y1 - y0)));
  try { detailTask?.cancel(); } catch {}
  const gen = renderGen, page = S.page, vp = page.getViewport({ scale: b.fit * k });
  const off = document.createElement('canvas'); off.width = Math.ceil((x1 - x0) * k); off.height = Math.ceil((y1 - y0) * k);
  const ctx = off.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, off.width, off.height);
  const task = page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -x0 * k, -y0 * k] });
  detailTask = task;
  try { await task.promise; } catch { return; }
  if (detailTask === task) detailTask = null;
  if (gen !== renderGen || page !== S.page) return;
  cvDetail.width = off.width; cvDetail.height = off.height; cvDetail.getContext('2d').drawImage(off, 0, 0);
  Object.assign(cvDetail.style, { display: 'block', left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px' });
}

/* ---------- view transform ---------- */
const MIN_S = 0.5, MAX_S = 40;
function applyView() {
  const { s, tx, ty } = S.view;
  content.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
  content.style.setProperty('--inv', 1 / s);
}
function clampView() {
  const W = stage.clientWidth, H = stage.clientHeight, v = S.view, b = S.base, cw = b.w * v.s, ch = b.h * v.s, m = 60;
  v.tx = cw <= W ? (W - cw) / 2 : clamp(v.tx, W - cw - m, m);
  v.ty = ch <= H ? (H - ch) / 2 : clamp(v.ty, H - ch - m, m);
}
const fitTarget = () => { const W = stage.clientWidth, H = stage.clientHeight; return { s: 1, tx: (W - S.base.w) / 2, ty: (H - S.base.h) / 2 }; };
function fitView() { S.view = fitTarget(); applyView(); }
function zoomAt(sx, sy, ns) {
  const v = S.view; ns = clamp(ns, MIN_S, MAX_S);
  const bx = (sx - v.tx) / v.s, by = (sy - v.ty) / v.s;
  v.s = ns; v.tx = sx - bx * ns; v.ty = sy - by * ns; clampView(); applyView();
}
let animId = 0;
function animateView(target, ms = 260) {
  const from = { ...S.view }, t0 = performance.now(), id = ++animId;
  return new Promise(res => {
    const step = now => {
      if (id !== animId) return res();
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      S.view.s = from.s + (target.s - from.s) * e; S.view.tx = from.tx + (target.tx - from.tx) * e; S.view.ty = from.ty + (target.ty - from.ty) * e;
      applyView();
      if (k < 1) requestAnimationFrame(step); else { scheduleDetail(0); res(); }
    };
    requestAnimationFrame(step);
  });
}
function focusBase(bx, by, s, fx = 0.5, fy = 0.5) {
  const W = stage.clientWidth, H = stage.clientHeight;
  return animateView({ s, tx: W * fx - bx * s, ty: H * fy - by * s });
}

/* ---------- gestures (pan / pinch / tap / draw) ---------- */
const ptrs = new Map();
let gest = null, lastTap = { t: 0, x: 0, y: 0 };
const stagePt = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY }; };
const screenToBase = p => { const v = S.view; return { x: (p.x - v.tx) / v.s, y: (p.y - v.ty) / v.s }; };
const clampBase = bp => ({ x: clamp(bp.x, 0, S.base.w), y: clamp(bp.y, 0, S.base.h) });
const insideBase = bp => bp.x >= 0 && bp.y >= 0 && bp.x <= S.base.w && bp.y <= S.base.h;
function drawKind() {
  if (S.moveId) { const m = S.markers.find(x => x.id === S.moveId); return m?.kind || 'point'; }
  return S.addMode ? S.tool.kind : null;
}
function startPan(p) { gest = { type: 'pan', sx: p.x, sy: p.y, tx0: S.view.tx, ty0: S.view.ty, t: Date.now(), moved: false, p }; }
stage.addEventListener('pointerdown', e => {
  if (!S.base || e.target.closest('.hint,.filter-bar')) return;
  stage.setPointerCapture(e.pointerId);
  const p = stagePt(e); ptrs.set(e.pointerId, p);
  const dk = drawKind();
  if (ptrs.size === 1) {
    if (dk && dk !== 'point') {
      const bp = screenToBase(p);
      if (!insideBase(bp)) { toast('Hãy bắt đầu kéo trong trang bản vẽ'); ptrs.delete(e.pointerId); return; }
      gest = { type: 'draw', a: bp, b: bp, p0: p };
      drawDraft(dk, bp, bp);
    } else startPan(p);
  } else if (ptrs.size === 2) {
    clearDraft();
    const [a, b] = [...ptrs.values()];
    gest = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, v0: { ...S.view } };
  }
});
stage.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId) || !gest) return;
  const p = stagePt(e); ptrs.set(e.pointerId, p);
  if (gest.type === 'draw' && ptrs.size === 1) {
    gest.b = clampBase(screenToBase(p)); drawDraft(drawKind(), gest.a, gest.b);
  } else if (gest.type === 'pan' && ptrs.size === 1) {
    const dx = p.x - gest.sx, dy = p.y - gest.sy;
    if (!gest.moved && Math.hypot(dx, dy) > 8) gest.moved = true;
    if (gest.moved) { S.view.tx = gest.tx0 + dx; S.view.ty = gest.ty0 + dy; clampView(); applyView(); }
  } else if (gest.type === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, v0 = gest.v0;
    const ns = clamp(v0.s * d / gest.d0, MIN_S, MAX_S), bx = (gest.mx - v0.tx) / v0.s, by = (gest.my - v0.ty) / v0.s;
    S.view.s = ns; S.view.tx = mx - bx * ns; S.view.ty = my - by * ns; clampView(); applyView();
  }
});
function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
  if (gest?.type === 'draw' && ptrs.size === 0) {
    const g = gest; gest = null; clearDraft();
    if (e.type === 'pointerup') finishDraw(g, p);
  } else if (gest?.type === 'pan' && ptrs.size === 0) {
    if (!gest.moved && Date.now() - gest.t < 600 && e.type === 'pointerup') handleTap(p);
    gest = null; scheduleDetail();
  } else if (gest?.type === 'pinch') {
    if (ptrs.size === 1) { startPan([...ptrs.values()][0]); gest.moved = true; }
    else if (ptrs.size === 0) gest = null;
    if (S.view.s < 1) animateView(fitTarget());
    scheduleDetail();
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', e => {
  if (!S.base) return; e.preventDefault();
  const p = stagePt(e); zoomAt(p.x, p.y, S.view.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022))); scheduleDetail();
}, { passive: false });
stage.addEventListener('contextmenu', e => e.preventDefault());

const toPdf = bp => S.base.vp.convertToPdfPoint(bp.x, bp.y);
function finishDraw(g, p) {
  const kind = drawKind(), dist = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) * S.view.s;
  let a = g.a, b = g.b;
  if (dist < 14) {
    if (kind === 'arrow') { toast('Kéo từ chỗ đặt ký hiệu đến vị trí cần chỉ'); return; }
    const h = 40 / S.view.s; a = clampBase({ x: g.a.x - h, y: g.a.y - h * 0.7 }); b = clampBase({ x: g.a.x + h, y: g.a.y + h * 0.7 });
  }
  // arrow: drag start = tail (symbol) → end = tip (target). Stored as x,y = tip; x2,y2 = tail.
  const [px, py] = toPdf(kind === 'arrow' ? b : a), [qx, qy] = toPdf(kind === 'arrow' ? a : b);
  if (S.moveId) {
    const m = S.markers.find(x => x.id === S.moveId);
    Object.assign(m, { x: px, y: py, x2: qx, y2: qy, page: S.pageNum });
    saveMarker(m); setMoveMode(null); renderMarks(); openSheet(m); toast(`Đã vẽ lại ${markCode(m)}`);
  } else createMark({ kind, x: px, y: py, x2: qx, y2: qy });
}
function handleTap(p) {
  const hit = document.elementFromPoint(p.cx, p.cy)?.closest?.('.mk');
  const bp = screenToBase(p);
  if (S.moveId) {
    if (!insideBase(bp)) { toast('Hãy chạm vào trong trang bản vẽ'); return; }
    const m = S.markers.find(x => x.id === S.moveId);
    const [px, py] = toPdf(bp);
    Object.assign(m, { x: px, y: py, page: S.pageNum });
    saveMarker(m); setMoveMode(null); renderMarks(); openSheet(m); toast(`Đã chuyển ${markCode(m)} tới vị trí mới`);
    return;
  }
  if (S.addMode) {
    if (!insideBase(bp)) { toast('Hãy chạm vào trong trang bản vẽ'); return; }
    const [px, py] = toPdf(bp); createMark({ kind: 'point', x: px, y: py }); return;
  }
  if (hit) { const m = S.markers.find(x => x.id === hit.dataset.id); if (m) openSheet(m); return; }
  const now = Date.now();
  if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
    lastTap.t = 0;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (S.view.s >= 6) animateView(fitTarget()); else focusBase(bp.x, bp.y, S.view.s * 2.5, p.x / W, p.y / H);
    return;
  }
  lastTap = { t: now, x: p.x, y: p.y };
  if (S.cur) closeLayer('sheet');
}

/* ---------- marks: geometry & rendering ---------- */
const NS = 'http://www.w3.org/2000/svg';
const vpt = (x, y) => { const [a, b] = S.base.vp.convertToViewportPoint(x, y); return [a, b]; };
/** Display (base) geometry for a mark: anchor of symbol, and shape points. */
function markGeom(m, toDisp) {
  const a = toDisp(m.x, m.y);
  if (m.kind === 'rect' || m.kind === 'cloud') {
    const b = toDisp(m.x2, m.y2), poly = rectPoly(a, b);
    return { poly, anchor: [poly[1][0], poly[1][1]] };
  }
  if (m.kind === 'arrow') { const b = toDisp(m.x2, m.y2); return { tip: a, tail: b, anchor: b }; }
  return { anchor: a, point: a };
}
const passFilter = m => {
  const f = S.filter;
  if (f.cats.length && !f.cats.includes(m.cat)) return false;
  if (f.st === 'open' && isClosed(m)) return false;
  if (f.st === 'closed' && !isClosed(m)) return false;
  if (f.owner && (m.owner || '') !== f.owner) return false;
  if (f.over && !isOverdue(m)) return false;
  return true;
};
const filterActive = () => { const f = S.filter; return !!(f.cats.length || f.st !== 'all' || f.owner || f.over); };
function svgEl(tag, attrs) { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; }
function renderMarks() {
  if (!S.base) return;
  mkLayer.innerHTML = ''; geo.innerHTML = '';
  const items = dwgMarkers().filter(m => m.page === S.pageNum && (passFilter(m) || m.id === S.cur?.id)).map(m => ({ m, g: markGeom(m, vpt) }))
    .sort((p, q) => p.g.anchor[1] - q.g.anchor[1]);
  const frag = document.createDocumentFragment();
  for (const { m, g } of items) {
    const col = stOf(m).color;
    if (g.poly) {
      const d = m.kind === 'cloud' ? segsToD(cloudSegs(g.poly, clamp(Math.min(g.poly[2][0] - g.poly[0][0], g.poly[2][1] - g.poly[0][1]) / 3.5, 3, 22)))
        : `M ${g.poly.map(p => p.join(' ')).join(' L ')} Z`;
      geo.appendChild(svgEl('path', { d, class: 'halo' }));
      geo.appendChild(svgEl('path', { d, class: 'g fillv', stroke: col, fill: col }));
    } else if (g.tip) {
      const d = `M ${g.tail.join(' ')} L ${g.tip.join(' ')}`;
      geo.appendChild(svgEl('path', { d, class: 'halo' }));
      geo.appendChild(svgEl('path', { d, class: 'g', stroke: col }));
      const ah = document.createElement('div'); ah.className = 'ah';
      ah.style.left = g.tip[0] + 'px'; ah.style.top = g.tip[1] + 'px';
      ah.style.setProperty('--a', Math.atan2(g.tip[1] - g.tail[1], g.tip[0] - g.tail[0]) + 'rad');
      ah.innerHTML = `<svg viewBox="-16 -9 18 18"><path d="M 2 0 L -14 -7.5 L -10 0 L -14 7.5 Z" fill="${col}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
      frag.appendChild(ah);
    }
    const el = document.createElement('div');
    el.className = 'mk ' + (m.kind === 'point' ? 'pt' : 'an') + (S.cur?.id === m.id ? ' sel' : '');
    el.dataset.id = m.id;
    el.style.left = g.anchor[0] + 'px'; el.style.top = g.anchor[1] + 'px';
    const lbl = String(m.n);
    el.innerHTML = m.kind === 'point'
      ? `<svg class="sym" viewBox="0 0 36 54"><line x1="18" y1="30" x2="18" y2="47" stroke="#fff" stroke-width="5" stroke-linecap="round"/><line x1="18" y1="30" x2="18" y2="47" stroke="${col}" stroke-width="2.6" stroke-linecap="round"/><circle cx="18" cy="50" r="3.6" fill="${col}" stroke="#fff" stroke-width="1.6"/>${symbolInner(m.cat, col, lbl, 13, 18, 17)}</svg>`
      : `<svg class="sym" viewBox="0 0 36 36">${symbolInner(m.cat, col, lbl, 13, 18, 18)}</svg>`;
    if (S.cur?.id === m.id) el.insertAdjacentHTML('beforeend', `<span class="tag">${esc(markCode(m))}</span>`);
    if (S.showThumbs && m.photoIds.length) {
      const ph = S.photos.get(m.photoIds[0]);
      if (ph) el.insertAdjacentHTML('beforeend', `<img class="th" src="${blobURL('t' + ph.id, ph.thumb)}" alt="">`);
    }
    frag.appendChild(el);
  }
  mkLayer.appendChild(frag);
}
let draftEls = null;
function drawDraft(kind, a, b) {
  clearDraft();
  const col = '#2563eb';
  let d;
  if (kind === 'arrow') d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  else { const poly = rectPoly([a.x, a.y], [b.x, b.y]); d = kind === 'cloud' && Math.abs(b.x - a.x) > 4 && Math.abs(b.y - a.y) > 4
    ? segsToD(cloudSegs(poly, clamp(Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / 3.5, 3, 22))) : `M ${poly.map(p => p.join(' ')).join(' L ')} Z`; }
  draftEls = [svgEl('path', { d, class: 'halo' }), svgEl('path', { d, class: 'g draft', stroke: col })];
  draftEls.forEach(x => geo.appendChild(x));
}
function clearDraft() { draftEls?.forEach(x => x.remove()); draftEls = null; }

function nextNumber(cat) { return S.markers.filter(m => m.cat === cat).reduce((a, m) => Math.max(a, m.n), 0) + 1; }
async function createMark(geom) {
  const cat = S.tool.cat, now = Date.now();
  const m = { id: uid(), projectId: S.project.id, drawingId: S.drawing.id, cat, n: nextNumber(cat), kind: geom.kind, page: S.pageNum,
    x: geom.x, y: geom.y, x2: geom.x2 ?? null, y2: geom.y2 ?? null, title: '', note: '', extra: {}, owner: '', due: '',
    status: flowOf(cat)[0], photoIds: [], created: now, updated: now };
  S.markers.push(m);
  setAddMode(false);
  if (filterActive() && !passFilter(m)) { S.filter = { cats: [], st: 'all', owner: '', over: false }; updateFilterUI(); toast('Đã bỏ bộ lọc để hiện điểm mới'); }
  await saveMarker(m);
  renderMarks(); updateCounts(); openSheet(m);
}
async function saveMarker(m) { m.updated = Date.now(); await DB.put('markers', m); touchProject(); }
function updateCounts() {
  const ms = dwgMarkers(), open = ms.filter(m => !isClosed(m)).length;
  const lc = $('#listCount'); lc.textContent = ms.length; lc.hidden = !ms.length;
  lc.style.background = open ? 'var(--st-todo)' : 'var(--st-done)';
}
function updatePager() {
  const n = S.doc.numPages;
  $('#pgLabel').textContent = `${S.pageNum}/${n}`;
  $('#pgPrev').disabled = S.pageNum <= 1; $('#pgNext').disabled = S.pageNum >= n;
  $('#pager').style.opacity = n > 1 ? 1 : .55;
}

/* ---------- add mode toolbar ---------- */
function setHint(html, actions = []) {
  const h = $('#hint');
  if (!html) { h.hidden = true; return; }
  h.innerHTML = `<span>${html}</span>`;
  actions.forEach(a => { const b = document.createElement('button'); b.textContent = a.label; b.onclick = a.action; h.appendChild(b); });
  h.hidden = false;
}
const KIND_HINT = { point: 'Chạm vào vị trí cần ghi nhận', rect: 'Kéo 1 ngón để khoanh vùng (2 ngón để zoom)', cloud: 'Kéo 1 ngón để khoanh vùng mây (2 ngón để zoom)', arrow: 'Kéo từ chỗ đặt ký hiệu đến vị trí cần chỉ' };
function buildToolbar() {
  $('#tbCats').innerHTML = CAT_KEYS.map(c => `<button class="tb-chip ${S.tool.cat === c ? 'on' : ''}" data-c="${c}">${catIcon(c, S.tool.cat === c ? '#0f172a' : '#64748b', '')}${esc(CATS[c].name)}</button>`).join('');
  $('#tbKinds').innerHTML = Object.entries(KINDS).map(([k, l]) => `<button class="tb-chip ${S.tool.kind === k ? 'on' : ''}" data-k="${k}"><svg><use href="#k-${k}"/></svg>${l}</button>`).join('');
  $('#tbCats').querySelectorAll('button').forEach(b => b.onclick = () => { S.tool.cat = b.dataset.c; saveTool(); buildToolbar(); });
  $('#tbKinds').querySelectorAll('button').forEach(b => b.onclick = () => { S.tool.kind = b.dataset.k; saveTool(); buildToolbar(); });
  if (S.addMode) setHint(`<b>${esc(CATS[S.tool.cat].name)}</b> · ${KIND_HINT[S.tool.kind]}`, [{ label: 'Hủy', action: () => setAddMode(false) }]);
}
function saveTool() { try { localStorage.setItem('pm.tool', JSON.stringify(S.tool)); } catch {} }
function setAddMode(on) {
  S.addMode = on;
  $('#btnAdd').classList.toggle('on', on);
  $('#btnAdd span').textContent = on ? 'Hủy' : 'Đánh dấu';
  stage.classList.toggle('adding', on);
  $('#toolbar').hidden = !on;
  if (on) { setMoveMode(null); buildToolbar(); requestAnimationFrame(() => { if (S.page) { layoutKeepView(); } }); }
  else { if (!S.moveId) setHint(null); if (S.page) requestAnimationFrame(layoutKeepView); }
}
function layoutKeepView() { /* stage height changes when the toolbar shows/hides: keep zoom, just re-clamp */ if (!S.base) return; clampView(); applyView(); scheduleDetail(); }
function setMoveMode(id) {
  S.moveId = id;
  stage.classList.toggle('adding', !!id || S.addMode);
  if (id) {
    const m = S.markers.find(x => x.id === id);
    const txt = m.kind === 'point' ? `Chạm vị trí mới cho <b>${esc(markCode(m))}</b>` : `${m.kind === 'arrow' ? 'Kéo lại mũi tên' : 'Kéo lại vùng'} cho <b>${esc(markCode(m))}</b>`;
    setHint(txt + ' (có thể đổi trang)', [{ label: 'Hủy', action: () => { setMoveMode(null); openSheet(m); } }]);
  } else if (!S.addMode) setHint(null);
}

/* ======================= MARKER SHEET ======================= */
const sheet = $('#sheet');
function paintSheet() {
  const m = S.cur; if (!m) return;
  const col = stOf(m).color;
  $('#shCode').textContent = markCode(m); $('#shCode').style.background = col;
  $('#shCats').innerHTML = CAT_KEYS.map(c => `<button class="cat-chip ${m.cat === c ? 'on' : ''}" data-c="${c}">${catIcon(c, m.cat === c ? col : '#94a3b8', '')}${esc(CATS[c].name)}</button>`).join('');
  $('#shCats').querySelectorAll('button').forEach(b => b.onclick = () => changeCat(b.dataset.c));
  const row = $('#shStatus'); row.innerHTML = '';
  flowOf(m.cat).forEach(k => {
    const s = ST[k], on = m.status === k, b = document.createElement('button');
    b.className = 'st-chip' + (on ? ' on' : ''); b.style.background = on ? s.color : '';
    b.innerHTML = `<i style="background:${s.color}"></i>${s.label}`;
    b.onclick = () => { m.status = k; paintSheet(); saveMarker(m); renderMarks(); };
    row.appendChild(b);
  });
  $('#shMove span').textContent = m.kind === 'point' ? 'Di chuyển' : 'Vẽ lại';
  updateNav();
  $('#shMeta').textContent = `${CATS[m.cat].name} · ${KINDS[m.kind]} · Trang ${m.page} · Tạo ${fmtDate(m.created)} · Sửa ${fmtDate(m.updated)}`;
}
function renderExtra() {
  const m = S.cur, box = $('#shExtra');
  box.innerHTML = CATS[m.cat].fields.map(([k, l]) => `<label class="fld extra-fld"><span>${esc(l)}</span><textarea data-k="${k}" rows="2">${esc(m.extra?.[k] || '')}</textarea></label>`).join('');
  box.querySelectorAll('textarea').forEach(t => t.addEventListener('input', () => { clearTimeout(sheetTimer); sheetTimer = setTimeout(flushSheet, 500); }));
}
async function changeCat(c) {
  const m = S.cur; if (!m || m.cat === c) return;
  flushSheet();
  m.status = mapStatus(m.status, c); m.cat = c; m.n = nextNumber(c);
  S.tool.cat = c; saveTool();
  paintSheet(); renderExtra(); await saveMarker(m); renderMarks();
  toast(`Đổi thành ${CATS[c].name} – mã mới ${markCode(m)}`);
}
function renderSheetPhotos() {
  const m = S.cur, g = $('#shPhotos'); g.innerHTML = '';
  $('#shPhotoCount').textContent = m.photoIds.length ? `${m.photoIds.length} ảnh` : '';
  if (!m.photoIds.length) { g.innerHTML = '<div class="none">Chưa có ảnh. Chụp hoặc chọn ảnh hiện trường tại vị trí này.</div>'; return; }
  m.photoIds.forEach((pid, i) => {
    const ph = S.photos.get(pid); if (!ph) return;
    const b = document.createElement('button');
    b.style.backgroundImage = `url('${blobURL('t' + pid, ph.thumb)}')`;
    b.onclick = () => openPhotoViewer(m, i);
    g.appendChild(b);
  });
}
function fillOwnerList() {
  const names = new Set(S.markers.map(m => (m.owner || '').trim()).filter(Boolean));
  ['Nhà thầu', 'Tư vấn giám sát', 'Tư vấn thiết kế', 'Chủ đầu tư'].forEach(n => names.add(n));
  $('#ownerList').innerHTML = [...names].map(n => `<option value="${esc(n)}">`).join('');
}
function openSheet(m, opts = {}) {
  const already = S.cur && !sheet.hidden;
  if (already && S.cur.id !== m.id) flushSheet();
  S.cur = m;
  $('#shTitle').value = m.title || ''; $('#shNote').value = m.note || '';
  $('#shOwner').value = m.owner || ''; $('#shDue').value = m.due || '';
  fillOwnerList(); paintSheet(); renderExtra(); renderSheetPhotos();
  const show = opts.center ? centerMarker : revealMarker;
  if (m.page !== S.pageNum) gotoPage(m.page).then(() => { renderMarks(); show(m); }); else renderMarks();
  if (!already) {
    sheet.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { sheet.classList.add('open'); if (m.page === S.pageNum) show(m); }));
    pushLayer('sheet', hideSheet);
  } else if (m.page === S.pageNum) show(m);
}
/* ---------- step through marks (‹ Trước / Sau ›) ---------- */
/** Same order as the list: by category, then number; respects the active filter (the open mark always stays in). */
function navList() { return sortMarks(dwgMarkers().filter(m => passFilter(m) || m.id === S.cur?.id)); }
function updateNav() {
  const l = navList(), i = l.findIndex(m => m.id === S.cur?.id);
  $('#shPos').textContent = `${i + 1} / ${l.length}${filterActive() ? ' · đang lọc' : ''}`;
  $('#shPrev').disabled = i <= 0; $('#shNext').disabled = i < 0 || i >= l.length - 1;
}
function stepMark(d) {
  const l = navList(), i = l.findIndex(m => m.id === S.cur?.id), n = l[i + d];
  if (!n) { toast(d > 0 ? 'Đã tới điểm cuối' : 'Đã tới điểm đầu'); return; }
  flushSheet(); document.activeElement?.blur?.();
  openSheet(n, { center: true });
  setTimeout(() => mkLayer.querySelector(`[data-id="${n.id}"]`)?.classList.add('flash'), 320);
}
/** Bring a mark to the middle of the area above the sheet, zoomed in enough to check it. */
function centerMarker(m) {
  if (!S.base) return;
  const [x, y] = markGeom(m, vpt).anchor, H = stage.clientHeight;
  const sheetH = window.innerWidth >= 760 ? 0 : Math.max(0, (sheet.getBoundingClientRect().height || H * 0.6) - $('.bottombar').offsetHeight);
  const visH = Math.max(120, H - sheetH);
  focusBase(x, y, Math.max(S.view.s, 2.5), 0.5, clamp((visH * 0.5) / H, 0.18, 0.5));
}
$('#shPrev').onclick = () => stepMark(-1);
$('#shNext').onclick = () => stepMark(1);
document.addEventListener('keydown', e => {
  if (!S.cur || sheet.hidden || e.target.closest('input,textarea,select')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); stepMark(1); }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); stepMark(-1); }
});
/* Compact sheet: only nav + title + status, so more of the drawing stays visible while reviewing. */
function setCompact(on, silent) {
  sheet.classList.toggle('compact', on);
  try { localStorage.setItem('pm.compact', on ? '1' : '0'); } catch {}
  if (!silent) toast(on ? 'Đã thu gọn thẻ – chạm thanh ngang để mở rộng' : 'Đã mở rộng thẻ');
  if (S.cur) setTimeout(() => centerMarker(S.cur), 240);
}
try { if (localStorage.getItem('pm.compact') === '1') sheet.classList.add('compact'); } catch {}
$('.sheet-grip').addEventListener('click', () => setCompact(!sheet.classList.contains('compact')));
(() => { // swipe left/right = previous/next mark; swipe down/up on the grip = compact/expand
  let sx = null, sy = 0;
  ['.sheet-nav', '.sheet-grip', '.sheet-head'].forEach(sel => {
    const el = $(sel);
    el.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', e => {
      if (sx === null) return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepMark(dx < 0 ? 1 : -1);
      else if (sel !== '.sheet-head' && Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx) * 1.5) setCompact(dy > 0);
    });
  });
})();
function revealMarker(m) {
  if (!S.base) return;
  const [x, y] = markGeom(m, vpt).anchor, v = S.view;
  const sx = x * v.s + v.tx, sy = y * v.s + v.ty, W = stage.clientWidth, H = stage.clientHeight;
  const sheetH = window.innerWidth >= 760 ? 0 : sheet.getBoundingClientRect().height - $('.bottombar').offsetHeight;
  const visH = H - Math.max(0, sheetH);
  if (sx < 30 || sx > W - 30 || sy < 60 || sy > visH - 10) focusBase(x, y, Math.max(v.s, 1), 0.5, clamp((visH * 0.55) / H, 0.2, 0.6));
}
function hideSheet() {
  flushSheet();
  sheet.classList.remove('open');
  setTimeout(() => { if (!sheet.classList.contains('open')) sheet.hidden = true; }, 230);
  S.cur = null; renderMarks(); document.activeElement?.blur?.();
}
let sheetTimer;
function flushSheet() {
  clearTimeout(sheetTimer);
  const m = S.cur; if (!m) return;
  const t = $('#shTitle').value, n = $('#shNote').value, o = $('#shOwner').value.trim(), d = $('#shDue').value;
  const ex = { ...(m.extra || {}) }; let exCh = false;
  $('#shExtra').querySelectorAll('textarea').forEach(ta => { if ((ex[ta.dataset.k] || '') !== ta.value) { ex[ta.dataset.k] = ta.value; exCh = true; } });
  if (exCh || t !== m.title || n !== m.note || o !== (m.owner || '') || d !== (m.due || '')) {
    Object.assign(m, { title: t, note: n, owner: o, due: d, extra: ex }); saveMarker(m);
  }
}
$('#shDue').addEventListener('change', () => flushSheet());
['#shTitle', '#shNote', '#shOwner'].forEach(sel => $(sel).addEventListener('input', () => { clearTimeout(sheetTimer); sheetTimer = setTimeout(flushSheet, 500); }));
$('#shTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#shTitle').blur(); } });
$('#shClose').onclick = () => closeLayer('sheet');
$('#shDone').onclick = () => closeLayer('sheet');
$('#shMove').onclick = () => { const m = S.cur; closeLayer('sheet'); setTimeout(() => setMoveMode(m.id), 50); };
$('#shDelete').onclick = async () => {
  const m = S.cur; if (!m) return;
  if (!await confirmBox(`Xóa ${markCode(m)}?`, `Điểm ghi nhận và <b>${m.photoIds.length}</b> ảnh kèm theo sẽ bị xóa.`, 'Xóa', true)) return;
  S.markers = S.markers.filter(x => x.id !== m.id);
  for (const pid of m.photoIds) { await DB.del('photos', pid); S.photos.delete(pid); }
  await DB.del('markers', m.id);
  touchProject(); updateCounts(); S.cur = null; closeLayer('sheet'); renderMarks(); toast(`Đã xóa ${markCode(m)}`);
};
$('#btnCamera').onclick = () => $('#inCamera').click();
$('#btnGallery').onclick = () => $('#inGallery').click();
async function addPhotos(files) {
  const m = S.cur; if (!m || !files.length) return;
  busy(`Đang lưu ${files.length} ảnh…`);
  try {
    let i = 0;
    for (const f of files) {
      i++; $('#busyText').textContent = `Đang lưu ảnh ${i}/${files.length}…`;
      const big = await compressImage(f, 1920, 0.82), th = await compressImage(big.blob, 360, 0.72);
      const ph = { id: uid(), projectId: S.project.id, markerId: m.id, blob: big.blob, thumb: th.blob, w: big.w, h: big.h, name: f.name || '', created: f.lastModified || Date.now() };
      await DB.put('photos', ph); S.photos.set(ph.id, ph); m.photoIds.push(ph.id);
    }
    await saveMarker(m); renderSheetPhotos(); renderMarks();
    toast(`Đã thêm ${files.length} ảnh vào ${markCode(m)}`);
  } catch (e) { console.error(e); modal({ title: 'Không lưu được ảnh', html: esc(e.message || e) }); }
  finally { unbusy(); }
}
['#inCamera', '#inGallery'].forEach(sel => $(sel).addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; addPhotos(fs); }));

/* ======================= PHOTO VIEWER ======================= */
const PV = { m: null, i: 0, z: 1, px: 0, py: 0 };
function openPhotoViewer(m, i) {
  PV.m = m; PV.i = i; $('#photoViewer').hidden = false;
  pushLayer('photo', () => { $('#photoViewer').hidden = true; $('#pvImg').src = ''; });
  showPV();
}
function showPV() {
  const ids = PV.m.photoIds;
  if (!ids.length) { closeLayer('photo'); return; }
  PV.i = clamp(PV.i, 0, ids.length - 1);
  const ph = S.photos.get(ids[PV.i]);
  PV.z = 1; PV.px = PV.py = 0; pvApply();
  $('#pvImg').src = blobURL('f' + ph.id, ph.blob);
  $('#pvCounter').textContent = `${markCode(PV.m)} · ${PV.i + 1}/${ids.length}`;
  $('#pvCaption').textContent = `${PV.m.title || markCode(PV.m)} · ${fmtDate(ph.created)}`;
  $('#pvPrev').hidden = PV.i === 0; $('#pvNext').hidden = PV.i === ids.length - 1;
}
function pvApply() { $('#pvImg').style.transform = `translate(${PV.px}px,${PV.py}px) scale(${PV.z})`; }
$('#pvClose').onclick = () => closeLayer('photo');
$('#pvPrev').onclick = () => { PV.i--; showPV(); };
$('#pvNext').onclick = () => { PV.i++; showPV(); };
$('#pvDelete').onclick = async () => {
  if (!await confirmBox('Xóa ảnh này?', 'Ảnh sẽ bị xóa khỏi điểm ghi nhận.', 'Xóa', true)) return;
  const pid = PV.m.photoIds[PV.i];
  PV.m.photoIds.splice(PV.i, 1); await DB.del('photos', pid); S.photos.delete(pid);
  await saveMarker(PV.m); renderSheetPhotos(); renderMarks(); showPV();
};
(() => {
  const st = $('#pvStage'), img = $('#pvImg'), pts = new Map(); let g = null, lastT = 0;
  st.addEventListener('pointerdown', e => {
    st.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); img.classList.add('drag');
    if (pts.size === 1) g = { t: 'pan', x: e.clientX, y: e.clientY, px: PV.px, py: PV.py };
    else if (pts.size === 2) { const [a, b] = [...pts.values()]; g = { t: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: PV.z }; }
  });
  st.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !g) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.t === 'pan' && pts.size === 1) { PV.px = g.px + (e.clientX - g.x); PV.py = PV.z > 1 ? g.py + (e.clientY - g.y) : 0; pvApply(); }
    else if (g.t === 'pinch' && pts.size === 2) { const [a, b] = [...pts.values()]; PV.z = clamp(g.z * Math.hypot(a.x - b.x, a.y - b.y) / g.d, 1, 6); pvApply(); }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); img.classList.remove('drag');
    if (g?.t === 'pan' && pts.size === 0) {
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (PV.z === 1) {
        if (dx < -60 && PV.i < PV.m.photoIds.length - 1) { PV.i++; showPV(); }
        else if (dx > 60 && PV.i > 0) { PV.i--; showPV(); }
        else { PV.px = 0; pvApply(); }
      }
      if (Math.hypot(dx, dy) < 10) { const now = Date.now(); if (now - lastT < 320) { PV.z = PV.z > 1 ? 1 : 2.5; PV.px = PV.py = 0; pvApply(); lastT = 0; } else lastT = now; }
      g = null;
    } else if (pts.size === 0) { g = null; if (PV.z <= 1) { PV.z = 1; PV.px = PV.py = 0; pvApply(); } }
    else if (pts.size === 1) { const p = [...pts.values()][0]; g = { t: 'pan', x: p.x, y: p.y, px: PV.px, py: PV.py }; }
  };
  st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
})();

/* ======================= FILTER ======================= */
function filterSummary() {
  const f = S.filter, parts = [];
  if (f.cats.length) parts.push(f.cats.map(c => CATS[c].name).join(', '));
  if (f.st === 'open') parts.push('chưa xong'); if (f.st === 'closed') parts.push('đã xong');
  if (f.owner) parts.push(f.owner); if (f.over) parts.push('quá hạn');
  return parts.join(' · ');
}
function updateFilterUI() {
  const on = filterActive();
  $('#filterDot').hidden = !on; $('#lpFilterDot').hidden = !on;
  const bar = $('#filterBar');
  if (on && S.drawing) {
    const all = dwgMarkers(), n = all.filter(passFilter).length;
    bar.innerHTML = `<svg style="width:18px;height:18px"><use href="#i-filter"/></svg><span>Lọc: ${esc(filterSummary())} — ${n}/${all.length} điểm</span><button id="fbEdit">Sửa</button><button id="fbClear">Bỏ lọc</button>`;
    $('#fbEdit').onclick = openFilter; $('#fbClear').onclick = () => { S.filter = { cats: [], st: 'all', owner: '', over: false }; afterFilter(); };
    bar.hidden = false;
  } else bar.hidden = true;
}
function afterFilter() { updateFilterUI(); renderMarks(); if (!$('#listPanel').hidden) renderList(); if (S.cur && !sheet.hidden) updateNav(); }
async function openFilter() {
  const f = { ...S.filter, cats: [...S.filter.cats] };
  const owners = [...new Set(S.markers.map(m => (m.owner || '').trim()).filter(Boolean))].sort();
  const res = await modal({
    title: 'Bộ lọc', cls: 'fmodal',
    html: `<div class="grp"><span>Loại ghi nhận</span><div class="chips" id="fCats">${CAT_KEYS.map(c => `<button class="chip lt ${f.cats.includes(c) ? 'on' : ''}" data-c="${c}">${catIcon(c, '#64748b', '')}${esc(CATS[c].name)}</button>`).join('')}</div></div>
      <div class="grp"><span>Trạng thái</span><div class="chips" id="fSt">${[['all', 'Tất cả'], ['open', 'Chưa xong'], ['closed', 'Đã xong / đóng']].map(([k, l]) => `<button class="chip lt ${f.st === k ? 'on' : ''}" data-s="${k}">${l}</button>`).join('')}</div></div>
      <div class="grp"><span>Phụ trách</span><select id="fOwner"><option value="">Tất cả</option>${owners.map(o => `<option ${f.owner === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>
      <label class="ck"><input type="checkbox" id="fOver" ${f.over ? 'checked' : ''}><span>Chỉ điểm <b>quá hạn</b> xử lý</span></label>`,
    buttons: [{ label: 'Bỏ lọc', value: 'clear' }, { label: 'Áp dụng', cls: 'primary', value: () => ({ ...f, owner: $('#fOwner').value, over: $('#fOver').checked }) }],
    onOpen: b => {
      b.querySelectorAll('#fCats button').forEach(x => x.onclick = () => { const c = x.dataset.c; f.cats = f.cats.includes(c) ? f.cats.filter(y => y !== c) : [...f.cats, c]; x.classList.toggle('on'); });
      b.querySelectorAll('#fSt button').forEach(x => x.onclick = () => { f.st = x.dataset.s; b.querySelectorAll('#fSt button').forEach(y => y.classList.toggle('on', y === x)); });
    },
  });
  if (res === 'clear') S.filter = { cats: [], st: 'all', owner: '', over: false };
  else if (res) S.filter = res;
  else return;
  afterFilter();
}
$('#btnFilter').onclick = openFilter;
$('#lpFilter').onclick = openFilter;

/* ======================= LIST ======================= */
const catOrder = c => CAT_KEYS.indexOf(c);
const sortMarks = ms => [...ms].sort((a, b) => catOrder(a.cat) - catOrder(b.cat) || a.n - b.n);
function openList() { $('#listPanel').hidden = false; pushLayer('list', () => { $('#listPanel').hidden = true; }); renderList(); }
function renderList() {
  const q = $('#lpSearch').value.trim().toLowerCase();
  const all = dwgMarkers();
  const ms = sortMarks(all.filter(passFilter).filter(m => !q || (markCode(m) + ' ' + m.title + ' ' + m.note + ' ' + (m.owner || '') + ' ' + Object.values(m.extra || {}).join(' ')).toLowerCase().includes(q)));
  const open = ms.filter(m => !isClosed(m)).length, over = ms.filter(isOverdue).length;
  $('#lpSum').innerHTML = `<b>${ms.length}</b>${ms.length !== all.length ? '/' + all.length : ''} điểm · ${open} chưa xong${over ? ` · <span style="color:#dc2626">${over} quá hạn</span>` : ''}${filterActive() ? ` · lọc: ${esc(filterSummary())}` : ''}`;
  const box = $('#lpList'); box.innerHTML = '';
  if (!ms.length) { box.innerHTML = `<div class="empty"><p>${all.length ? 'Không có điểm phù hợp.' : 'Chưa có điểm ghi nhận nào.<br>Bấm “Đánh dấu”, chọn loại rồi chạm/kéo trên bản vẽ.'}</p></div>`; return; }
  let lastCat = null;
  ms.forEach(m => {
    if (m.cat !== lastCat) { lastCat = m.cat; const n = ms.filter(x => x.cat === m.cat).length; box.insertAdjacentHTML('beforeend', `<div class="lp-page">${esc(CATS[m.cat].name)} (${n})</div>`); }
    const st = stOf(m), ph = m.photoIds.length ? S.photos.get(m.photoIds[0]) : null;
    const b = document.createElement('button'); b.className = 'lp-item';
    b.innerHTML = `<svg class="ic" viewBox="-18 -18 36 36">${symbolInner(m.cat, st.color, String(m.n), 13)}</svg>
      <div class="body"><div class="t ${m.title ? '' : 'empty-t'}"><span class="code" style="background:${st.color}">${esc(markCode(m))}</span>${esc(m.title || '(chưa có tiêu đề)')}</div>
      ${m.note ? `<div class="d">${esc(m.note)}</div>` : ''}
      <div class="m">${st.label} · ${KINDS[m.kind]} · tr.${m.page} · ${m.photoIds.length} ảnh${m.owner ? ' · ' + esc(m.owner) : ''}${m.due ? ` · <span class="due-txt ${isOverdue(m) ? 'over' : ''}">Hạn ${fmtISO(m.due)}${isOverdue(m) ? ' (quá hạn)' : ''}</span>` : ''}</div></div>
      ${ph ? `<div class="ph" style="background-image:url('${blobURL('t' + ph.id, ph.thumb)}')"></div>` : ''}`;
    b.onclick = () => jumpToMarker(m);
    box.appendChild(b);
  });
}
$('#lpSearch').addEventListener('input', () => renderList());
$('#lpClose').onclick = () => closeLayer('list');
$('#lpReport').onclick = () => openReport([S.drawing.id]);
async function jumpToMarker(m) {
  closeLayer('list'); await sleep(60);
  if (m.page !== S.pageNum) await gotoPage(m.page);
  const [x, y] = markGeom(m, vpt).anchor;
  S.cur = m; renderMarks();
  await focusBase(x, y, Math.max(3, S.view.s), 0.5, 0.33);
  mkLayer.querySelector(`[data-id="${m.id}"]`)?.classList.add('flash');
  openSheet(m);
}

/* ======================= PDF: fonts, vector marks ======================= */
const hex2rgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
const pdfColor = hex => { const [r, g, b] = hex2rgb(hex); return window.PDFLib.rgb(r, g, b); };
async function fetchBytes(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('Không tải được ' + url + ' – mở app khi có mạng một lần để tải đủ dữ liệu.');
  return new Uint8Array(await r.arrayBuffer());
}
let fontCache = null;
async function embedFonts(doc) {
  doc.registerFontkit(window.fontkit);
  if (!fontCache) fontCache = { r: await fetchBytes('BeVietnamPro-Regular.ttf'), b: await fetchBytes('BeVietnamPro-Bold.ttf') };
  return { R: await doc.embedFont(fontCache.r, { subset: true }), B: await doc.embedFont(fontCache.b, { subset: true }) };
}
/** Draw a category symbol (vector) centred at user point (cx,cy). */
function pdfSymbol(pg, cx, cy, r, cat, colHex, label, font, rot) {
  const { degrees, rgb } = window.PDFLib, shp = CATS[cat].shape, white = rgb(1, 1, 1);
  pg.drawSvgPath(shapeD(shp, r), { x: cx, y: cy, color: pdfColor(colHex), borderColor: white, borderWidth: r * 0.17, rotate: degrees(rot) });
  if (shp === 'dcircle') pg.drawCircle({ x: cx, y: cy, size: r * 0.7, borderColor: white, borderWidth: r * 0.11 });
  if (!label) return;
  const fs = r * (label.length > 2 ? 0.78 : label.length > 1 ? 0.95 : 1.05), tw = font.widthOfTextAtSize(label, fs);
  const [ox, oy] = dispToU(rot)(-tw / 2, fs * 0.34 + r * glyphDy(shp));
  pg.drawText(label, { x: cx + ox, y: cy + oy, size: fs, font, color: white, rotate: degrees(rot) });
}
const dispToU = rot => (dx, dy) => rot === 90 ? [dy, dx] : rot === 180 ? [-dx, dy] : rot === 270 ? [-dy, -dx] : [dx, -dy];
const pdfPathD = pts => 'M ' + pts.map(p => `${p[0].toFixed(2)} ${(-p[1]).toFixed(2)}`).join(' L ') + ' Z';

/** Draws all marks (vector) onto the pages of a pdf-lib document. */
function annotateDoc(doc, ms, font) {
  const { rgb, degrees } = window.PDFLib, white = rgb(1, 1, 1);
  const pages = doc.getPages();
  for (const m of ms) {
    const pg = pages[m.page - 1]; if (!pg) continue;
    const rot = ((pg.getRotation().angle % 360) + 360) % 360, toU = dispToU(rot);
    const { width, height } = pg.getSize();
    const R = clamp(Math.max(width, height) * 0.0095, 7, 36), colHex = stOf(m).color, col = pdfColor(colHex), bw = Math.max(1, R * 0.16);
    let ax, ay; // symbol anchor (user space)
    if (m.kind === 'rect' || m.kind === 'cloud') {
      const poly = rectPoly([m.x, m.y], [m.x2, m.y2]);
      if (m.kind === 'rect') {
        pg.drawRectangle({ x: poly[0][0], y: poly[0][1], width: poly[1][0] - poly[0][0], height: poly[2][1] - poly[0][1], color: col, opacity: 0.07, borderColor: col, borderWidth: bw, borderOpacity: 1 });
      } else {
        const w = poly[1][0] - poly[0][0], h = poly[2][1] - poly[0][1];
        pg.drawSvgPath(segsToD(cloudSegs(poly, clamp(Math.min(w, h) / 3.5, R * 0.6, R * 2.5)), -1), { x: 0, y: 0, borderColor: col, borderWidth: bw });
      }
      const [rx, ry] = toU(1, 0), [ux, uy] = toU(0, -1);
      let best = -Infinity; for (const c of poly) { const sc = c[0] * (rx + ux) + c[1] * (ry + uy); if (sc > best) { best = sc; ax = c[0]; ay = c[1]; } }
    } else if (m.kind === 'arrow') {
      const tip = [m.x, m.y], tail = [m.x2, m.y2], L = Math.hypot(tip[0] - tail[0], tip[1] - tail[1]) || 1;
      const dx = (tip[0] - tail[0]) / L, dy = (tip[1] - tail[1]) / L, hl = R * 1.5, hw = R * 0.7;
      pg.drawLine({ start: { x: tail[0], y: tail[1] }, end: { x: tip[0] - dx * hl * 0.8, y: tip[1] - dy * hl * 0.8 }, thickness: bw * 1.1, color: col });
      pg.drawSvgPath(pdfPathD([tip, [tip[0] - dx * hl - dy * hw, tip[1] - dy * hl + dx * hw], [tip[0] - dx * hl * 0.75, tip[1] - dy * hl * 0.75], [tip[0] - dx * hl + dy * hw, tip[1] - dy * hl - dx * hw]]), { x: 0, y: 0, color: col, borderColor: white, borderWidth: R * 0.06 });
      ax = tail[0]; ay = tail[1];
    } else {
      if (CATS[m.cat].cloud) {
        const Rc = R * 2.3, n = 14; let d = '';
        for (let i = 0; i <= n; i++) {
          const a = i / n * Math.PI * 2, x = Math.cos(a) * Rc, y = Math.sin(a) * Rc;
          if (i === 0) d += `M ${x} ${y} `; else { const am = (i - 0.5) / n * Math.PI * 2; d += `Q ${Math.cos(am) * Rc * 1.32} ${Math.sin(am) * Rc * 1.32} ${x} ${y} `; }
        }
        pg.drawSvgPath(d, { x: m.x, y: m.y, borderColor: col, borderWidth: bw });
        const [ox, oy] = toU(Rc * 0.7, -Rc * 0.7); ax = m.x + ox; ay = m.y + oy;
      } else {
        const [ox, oy] = toU(R * 1.5, -R * 1.5); ax = m.x + ox; ay = m.y + oy;
        pg.drawLine({ start: { x: m.x, y: m.y }, end: { x: ax, y: ay }, thickness: bw, color: col });
        pg.drawCircle({ x: m.x, y: m.y, size: R * 0.3, color: col, borderColor: white, borderWidth: R * 0.08 });
      }
    }
    pdfSymbol(pg, ax, ay, R, m.cat, colHex, String(m.n), font, rot);
    // code tag beside the symbol
    const code = markCode(m), fs = R * 0.78, tw = font.widthOfTextAtSize(code, fs), pad = fs * 0.3, h = fs + pad * 2;
    const [bx, by] = toU(R * 1.3, h / 2);
    pg.drawRectangle({ x: ax + bx, y: ay + by, width: tw + pad * 2, height: h, color: white, opacity: 0.9, borderColor: col, borderWidth: R * 0.07, rotate: degrees(rot) });
    const [tx, ty] = toU(R * 1.3 + pad, h / 2 - pad - fs * 0.18);
    pg.drawText(code, { x: ax + tx, y: ay + ty, size: fs, font, color: col, rotate: degrees(rot) });
  }
}

/* Quick export: one drawing with marks. */
async function exportDrawingDialog() {
  const ms0 = dwgMarkers();
  if (!ms0.length) { toast('Chưa có điểm ghi nhận nào để xuất'); return; }
  const useFilter = filterActive();
  const ok = await confirmBox('Xuất bản vẽ đã đánh dấu', `Xuất <b>${esc(S.drawing.name)}</b> với ${useFilter ? `<b>${ms0.filter(passFilter).length}</b> điểm theo bộ lọc hiện tại (${esc(filterSummary())})` : `tất cả <b>${ms0.length}</b> điểm`}.<br><br><span style="color:#64748b;font-size:13.5px">Cần báo cáo đầy đủ gửi các bên? Dùng <b>Lập báo cáo PDF</b>.</span>`, 'Xuất');
  if (!ok) return;
  const ms = useFilter ? ms0.filter(passFilter) : ms0;
  busy('Đang tạo PDF…');
  try {
    await loadPdfLib();
    const doc = await window.PDFLib.PDFDocument.load(await S.pdfBlob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
    const { B } = await embedFonts(doc);
    annotateDoc(doc, ms, B);
    const bytes = await doc.save(); unbusy();
    await deliverFile(new Blob([bytes], { type: 'application/pdf' }), `${safeName(S.drawing.name)}_danh-dau.pdf`, 'Đã tạo PDF');
  } catch (e) { unbusy(); console.error(e); modal({ title: 'Xuất PDF lỗi', html: esc(e.message || e) }); }
}

/** Render a whole page once (capped size); snippets are cropped from it – much faster than one render per mark. */
async function renderPageImage(doc, pn) {
  const page = await doc.getPage(pn), vp1 = page.getViewport({ scale: 1 });
  const sc = Math.min(4, 4096 / Math.max(vp1.width, vp1.height), Math.sqrt(11e6 / (vp1.width * vp1.height)));
  const vp = page.getViewport({ scale: sc });
  const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { c, sc, vp1 };
}
/** Snippet (w×h canvas) around a mark cropped from a page image, with the mark drawn on it. */
function snippetFromPage(pi, m, w, h) {
  const { c: src, sc, vp1 } = pi;
  const g1 = markGeom(m, (x, y) => vp1.convertToViewportPoint(x, y));
  const pts = g1.poly || (g1.tip ? [g1.tip, g1.tail] : [g1.point]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
  const span = Math.max(Math.max(vp1.width, vp1.height) * 0.14, (bx1 - bx0) * 1.5, (by1 - by0) * 1.5 * w / h);
  const k = w / span, cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  const sx = (cx - w / 2 / k) * sc, sy = (cy - h / 2 / k) * sc;
  ctx.drawImage(src, sx, sy, (w / k) * sc, (h / k) * sc, 0, 0, w, h);
  const T = p => [(p[0] - cx) * k + w / 2, (p[1] - cy) * k + h / 2];
  const g = { poly: g1.poly?.map(T), tip: g1.tip && T(g1.tip), tail: g1.tail && T(g1.tail), point: g1.point && T(g1.point), anchor: T(g1.anchor) };
  const col = stOf(m).color, r = Math.min(w, h) * 0.05, lw = Math.max(3, w * 0.007);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const stroke = (path, width) => { ctx.strokeStyle = '#fff'; ctx.lineWidth = width + 4; ctx.stroke(path); ctx.strokeStyle = col; ctx.lineWidth = width; ctx.stroke(path); };
  let anchor = g.anchor;
  if (g.poly) {
    const pw = g.poly[1][0] - g.poly[0][0], ph = g.poly[2][1] - g.poly[0][1];
    const p = new Path2D(m.kind === 'cloud' ? segsToD(cloudSegs(g.poly, clamp(Math.min(pw, ph) / 3.5, 6, 40))) : `M ${g.poly.map(q => q.join(' ')).join(' L ')} Z`);
    ctx.fillStyle = col + '14'; ctx.fill(p); stroke(p, lw);
  } else if (g.tip) {
    stroke(new Path2D(`M ${g.tail.join(' ')} L ${g.tip.join(' ')}`), lw);
    const a = Math.atan2(g.tip[1] - g.tail[1], g.tip[0] - g.tail[0]);
    ctx.save(); ctx.translate(g.tip[0], g.tip[1]); ctx.rotate(a); ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-r * 1.6, -r * 0.8); ctx.lineTo(-r * 1.15, 0); ctx.lineTo(-r * 1.6, r * 0.8); ctx.closePath();
    ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
  } else {
    const rr = Math.min(w, h) * 0.13;
    stroke(new Path2D(`M ${g.point[0] + rr} ${g.point[1]} A ${rr} ${rr} 0 1 1 ${g.point[0] - rr} ${g.point[1]} A ${rr} ${rr} 0 1 1 ${g.point[0] + rr} ${g.point[1]}`), lw);
    ctx.beginPath(); ctx.arc(g.point[0], g.point[1], lw * 0.9, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    anchor = [g.point[0] + rr * 0.72, g.point[1] - rr * 0.72];
  }
  ctx.save(); ctx.translate(anchor[0], anchor[1]);
  const sp = new Path2D(shapeD(CATS[m.cat].shape, r));
  ctx.fillStyle = col; ctx.fill(sp); ctx.strokeStyle = '#fff'; ctx.lineWidth = r * 0.18; ctx.stroke(sp);
  ctx.fillStyle = '#fff'; ctx.font = `800 ${Math.round(r * 0.95)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(m.n), 0, r * glyphDy(CATS[m.cat].shape) + 1); ctx.restore();
  return c;
}

/* ======================= REPORT ======================= */
let RP = { cats: [], dwgs: [], titleTouched: false, autoNo: '' };
const rpAutoNo = () => (S.project.prefix || '') + pad2(S.project.seq || 1);
function rpSelected() {
  const st = $('#rpSt').value;
  return sortMarks(S.markers.filter(m => RP.dwgs.includes(m.drawingId) && RP.cats.includes(m.cat) &&
    (st === 'all' || (st === 'open' ? !isClosed(m) : isClosed(m)))));
}
function rpAutoTitle() { return RP.cats.length === 1 ? CATS[RP.cats[0]].title : 'BÁO CÁO GHI NHẬN HIỆN TRƯỜNG'; }
function fillReportProjectHint() {
  const p = S.project;
  $('#rpProjHint').textContent = `(${[p.company || 'chưa có đơn vị lập', p.logo ? 'có logo' : 'chưa có logo'].join(' · ')})`;
}
function openReport(dwgIds) {
  if (!S.markers.length) { toast('Dự án chưa có điểm ghi nhận nào'); return; }
  if (S.cur) flushSheet();
  const p = S.project, rp = p.rp || {};
  const present = CAT_KEYS.filter(c => S.markers.some(m => m.cat === c));
  const dwgWith = S.drawings.filter(d => S.markers.some(m => m.drawingId === d.id)).map(d => d.id);
  RP = { cats: present, dwgs: dwgIds?.length ? dwgIds.filter(id => dwgWith.includes(id)) : dwgWith, titleTouched: false, autoNo: rpAutoNo() };
  if (!RP.dwgs.length) RP.dwgs = dwgWith;
  $('#rpCats').innerHTML = CAT_KEYS.map(c => { const n = S.markers.filter(m => m.cat === c).length;
    return `<button class="chip lt ${RP.cats.includes(c) ? 'on' : ''}" data-c="${c}" ${n ? '' : 'disabled style="opacity:.4"'}>${catIcon(c, '#64748b', '')}${esc(CATS[c].name)} (${n})</button>`; }).join('');
  $('#rpCats').querySelectorAll('button').forEach(b => b.onclick = () => {
    const c = b.dataset.c; RP.cats = RP.cats.includes(c) ? RP.cats.filter(x => x !== c) : [...RP.cats, c];
    b.classList.toggle('on', RP.cats.includes(c)); if (!RP.titleTouched) $('#rpTitle').value = rpAutoTitle(); updateRpCount();
  });
  $('#rpDwgs').innerHTML = S.drawings.map(d => { const n = S.markers.filter(m => m.drawingId === d.id).length;
    return `<label><input type="checkbox" value="${d.id}" ${RP.dwgs.includes(d.id) ? 'checked' : ''} ${n ? '' : 'disabled'}><span>${esc(d.name)}</span><small>${n} điểm</small></label>`; }).join('');
  $('#rpDwgs').querySelectorAll('input').forEach(i => i.onchange = () => { RP.dwgs = [...$('#rpDwgs').querySelectorAll('input:checked')].map(x => x.value); updateRpCount(); });
  $('#rpSt').value = rp.st || 'all';
  $('#rpTitle').value = rpAutoTitle(); $('#rpNo').value = RP.autoNo; $('#rpDate').value = todayISO();
  $('#rpTo').value = p.to || ''; $('#rpSummary').value = rp.summary || '';
  $('#rpPerRow').value = rp.perRow || '2'; $('#rpQuality').value = rp.quality || 'std';
  $('#rpDrawing').checked = rp.drawing !== false; $('#rpDetail').checked = rp.detail !== false; $('#rpSnip').checked = rp.snip !== false;
  fillReportProjectHint(); updateRpCount();
  $('#reportPanel').hidden = false;
  pushLayer('report', () => { saveRpForm(); $('#reportPanel').hidden = true; });
}
function updateRpCount() {
  const ms = rpSelected(), ph = ms.reduce((a, m) => a + m.photoIds.length, 0);
  $('#rpCount').textContent = `Báo cáo gồm ${ms.length} điểm, ${ph} ảnh hiện trường, ${RP.dwgs.length} bản vẽ.`;
}
function saveRpForm() {
  if (!S.project) return;
  S.project.rp = { summary: $('#rpSummary').value, st: $('#rpSt').value, perRow: $('#rpPerRow').value, quality: $('#rpQuality').value,
    drawing: $('#rpDrawing').checked, detail: $('#rpDetail').checked, snip: $('#rpSnip').checked };
  DB.put('projects', S.project);
}
$('#rpTitle').addEventListener('input', () => { RP.titleTouched = true; });
$('#rpSt').onchange = updateRpCount;
$('#rpClose').onclick = () => closeLayer('report');
$('#rpEditProj').onclick = () => openProjPanel(S.project);
$('#rpGo').onclick = async () => {
  saveRpForm();
  const ms = rpSelected();
  if (!ms.length) { toast('Không có điểm nào theo lựa chọn'); return; }
  const p = S.project;
  const cfg = { title: $('#rpTitle').value.trim() || rpAutoTitle(), no: $('#rpNo').value.trim(), date: $('#rpDate').value || todayISO(),
    to: $('#rpTo').value.trim(), summary: $('#rpSummary').value.trim(), perRow: +$('#rpPerRow').value, quality: $('#rpQuality').value,
    drawing: $('#rpDrawing').checked, detail: $('#rpDetail').checked, snip: $('#rpSnip').checked,
    dwgs: S.drawings.filter(d => RP.dwgs.includes(d.id)), marks: ms, project: p };
  const ok = await buildReport(cfg);
  if (ok && cfg.no && cfg.no === RP.autoNo) { p.seq = (p.seq || 1) + 1; await DB.put('projects', p); RP.autoNo = rpAutoNo(); $('#rpNo').value = RP.autoNo; renderProject(); }
};
window.__pm = { S, DB };

async function buildReport(cfg) {
  busy('Đang chuẩn bị báo cáo…');
  try { await loadPdfLib(); } catch (e) { unbusy(); modal({ title: 'Lỗi', html: esc(e.message) }); return false; }
  const PDFLib = window.PDFLib;
  const { PDFDocument, rgb, degrees } = PDFLib;
  const P = cfg.project, ms = cfg.marks;
  const step = t => { $('#busyText').textContent = t; };
  busy('Đang chuẩn bị báo cáo…');
  const docs = new Map();
  const getDoc = async did => {
    if (S.doc && S.drawing?.id === did) return S.doc;
    if (!docs.has(did)) { const rec = await DB.get('pdfs', did); docs.set(did, await pdfjsLib.getDocument({ data: new Uint8Array(await rec.blob.arrayBuffer()) }).promise); }
    return docs.get(did);
  };
  try {
    const out = await PDFDocument.create();
    const { R, B } = await embedFonts(out);
    let logo = null;
    if (P.logo) { try { logo = await out.embedPng(Uint8Array.from(atob(P.logo.split(',')[1]), c => c.charCodeAt(0))); } catch (e) { console.warn(e); } }
    const N = s => String(s ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    const C = pdfColor;
    const W = 595.28, H = 841.89, M = 42, CW = W - 2 * M, TOP = 36, BOT = 52;
    const DARK = '#0f172a', MUTED = '#64748b', LINE = '#cbd5e1', SOFT = '#f1f5f9';
    let pg = null, y = 0;
    const kinds = [];
    const tw = (s, f, z) => f.widthOfTextAtSize(s, z);
    const text = (s, x, base, f = R, z = 10, col = DARK) => pg.drawText(N(s), { x, y: H - base, size: z, font: f, color: C(col) });
    const textC = (s, cx, base, f, z, col) => text(s, cx - tw(N(s), f, z) / 2, base, f, z, col);
    const textR = (s, rx, base, f, z, col) => text(s, rx - tw(N(s), f, z), base, f, z, col);
    const rect = (x, yy, w, h, fill, stroke, bw = 0.6) => pg.drawRectangle({ x, y: H - yy - h, width: w, height: h,
      ...(fill ? { color: C(fill) } : {}), ...(stroke ? { borderColor: C(stroke), borderWidth: bw } : { borderWidth: 0 }) });
    const hline = (x1, x2, yy, col = LINE, t = 0.6) => pg.drawLine({ start: { x: x1, y: H - yy }, end: { x: x2, y: H - yy }, thickness: t, color: C(col) });
    const sym = (cx, cyTop, r, m, label) => pdfSymbol(pg, cx, H - cyTop, r, m.cat ?? m, typeof m === 'string' ? '#64748b' : stOf(m).color, label, B, 0);
    const wrap = (s, f, z, maxW, maxLines = 999) => {
      const outL = [];
      for (const para of N(s).split(/\r?\n/)) {
        let line = '';
        for (const w of para.split(/\s+/).filter(Boolean)) {
          const t = line ? line + ' ' + w : w;
          if (tw(t, f, z) <= maxW) { line = t; continue; }
          if (line) outL.push(line);
          if (tw(w, f, z) > maxW) { let q = ''; for (const ch of w) { if (tw(q + ch, f, z) > maxW) { outL.push(q); q = ch; } else q += ch; } line = q; }
          else line = w;
        }
        outL.push(line);
      }
      if (outL.length > maxLines) { const cut = outL.slice(0, maxLines); cut[maxLines - 1] = cut[maxLines - 1].replace(/\s*\S*$/, '') + ' …'; return cut; }
      return outL;
    };
    const pill = (label, rx, yy, col, z = 8) => { const w = tw(N(label), B, z) + 12; rect(rx - w, yy, w, z + 7, col); text(label, rx - w + 6, yy + z + 2.2, B, z, '#ffffff'); return w; };
    const header = () => {
      let x = M;
      if (logo) { const k = Math.min(70 / logo.width, 22 / logo.height); pg.drawImage(logo, { x, y: H - TOP - 22 + (22 - logo.height * k) / 2, width: logo.width * k, height: logo.height * k }); x += logo.width * k + 8; }
      text(wrap(P.company || P.name, B, 8.5, 260, 1)[0] || '', x, TOP + 14, B, 8.5, DARK);
      textR([cfg.no ? 'Số: ' + cfg.no : '', fmtISO(cfg.date)].filter(Boolean).join('  ·  '), W - M, TOP + 14, R, 8, MUTED);
      hline(M, W - M, TOP + 28, LINE, 0.8); y = TOP + 42;
    };
    const newPage = (withHeader = true) => { pg = out.addPage([W, H]); kinds.push('r'); y = TOP; if (withHeader) header(); };
    const ensure = h => { if (y + h > H - BOT) { newPage(); return true; } return false; };
    const section = t => { ensure(40); text(t, M, y + 11, B, 11.5, DARK); y += 22; };
    const cats = CAT_KEYS.filter(c => ms.some(m => m.cat === c));
    const signers = (P.signers || '').split('\n').map(s => s.trim()).filter(Boolean);

    /* ---- cover ---- */
    step('Đang tạo trang bìa và bảng tổng hợp…');
    newPage(false);
    {
      let x = M; const hh = 44;
      if (logo) { const k = Math.min(120 / logo.width, hh / logo.height); pg.drawImage(logo, { x, y: H - y - hh + (hh - logo.height * k) / 2, width: logo.width * k, height: logo.height * k }); x += logo.width * k + 12; }
      const cl = wrap(P.company || '', B, 11, W - M - x - 150, 2);
      cl.forEach((l, i) => text(l, x, y + 16 + i * 14, B, 11, DARK));
      if (P.author) text('Người lập: ' + P.author, x, y + 18 + cl.length * 14, R, 8.5, MUTED);
      textR(cfg.no ? 'Số: ' + cfg.no : '', W - M, y + 16, B, 9.5, DARK);
      textR('Ngày ' + fmtISO(cfg.date), W - M, y + 31, R, 9, MUTED);
      y += Math.max(hh, 22 + cl.length * 14) + 12;
      hline(M, W - M, y, DARK, 1.2); y += 26;
      wrap(cfg.title.toUpperCase(), B, 16, CW - 20).forEach(l => { textC(l, W / 2, y + 14, B, 16, DARK); y += 21; });
      wrap(P.name + (P.code ? ` (${P.code})` : ''), R, 10.5, CW - 40, 2).forEach(l => { textC(l, W / 2, y + 12, R, 10.5, MUTED); y += 15; });
      y += 14;
    }
    {
      const statLine = cats.map(c => { const a = ms.filter(m => m.cat === c), o = a.filter(m => !isClosed(m)).length; return `${CATS[c].name}: ${a.length}${o ? ` (chưa xong ${o})` : ''}`; }).join(' · ');
      const over = ms.filter(isOverdue).length;
      const rows = [
        ['Dự án / Công trình', P.name + (P.code ? ` — Mã: ${P.code}` : '')], ['Chủ đầu tư', P.owner], ['Địa điểm', P.loc],
        ['Bản vẽ', cfg.dwgs.map(d => d.name).join('; ')], ['Kính gửi', cfg.to], ['Đơn vị lập', P.company], ['Người lập', P.author],
        ['Ngày lập', fmtISO(cfg.date)], ['Số điểm ghi nhận', `${ms.length} điểm — ${statLine}${over ? ` · Quá hạn: ${over}` : ''}`],
      ].filter(r => r[1]);
      const LW = 130;
      for (const [k, v] of rows) {
        const f = k === 'Kính gửi' ? B : R, ls = wrap(v, f, 9.5, CW - LW - 16), h = ls.length * 13 + 10;
        ensure(h);
        rect(M, y, LW, h, SOFT, LINE); rect(M + LW, y, CW - LW, h, null, LINE);
        text(k, M + 8, y + 15, B, 9, '#334155');
        ls.forEach((l, i) => text(l, M + LW + 8, y + 15 + i * 13, f, 9.5, DARK));
        y += h;
      }
      y += 18;
    }
    let sec = 1; const roman = ['I', 'II', 'III', 'IV', 'V'];
    if (cfg.summary) {
      section(`${roman[sec++ - 1]}. NỘI DUNG TÓM TẮT / KIẾN NGHỊ`);
      for (const l of wrap(cfg.summary, R, 10, CW)) { ensure(15); text(l, M, y + 10, R, 10, DARK); y += 14.5; }
      y += 12;
    }
    /* ---- summary table (grouped by category) ---- */
    section(`${roman[sec++ - 1]}. BẢNG TỔNG HỢP CÁC VỊ TRÍ GHI NHẬN`);
    {
      const multiDwg = cfg.dwgs.length > 1;
      const cols = [['Mã', 54], [multiDwg ? 'Bản vẽ / trang' : 'Trang', multiDwg ? 74 : 34], ['Nội dung', 0], ['Phụ trách', 76], ['Hạn xử lý', 54], ['Trạng thái', 62]];
      cols[2][1] = CW - cols.reduce((a, c) => a + c[1], 0);
      const xs = []; let acc = M; cols.forEach(c => { xs.push(acc); acc += c[1]; });
      const head = () => { rect(M, y, CW, 20, '#e2e8f0', LINE); cols.forEach((c, i) => textC(c[0], xs[i] + c[1] / 2, y + 13.5, B, 8, '#1e293b')); y += 20; };
      head();
      for (const c of cats) {
        const group = ms.filter(m => m.cat === c);
        if (ensure(18 + 48)) head();
        rect(M, y, CW, 18, '#f8fafc', LINE);
        sym(M + 10, y + 9, 5.6, c, '');
        text(`${CATS[c].name.toUpperCase()} — ${group.length} điểm`, M + 20, y + 12.5, B, 8.5, DARK);
        y += 18;
        for (const m of group) {
          const st = stOf(m);
          const tl = wrap(m.title || '(Chưa có tiêu đề)', B, 9, cols[2][1] - 10, 3);
          const nl = m.note ? wrap(m.note, R, 8.2, cols[2][1] - 10, 4) : [];
          const ol = wrap(m.owner || '—', R, 8.2, cols[3][1] - 8, 4);
          const dl = multiDwg ? wrap(dwgName(m.drawingId), R, 7.4, cols[1][1] - 8, 2) : [];
          const stl = wrap(st.label, B, 8, cols[5][1] - 6, 2);
          const h = Math.max(tl.length * 12 + nl.length * 10.5, ol.length * 10.5, dl.length * 9.5 + 10, 16) + 12;
          if (ensure(h)) head();
          cols.forEach((cc, i) => rect(xs[i], y, cc[1], h, null, LINE));
          sym(xs[0] + 11, y + 13, 7, m, String(m.n));
          text(markCode(m), xs[0] + 21, y + 16, B, 7.6, st.color);
          if (multiDwg) { dl.forEach((l, i) => text(l, xs[1] + 4, y + 13 + i * 9.5, R, 7.4, DARK)); text('tr. ' + m.page, xs[1] + 4, y + 13 + dl.length * 9.5, R, 7.4, MUTED); }
          else textC(String(m.page), xs[1] + cols[1][1] / 2, y + 15, R, 8.5, DARK);
          let yy = y + 14;
          tl.forEach(l => { text(l, xs[2] + 5, yy, B, 9, DARK); yy += 12; });
          nl.forEach(l => { text(l, xs[2] + 5, yy, R, 8.2, '#475569'); yy += 10.5; });
          ol.forEach((l, i) => text(l, xs[3] + 4, y + 14 + i * 10.5, R, 8.2, DARK));
          if (m.due) {
            textC(fmtISO(m.due), xs[4] + cols[4][1] / 2, y + 14, isOverdue(m) ? B : R, 8.2, isOverdue(m) ? '#dc2626' : DARK);
            if (isOverdue(m)) textC('Quá hạn', xs[4] + cols[4][1] / 2, y + 24.5, R, 7, '#dc2626');
          } else textC('—', xs[4] + cols[4][1] / 2, y + 14, R, 8.2, MUTED);
          stl.forEach((l, i) => textC(l, xs[5] + cols[5][1] / 2, y + 14 + i * 10, B, 8, st.color));
          y += h;
        }
      }
      y += 8;
      const notes = [];
      if (cfg.drawing) notes.push('vị trí xem Phụ lục 1 (bản vẽ đánh dấu)');
      if (cfg.detail) notes.push('chi tiết và hình ảnh hiện trường xem Phụ lục 2');
      if (notes.length) { ensure(14); text('Ghi chú: ' + notes.join('; ') + '.', M, y + 9, R, 8, MUTED); y += 16; }
      y += 10;
    }
    /* ---- signatures ---- */
    if (signers.length) {
      const perRow = Math.min(3, signers.length), gap = 10, bw = (CW - gap * (perRow - 1)) / perRow, bh = 108;
      ensure(22 + bh); section(`${roman[sec++ - 1]}. XÁC NHẬN CỦA CÁC BÊN`);
      const authorIdx = Math.max(0, signers.findIndex(s => /lập/i.test(s)));
      for (let i = 0; i < signers.length; i += perRow) {
        ensure(bh + 8);
        for (let j = 0; j < perRow && i + j < signers.length; j++) {
          const x = M + j * (bw + gap), cx = x + bw / 2;
          rect(x, y, bw, bh, null, LINE);
          wrap(signers[i + j].toUpperCase(), B, 8.8, bw - 12, 2).forEach((l, k) => textC(l, cx, y + 16 + k * 11.5, B, 8.8, DARK));
          textC('(Ký, ghi rõ họ tên)', cx, y + 42, R, 7.5, MUTED);
          if (i + j === authorIdx && P.author) textC(wrap(P.author, B, 9, bw - 12, 1)[0], cx, y + bh - 10, B, 9, DARK);
        }
        y += bh + 8;
      }
    }

    /* ---- Appendix 1: drawings with marks (vector, original quality) ---- */
    if (cfg.drawing) {
      for (const d of cfg.dwgs) {
        const dm = ms.filter(m => m.drawingId === d.id); if (!dm.length) continue;
        step(`Đang đánh dấu bản vẽ ${d.name}…`);
        const rec = await DB.get('pdfs', d.id);
        const src = await PDFDocument.load(await rec.blob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
        const sf = await embedFonts(src);
        annotateDoc(src, dm, sf.B);
        const idx = [...new Set(dm.map(m => m.page - 1))].sort((a, b) => a - b);
        const copied = await out.copyPages(src, idx);
        copied.forEach((p, i) => { out.addPage(p); kinds.push({ d, page: idx[i] + 1, cats: CAT_KEYS.filter(c => dm.some(m => m.cat === c && m.page === idx[i] + 1)) }); });
      }
    }

    /* ---- Appendix 2: details ---- */
    const snips = new Map();
    if (cfg.detail && cfg.snip) {
      const groups = new Map();
      ms.forEach(m => { const k = m.drawingId + '|' + m.page; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
      let gi = 0;
      for (const [k, list] of groups) {
        gi++; step(`Đang trích vị trí trên bản vẽ (${gi}/${groups.size})…`);
        try {
          const pi = await renderPageImage(await getDoc(list[0].drawingId), list[0].page);
          for (const m of list) snips.set(m.id, await canvasToBlob(snippetFromPage(pi, m, 800, 600), 'image/jpeg', 0.85));
          pi.c.width = pi.c.height = 0;
        } catch (e) { console.warn(e); }
      }
    }
    if (cfg.detail) {
      newPage();
      text(cfg.drawing ? 'PHỤ LỤC 2' : 'PHỤ LỤC', M, y + 12, B, 13, DARK);
      text('CHI TIẾT CÁC VỊ TRÍ GHI NHẬN VÀ HÌNH ẢNH HIỆN TRƯỜNG', M, y + 30, B, 11, '#334155');
      y += 46;
      const COLS = cfg.perRow || 2, GAP = 8, CELLW = (CW - GAP * (COLS - 1)) / COLS, CELLH = CELLW * 0.75, CAP = 13;
      let i = 0, lastCat = null;
      for (const m of ms) {
        i++; step(`Đang xử lý ảnh ${markCode(m)} (${i}/${ms.length})…`);
        const st = stOf(m);
        const tl = wrap(m.title || '(Chưa có tiêu đề)', B, 11.5, CW - 34 - 90 - 50, 3);
        const meta = wrap([`${KINDS[m.kind]} · Bản vẽ: ${dwgName(m.drawingId)} (trang ${m.page})`, `Phụ trách: ${m.owner || '—'}`,
          `Hạn xử lý: ${m.due ? fmtISO(m.due) + (isOverdue(m) ? ' (quá hạn)' : '') : '—'}`, `Ghi nhận: ${fmtDate(m.created)}`].join('   ·   '), R, 8.2, CW - 34);
        const nl = m.note ? wrap(m.note, R, 9.5, CW - 34) : [];
        const exs = CATS[m.cat].fields.filter(([k]) => (m.extra?.[k] || '').trim()).map(([k, l]) => ({ l, lines: wrap(m.extra[k], R, 9.2, CW - 34) }));
        const cells = [];
        if (cfg.snip) cells.push({ snip: true, label: `Vị trí trên bản vẽ (trang ${m.page})` });
        m.photoIds.forEach((pid, k) => { const ph = S.photos.get(pid); if (ph) cells.push({ ph, label: `Ảnh ${k + 1} · ${fmtDate(ph.created)}` }); });
        const headH = 8 + tl.length * 15 + meta.length * 11 + 4 + nl.length * 13.5 + exs.reduce((a, e) => a + 13 + e.lines.length * 12.5, 0) + 8;
        const rowH = CELLH + CAP + 8;
        if (m.cat !== lastCat) {
          lastCat = m.cat; ensure(30 + headH + (cells.length ? rowH : 0));
          rect(M, y, CW, 20, '#e2e8f0'); sym(M + 11, y + 10, 6.5, m.cat, '');
          text(`${CATS[m.cat].name.toUpperCase()} (${ms.filter(x => x.cat === m.cat).length})`, M + 24, y + 14, B, 9.5, DARK); y += 30;
        }
        ensure(headH + (cells.length ? rowH : 0));
        const y0 = y, pg0 = pg;
        sym(M + 12, y + 13, 11, m, String(m.n));
        const pw = pill(st.label, W - M, y + 3, st.color, 8.5);
        textR(markCode(m), W - M - pw - 6, y + 13.5, B, 10, st.color);
        tl.forEach((l, k) => text(l, M + 32, y + 17 + k * 15, B, 11.5, DARK));
        y += 8 + tl.length * 15;
        meta.forEach(l => { text(l, M + 32, y + 8, R, 8.2, MUTED); y += 11; });
        y += 4;
        nl.forEach(l => { ensure(14); text(l, M + 32, y + 10, R, 9.5, '#1e293b'); y += 13.5; });
        for (const e of exs) {
          ensure(26); text(e.l + ':', M + 32, y + 10, B, 8.8, '#334155'); y += 13;
          e.lines.forEach(l => { ensure(13); text(l, M + 32, y + 10, R, 9.2, '#1e293b'); y += 12.5; });
        }
        y += 8;
        if (y - y0 > 40 && pg === pg0) pg.drawRectangle({ x: M + 11, y: H - y + 6, width: 2, height: Math.max(0, y - y0 - 34), color: C(st.color) });
        for (let r = 0; r < cells.length; r += COLS) {
          if (ensure(rowH)) { text(`${markCode(m)} ${m.title || ''} (tiếp)`.slice(0, 90), M, y + 9, B, 9, MUTED); y += 18; }
          for (let j = 0; j < COLS && r + j < cells.length; j++) {
            const cell = cells[r + j], x = M + j * (CELLW + GAP);
            rect(x, y, CELLW, CELLH, SOFT);
            try {
              let jpg;
              if (cell.snip) { jpg = snips.get(m.id); if (!jpg) throw new Error('no snippet'); }
              else jpg = (cfg.quality === 'high' || cell.ph.blob.size <= 450e3) ? cell.ph.blob : (await compressImage(cell.ph.blob, 1400, 0.78)).blob;
              const im = await out.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
              const k = Math.min(CELLW / im.width, CELLH / im.height), iw = im.width * k, ih = im.height * k;
              pg.drawImage(im, { x: x + (CELLW - iw) / 2, y: H - y - CELLH + (CELLH - ih) / 2, width: iw, height: ih });
            } catch (e) { console.warn(e); textC('(không đọc được ảnh)', x + CELLW / 2, y + CELLH / 2, R, 8, MUTED); }
            rect(x, y, CELLW, CELLH, null, LINE);
            text(wrap(cell.label, R, 7.5, CELLW, 1)[0], x + 1, y + CELLH + 10, R, 7.5, MUTED);
          }
          y += rowH;
        }
        if (!cells.length) { text('(Không có ảnh)', M + 32, y + 6, R, 8.5, MUTED); y += 14; }
        y += 4; hline(M, W - M, y, LINE, 0.8); y += 16;
      }
    }

    /* ---- page numbers / drawing strips ---- */
    step('Đang đánh số trang…');
    const pages = out.getPages(), total = pages.length;
    const leftLabel = [cfg.no ? 'Số ' + cfg.no : '', P.name].filter(Boolean).join(' · ');
    pages.forEach((p, i) => {
      const kind = kinds[i] || 'r';
      if (kind === 'r') {
        p.drawLine({ start: { x: M, y: 34 }, end: { x: W - M, y: 34 }, thickness: 0.5, color: C(LINE) });
        p.drawText(N(wrap(leftLabel, R, 7.5, CW - 80, 1)[0] || ''), { x: M, y: 22, size: 7.5, font: R, color: C(MUTED) });
        const t = `Trang ${i + 1}/${total}`;
        p.drawText(t, { x: W - M - tw(t, R, 8), y: 22, size: 8, font: R, color: C(MUTED) });
        return;
      }
      const rot = ((p.getRotation().angle % 360) + 360) % 360, b0 = p.getCropBox();
      const dW = rot % 180 ? b0.height : b0.width, dH = rot % 180 ? b0.width : b0.height;
      const z = clamp(Math.max(dW, dH) * 0.011, 8, 22), strip = z * 2.8, box = { ...b0 };
      if (rot === 90) { box.x -= strip; box.width += strip; } else if (rot === 180) { box.y -= strip; box.height += strip; }
      else if (rot === 270) { box.width += strip; } else { box.height += strip; }
      p.setMediaBox(box.x, box.y, box.width, box.height); p.setCropBox(box.x, box.y, box.width, box.height);
      const toUser = (dx, dy) => rot === 90 ? [box.x + dy, box.y + dx] : rot === 180 ? [box.x + box.width - dx, box.y + dy]
        : rot === 270 ? [box.x + box.width - dy, box.y + box.height - dx] : [box.x + dx, box.y + box.height - dy];
      const mg = z * 0.9, base = strip / 2 + z * 0.36;
      const label = N(`PHỤ LỤC 1 – ${kind.d.name} (trang ${kind.page})`);
      const right = [];
      kind.cats.forEach(c => right.push({ cat: c, t: CATS[c].name })); right.push({ t: `Trang ${i + 1}/${total}`, bold: true });
      const rw = right.reduce((a, it) => a + tw(N(it.t), it.bold ? B : R, z * 0.9) + (it.cat ? z * 1.5 : 0) + z * 1.3, 0);
      const lmax = dW - 2 * mg - rw - z;
      let lt = label; while (lt.length > 8 && tw(lt, B, z) > lmax) lt = lt.slice(0, -2);
      if (lt !== label) lt = lt.replace(/\s*\S?$/, '') + '…';
      let [tx, ty] = toUser(mg, base);
      p.drawText(lt, { x: tx, y: ty, size: z, font: B, color: C(DARK), rotate: degrees(rot) });
      let rx = dW - mg;
      for (let k = right.length - 1; k >= 0; k--) {
        const it = right[k], f = it.bold ? B : R, w = tw(N(it.t), f, z * 0.9);
        rx -= w; [tx, ty] = toUser(rx, base);
        p.drawText(N(it.t), { x: tx, y: ty, size: z * 0.9, font: f, color: C(DARK), rotate: degrees(rot) });
        if (it.cat) { rx -= z * 0.85; const [cx, cy] = toUser(rx, strip / 2); pdfSymbol(p, cx, cy, z * 0.5, it.cat, '#475569', '', B, rot); rx -= z * 0.65; }
        rx -= z * 1.3;
      }
      const [l1x, l1y] = toUser(0, strip), [l2x, l2y] = toUser(dW, strip);
      p.drawLine({ start: { x: l1x, y: l1y }, end: { x: l2x, y: l2y }, thickness: z * 0.08, color: C(DARK) });
    });
    out.setTitle(N(cfg.title)); out.setAuthor(N(P.author || P.company || '')); out.setSubject(N(P.name)); out.setCreator('Đánh dấu PDF');
    step('Đang lưu file…');
    const bytes = await out.save();
    unbusy();
    const dd = fmtISO(cfg.date).replace(/\//g, '-');
    const fname = asciiName(`BaoCao_${cfg.no ? cfg.no + '_' : ''}${P.code || P.name}_${dd}.pdf`);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    try { await DB.put('reports', { id: uid(), projectId: P.id, name: fname, title: N(cfg.title), no: cfg.no, count: ms.length, size: blob.size, created: Date.now(), blob }); }
    catch (e) { console.warn('save report', e); }
    renderReports();
    await deliverFile(blob, fname, 'Đã tạo báo cáo', 'Báo cáo được lưu trong mục <b>Báo cáo đã xuất</b> của dự án – có thể chia sẻ lại bất cứ lúc nào.');
    return true;
  } catch (e) {
    unbusy(); console.error(e);
    modal({ title: 'Tạo báo cáo lỗi', html: esc(e.message || e) });
    return false;
  } finally {
    docs.forEach(d => { try { d.destroy(); } catch {} });
  }
}

/* ======================= CSV / BACKUP / RESTORE ======================= */
function exportCSV() {
  if (!S.markers.length) { toast('Chưa có điểm ghi nhận nào'); return; }
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const extraCols = [['proposal', 'Đề xuất xử lý'], ['reply', 'Phản hồi của các bên'], ['basis', 'Căn cứ'], ['fix', 'Yêu cầu / biện pháp khắc phục']];
  const rows = [['Mã', 'Loại', 'Kiểu', 'Bản vẽ', 'Trang', 'Tiêu đề', 'Ghi chú', ...extraCols.map(e => e[1]), 'Phụ trách', 'Hạn xử lý', 'Trạng thái', 'Quá hạn', 'Số ảnh', 'Ngày tạo', 'Cập nhật'].map(q).join(',')];
  sortMarks(S.markers).forEach(m => rows.push([markCode(m), CATS[m.cat].name, KINDS[m.kind], dwgName(m.drawingId), m.page, m.title, m.note,
    ...extraCols.map(([k]) => CATS[m.cat].fields.some(f => f[0] === k) ? m.extra?.[k] || '' : ''),
    m.owner || '', fmtISO(m.due), stOf(m).label, isOverdue(m) ? 'x' : '', m.photoIds.length, fmtDate(m.created), fmtDate(m.updated)].map(q).join(',')));
  deliverFile(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv' }), `${safeName(S.project.code || S.project.name)}_danh-sach.csv`, 'Danh sách (mở bằng Excel)');
}
/* .pmk v2 = "PMK2" + uint32 manifest length + manifest JSON + binary blobs */
async function backupProject(pid) {
  busy('Đang tạo file sao lưu…');
  try {
    const p = await DB.get('projects', pid);
    const dws = await DB.byIdx('drawings', 'projectId', pid);
    const markers = await DB.byIdx('markers', 'projectId', pid), photos = await DB.byIdx('photos', 'projectId', pid);
    const parts = []; let off = 0;
    const add = b => { if (!b) return null; const r = [off, b.size, b.type]; parts.push(b); off += b.size; return r; };
    const drawings = [];
    for (const d of dws) { const pdf = await DB.get('pdfs', d.id); drawings.push({ ...d, thumb: add(d.thumb), pdf: add(pdf?.blob) }); }
    const man = { v: 2, app: APP_VERSION, project: p, drawings, markers, photos: photos.map(ph => ({ ...ph, blob: add(ph.blob), thumb: add(ph.thumb) })) };
    const json = new TextEncoder().encode(JSON.stringify(man));
    const head = new Uint8Array(8); head.set([80, 77, 75, 50]); new DataView(head.buffer).setUint32(4, json.length, true);
    unbusy();
    await deliverFile(new Blob([head, json, ...parts], { type: 'application/octet-stream' }), `${safeName(p.code || p.name)}.pmk`, 'File sao lưu dự án');
  } catch (e) { unbusy(); console.error(e); modal({ title: 'Sao lưu lỗi', html: esc(e.message || e) }); }
}
async function restoreBackup(file) {
  busy('Đang khôi phục…');
  try {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer()), magic = String.fromCharCode(...head.slice(0, 4));
    if (magic !== 'PMK1' && magic !== 'PMK2') throw new Error('Đây không phải file sao lưu .pmk của app');
    const len = new DataView(head.buffer).getUint32(4, true);
    let man = JSON.parse(new TextDecoder().decode(await file.slice(8, 8 + len).arrayBuffer()));
    const base = 8 + len;
    const readBlob = async r => r ? new Blob([await file.slice(base + r[0], base + r[0] + r[1]).arrayBuffer()], { type: r[2] }) : null;
    if (man.v === 1 || magic === 'PMK1') { // old single-PDF backup
      const op = man.project, smap = { todo: 'vm_new', doing: 'vm_sent', done: 'vm_closed' };
      man = { v: 2, project: { id: op.id, name: op.report?.project || op.name, to: op.report?.to || '', signers: '', seq: 1, created: op.created, updated: op.updated, rp: {} },
        drawings: [{ id: op.id, projectId: op.id, name: op.name, pages: op.pages, thumb: man.thumb, pdf: man.pdf, lastPage: 1, created: op.created, updated: op.updated }],
        markers: man.markers.map(m => ({ ...m, cat: 'VM', kind: 'point', drawingId: op.id, status: smap[m.status] || 'vm_new', extra: {} })), photos: man.photos };
    }
    const pid = uid(), now = Date.now();
    const dMap = new Map(man.drawings.map(d => [d.id, uid()])), mkMap = new Map(man.markers.map(m => [m.id, uid()])), phMap = new Map(man.photos.map(ph => [ph.id, uid()]));
    for (const d of man.drawings) {
      $('#busyText').textContent = `Đang khôi phục bản vẽ ${d.name}…`;
      await DB.put('pdfs', { id: dMap.get(d.id), blob: await readBlob(d.pdf) });
      await DB.put('drawings', { ...d, id: dMap.get(d.id), projectId: pid, thumb: await readBlob(d.thumb), pdf: undefined });
    }
    for (const [i, ph] of man.photos.entries()) {
      if (i % 10 === 0) $('#busyText').textContent = `Đang khôi phục ảnh ${i + 1}/${man.photos.length}…`;
      await DB.put('photos', { ...ph, id: phMap.get(ph.id), projectId: pid, markerId: mkMap.get(ph.markerId), blob: await readBlob(ph.blob), thumb: await readBlob(ph.thumb) });
    }
    for (const m of man.markers) await DB.put('markers', { ...m, id: mkMap.get(m.id), projectId: pid, drawingId: dMap.get(m.drawingId), photoIds: (m.photoIds || []).map(x => phMap.get(x)).filter(Boolean) });
    const exists = (await DB.all('projects')).some(x => x.name === man.project.name);
    await DB.put('projects', { ...man.project, id: pid, name: man.project.name + (exists ? ' (khôi phục)' : ''), updated: now });
    requestPersist(); unbusy(); toast(`Đã khôi phục “${man.project.name}”`); renderHome();
  } catch (e) { unbusy(); console.error(e); modal({ title: 'Khôi phục lỗi', html: esc(e.message || e) }); }
}
$('#inBackup').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreBackup(f); });

async function renumber() {
  if (!await confirmBox('Đánh số lại?', 'Mỗi loại sẽ được đánh số liên tục 01, 02… trong toàn dự án, theo thứ tự bản vẽ, trang, từ trên xuống dưới.', 'Đánh số lại')) return;
  const dOrder = id => S.drawings.findIndex(d => d.id === id);
  for (const c of CAT_KEYS) {
    const ms = S.markers.filter(m => m.cat === c).sort((a, b) => dOrder(a.drawingId) - dOrder(b.drawingId) || a.page - b.page || (b.y - a.y) || (a.x - b.x));
    for (let i = 0; i < ms.length; i++) if (ms[i].n !== i + 1) { ms[i].n = i + 1; await saveMarker(ms[i]); }
  }
  renderMarks(); toast('Đã đánh số lại');
}

/* ======================= WIRING ======================= */
$('#btnNewProject').onclick = () => openProjPanel(null);
$('#btnBack').onclick = () => closeLayer('viewer');
$('#btnAdd').onclick = () => { if (S.moveId) { const m = S.markers.find(x => x.id === S.moveId); setMoveMode(null); if (m) openSheet(m); return; } if (S.cur) closeLayer('sheet'); setAddMode(!S.addMode); };
$('#btnFit').onclick = () => animateView(fitTarget());
$('#btnThumbs').onclick = () => {
  S.showThumbs = !S.showThumbs; try { localStorage.setItem('pm.thumbs', S.showThumbs ? '1' : '0'); } catch {}
  $('#btnThumbs').classList.toggle('on', S.showThumbs); renderMarks();
  toast(S.showThumbs ? 'Hiện ảnh thu nhỏ trên bản vẽ' : 'Ẩn ảnh thu nhỏ');
};
$('#btnList').onclick = () => { if (S.cur) flushSheet(); openList(); };
$('#pgPrev').onclick = () => gotoPage(S.pageNum - 1);
$('#pgNext').onclick = () => gotoPage(S.pageNum + 1);
$('#pgLabel').onclick = async () => {
  if (S.doc.numPages < 2) return;
  const n = parseInt(await promptBox(`Đến trang (1–${S.doc.numPages})`, String(S.pageNum)), 10); if (n) gotoPage(n);
};
$('#vTitleBox').onclick = () => renameDrawing(S.drawing);
$('#btnViewMenu').onclick = () => menu([
  { label: 'Lập báo cáo PDF', icon: 'i-export', action: () => openReport([S.drawing.id]) },
  { label: 'Xuất bản vẽ đã đánh dấu', icon: 'i-doc', action: exportDrawingDialog },
  { label: 'Bộ lọc', icon: 'i-filter', action: openFilter },
  { label: 'Xuất danh sách (Excel/CSV)', icon: 'i-list', action: exportCSV },
  '-',
  { label: 'Đánh số lại các điểm', icon: 'i-pin', action: renumber },
  { label: 'Đổi tên bản vẽ', icon: 'i-edit', action: () => renameDrawing(S.drawing) },
  { label: 'Hướng dẫn sử dụng', icon: 'i-search', action: showHelp },
]);
$('#btnHomeMenu').onclick = () => menu([
  { label: 'Khôi phục từ file sao lưu (.pmk)', icon: 'i-export', action: () => $('#inBackup').click() },
  { label: 'Cài app lên màn hình chính', icon: 'i-plus', action: showInstallHelp },
  { label: 'Hướng dẫn sử dụng', icon: 'i-search', action: showHelp },
]);
function showHelp() {
  modal({ title: 'Hướng dẫn nhanh', html: `<ol>
    <li>Tạo <b>dự án</b> và khai báo: mã dự án, chủ đầu tư, đơn vị lập, logo, các bên ký. Mỗi dự án dùng thông tin riêng.</li>
    <li><b>Thêm bản vẽ PDF</b> vào dự án (chọn được nhiều file một lúc).</li>
    <li>Trong bản vẽ bấm <b>Đánh dấu</b> → chọn <b>loại</b> (vướng mắc, phát sinh, thay đổi…) và <b>kiểu</b>: điểm, vùng, vùng mây hoặc mũi tên → chạm/kéo trên bản vẽ.</li>
    <li>Mỗi loại có <b>ký hiệu riêng</b>, màu thể hiện <b>trạng thái</b>. Vướng mắc và Phát sinh có quy trình trạng thái riêng.</li>
    <li>Nhập tiêu đề, ghi chú, phụ trách, hạn xử lý; chụp hoặc chọn ảnh hiện trường.</li>
    <li><b>Bộ lọc</b> theo loại, trạng thái, phụ trách, quá hạn – áp dụng cho bản vẽ và danh sách.</li>
    <li><b>Lập báo cáo PDF</b>: chọn loại, bản vẽ, trạng thái → bìa, bảng tổng hợp, ký xác nhận, phụ lục bản vẽ và ảnh. Số báo cáo tự tăng.</li>
    <li><b>Sao lưu .pmk</b> để chuyển dự án sang máy khác hoặc gửi đồng nghiệp.</li></ol>` });
}
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; renderInstallBox(); });
function isStandalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function renderInstallBox() {
  const box = $('#installBox');
  if (isStandalone()) { box.hidden = true; return; }
  if (deferredInstall) {
    box.innerHTML = '<p>Cài app lên điện thoại để mở nhanh và dùng khi không có mạng.</p><button class="btn primary">Cài đặt</button>';
    box.querySelector('button').onclick = async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; box.hidden = true; };
    box.hidden = false;
  } else if (isIOS()) { box.innerHTML = '<p>Cài app: bấm nút <b>Chia sẻ</b> của Safari → <b>Thêm vào MH chính</b>.</p>'; box.hidden = false; }
}
function showInstallHelp() {
  if (deferredInstall) { deferredInstall.prompt(); return; }
  modal({ title: 'Cài app lên điện thoại', html: isStandalone() ? '<p>App đã được cài và đang chạy ở chế độ ứng dụng.</p>' : `
    <p><b>Android (Chrome):</b> menu ⋮ của Chrome → <b>Thêm vào màn hình chính</b> / <b>Cài đặt ứng dụng</b>.</p>
    <p><b>iPhone (Safari):</b> nút <b>Chia sẻ</b> → <b>Thêm vào MH chính</b> → <b>Thêm</b>.</p>` });
}
let lastW = window.innerWidth;
window.addEventListener('resize', () => {
  if (!S.page || Math.abs(window.innerWidth - lastW) < 2) return;
  lastW = window.innerWidth; clearTimeout(window._rz); window._rz = setTimeout(() => gotoPage(S.pageNum), 200);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSheet(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Đã có bản cập nhật – đóng và mở lại app để dùng bản mới', 5000); });
    });
  }).catch(e => console.warn('SW', e));
}
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async p => {
    if (!p.files?.length) return;
    const files = await Promise.all(p.files.map(f => f.getFile()));
    if (S.project) addDrawings(files); else toast('Hãy mở một dự án rồi thêm bản vẽ');
  });
}
history.replaceState({ layer: 'home', n: 0 }, '');
renderHome();
renderInstallBox();
setTimeout(() => (window.requestIdleCallback || (f => f()))(() => loadPdfLib().catch(() => {})), 4000);
