'use strict';
/* Cropper — кроп, бесшовные сплиты и коллажи для Instagram-каруселей.
   Один и тот же код работает в окне приложения (Electron) и на телефоне через Wi-Fi. */

const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dpr = () => window.devicePixelRatio || 1;
const isPhoneLayout = () => innerWidth <= 860;
const store = {
  get(k, d) { try { const v = localStorage.getItem('cropper.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cropper.' + k, JSON.stringify(v)); } catch {} },
};

// ---------- окружение ----------
const NATIVE = window.cropperNative || null;
let KEY = new URLSearchParams(location.search).get('k');
if (KEY) store.set('key', KEY); else KEY = store.get('key', null);
const HAS_API = /^https?:$/.test(location.protocol) && !!KEY;
const api = (p, opt) => fetch(p + (p.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(KEY), opt);

// ---------- каталог: на ПК — папка на диске, в браузере/на телефоне — IndexedDB ----------
const Catalog = NATIVE ? {
  where: 'disk',
  async load() { const r = await NATIVE.catalogLoad(); return { dir: r.dir, zoom: r.zoom, data: r.data ? JSON.parse(r.data) : null }; },
  save: (json) => NATIVE.catalogSave(json),
  saveSync: (json) => NATIVE.catalogSaveSync(json),
  async put(file, id) {
    const p = NATIVE.pathForFile(file);
    if (p && S.importMode === 'link') return { path: p };
    return { path: await NATIVE.catalogWrite(`${id}_${file.name}`, await file.arrayBuffer()), owned: true };
  },
  async get(src) { const buf = await NATIVE.readFile(src.path); return buf ? new Blob([buf]) : null; },
  async remove(src) { if (src.owned) await NATIVE.trash(src.path); },
} : (() => {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('cropper', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('files'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => { const t = d.transaction(store, mode); const q = fn(t.objectStore(store)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); });
  };
  return {
    where: 'browser',
    async load() { const s = await tx('kv', 'readonly', (o) => o.get('catalog')).catch(() => null); return { data: s ? JSON.parse(s) : null }; },
    save: (json) => tx('kv', 'readwrite', (o) => o.put(json, 'catalog')),
    saveSync(json) { this.save(json).catch(() => {}); },
    async put(file, id) { await tx('files', 'readwrite', (o) => o.put(file, id)); return { idb: id }; },
    get: (src) => tx('files', 'readonly', (o) => o.get(src.idb)),
    remove: (src) => tx('files', 'readwrite', (o) => o.delete(src.idb)),
  };
})();

function serialize() {
  // Общие объекты кадра (обложка ↔ развороты) сохраняем как ссылки на таблицу кадров
  const ids = new Map(), crops = [];
  const ref = (c) => { if (!ids.has(c)) { ids.set(c, crops.length); crops.push({ cx: c.cx, cy: c.cy, z: c.z }); } return ids.get(c); };
  const projects = S.projects.map((p) => ({
    id: p.id, name: p.name, cur: p.id === S.project ? S.cur : p.cur,
    blocks: p.blocks.map((b) => ({ ...b, cells: b.cells.map((c) => ({ img: c.img, crop: ref(c.crop) })) })),
  }));
  const images = S.order.map((id) => { const e = S.images.get(id); return { id, name: e.name, w: e.w, h: e.h, thumb: e.thumb, src: e.src || null }; });
  return JSON.stringify({ v: 1, uid, images, projects, crops, project: S.project });
}

function restore(d) {
  uid = Math.max(uid, d.uid || 1);
  for (const m of d.images || []) {
    S.images.set(m.id, { id: m.id, name: m.name, w: m.w, h: m.h, thumb: m.thumb, src: m.src });
    S.order.push(m.id);
  }
  const crops = (d.crops || []).map((c) => ({ ...c }));
  S.projects = (d.projects || []).map((p) => ({
    id: p.id, name: p.name, cur: p.cur,
    blocks: p.blocks.map((b) => ({ ...b, cells: b.cells.map((c) => ({ img: S.images.has(c.img) ? c.img : null, crop: crops[c.crop] || mkCrop() })) })),
  }));
  if (S.projects.length) switchProject(S.projects.some((p) => p.id === d.project) ? d.project : S.projects[0].id, true);
}

let saveTimer = 0, catalogReady = false;
function scheduleSave() {
  if (!catalogReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => Catalog.save(serialize()).catch((e) => toast('Не удалось сохранить каталог: ' + e.message)), 400);
}
function saveNow() { if (catalogReady) { clearTimeout(saveTimer); Catalog.saveSync(serialize()); } }

// ---------- карусели (проекты) ----------
function newProject(name) {
  const p = { id: uid++, name: name || `Карусель ${S.projects.length + 1}`, blocks: [], cur: null };
  S.projects.push(p);
  return p;
}
function switchProject(id, silent) {
  const old = S.projects.find((p) => p.id === S.project);
  if (old) old.cur = S.cur;
  const p = S.projects.find((x) => x.id === id) || S.projects[0];
  S.project = p.id; S.blocks = p.blocks; S.cur = p.cur ?? (p.blocks[0] && p.blocks[0].id) ?? null; S.cell = 0;
  usedImages(p.blocks).forEach((e) => ensureLoaded(e).then(() => { queueEditor(); dirty(); }));
  if (!silent) refreshAll();
}
function renderProjects() {
  $('#projSel').innerHTML = S.projects.map((p) => `<option value="${p.id}" ${p.id === S.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#projDel').disabled = false;
}

// ---------- константы ----------
const FRAMES = { '4:5': [4, 5], '3:4': [3, 4], '1:1': [1, 1] };
const WIDTHS = [1080, 1440, 1600, 2160];
const FONTS = ['Cormorant Garamond', 'Bodoni Moda', 'Playfair Display', 'Bebas Neue', 'Inter'];
const TYPE_NAME = { hstrips: 'Горизонтальные полосы', vstrips: 'Вертикальные полосы', pano: 'Сплит / панорама' };
const MAX_SLIDES = 20;

let uid = 1;
const S = {
  images: new Map(), order: [], sel: [],
  projects: [], project: null, // несколько каруселей; S.blocks — блоки текущей
  blocks: [], cur: null, cell: 0,
  importMode: store.get('importMode', 'copy'),
  frame: store.get('frame', '4:5'), width: store.get('width', 1440), quality: store.get('quality', 92),
  prefix: store.get('prefix', 'carousel'),
  overlay: store.get('overlay', { grid: false, thirds: false }),
  inboxNew: [],
};
if (!FRAMES[S.frame]) S.frame = '4:5';

// ---------- модель ----------
const mkCrop = () => ({ cx: 0.5, cy: 0.5, z: 1 });
const mkCell = (img = null) => ({ img, crop: mkCrop() });

function mkBlock(type, o = {}) {
  const b = {
    id: uid++, type, n: o.n || 1, gap: o.gap || 0, gapColor: o.gapColor || '#000000', margins: false, bg: '#000000',
    text: Object.assign({ mode: 'none', value: '', font: 'Cormorant Garamond', weight: '300', size: 0.13, tracking: 0, y: 0.5, color: '#ffffff', opacity: 1, shadow: true }, o.text || {}),
    cells: [],
  };
  const count = type === 'pano' ? 1 : o.count || 3;
  for (let i = 0; i < count; i++) b.cells.push(mkCell(o.imgs && o.imgs[i] != null ? o.imgs[i] : null));
  return b;
}
function panoEach(imgs, n) {
  return (imgs.length ? imgs : [null]).map((id) => { const b = mkBlock('pano', { n }); b.cells[0].img = id; return b; });
}
// Развороты: каждая полоса обложки → отдельные бесшовные слайды.
// Для горизонтальных полос кадр общий (один объект crop), поэтому обложка и развороты совпадают и правятся вместе.
function followupsOf(b) {
  return b.cells.filter((c) => c.img != null).map((c) => {
    const p = mkBlock('pano', { n: b.type === 'hstrips' ? b.cells.length : 1 });
    p.cells[0].img = c.img;
    p.cells[0].crop = b.type === 'hstrips' ? c.crop : { cx: c.crop.cx, cy: c.crop.cy, z: 1 };
    return p;
  });
}
const slidesOf = (b) => (b.type === 'pano' ? b.n : 1);
const totalSlides = () => S.blocks.reduce((s, b) => s + slidesOf(b), 0);
const cur = () => S.blocks.find((b) => b.id === S.cur) || null;
const isLinked = (crop) => S.blocks.reduce((n, b) => n + b.cells.filter((c) => c.crop === crop).length, 0) > 1;

const TEMPLATES = [
  { name: 'Кино-карусель', sub: 'обложка 3×21:9 + развороты', icon: 'cine', feature: true,
    make: (imgs) => { const c = mkBlock('hstrips', { count: 3, imgs }); return [c, ...followupsOf(c)]; } },
  { name: 'Кино-триптих', sub: '3 полосы 21:9', icon: 'cine', make: (imgs) => [mkBlock('hstrips', { count: 3, imgs })] },
  { name: 'Триптих с линиями', sub: 'полосы + разделители', icon: 'cineGap',
    make: (imgs) => [mkBlock('hstrips', { count: 3, gap: 0.004, gapColor: '#f3efe8', imgs })] },
  { name: 'Полосы + слово', sub: 'вертикальные, по букве', icon: 'vword',
    make: (imgs) => [mkBlock('vstrips', { count: clamp(imgs.length || 5, 2, 8), imgs, text: { mode: 'letters', value: 'NIGHT' } })] },
  { name: 'Сплит на 2', sub: 'бесшовно, 2 слайда', icon: 'split2', make: (imgs) => panoEach(imgs, 2) },
  { name: 'Панорама на 3', sub: 'бесшовно, 3 слайда', icon: 'split3', make: (imgs) => panoEach(imgs, 3) },
  { name: 'Одиночный', sub: 'кроп под формат', icon: 'single', make: (imgs) => panoEach(imgs, 1) },
  { name: 'Постер', sub: 'кадр + заголовок', icon: 'poster',
    make: (imgs) => panoEach(imgs, 1).map((b) => Object.assign(b, { text: { ...b.text, mode: 'title', value: 'THE TITLE', font: 'Cormorant Garamond', weight: '400', size: 0.09, tracking: 0.25, y: 0.16 } })) },
];
const ICONS = {
  cine: '<rect x="5" y="3" width="20" height="7.3" rx="1"/><rect x="5" y="11.35" width="20" height="7.3" rx="1"/><rect x="5" y="19.7" width="20" height="7.3" rx="1"/>',
  cineGap: '<rect x="5" y="3" width="20" height="7" rx="1"/><rect x="5" y="11.5" width="20" height="7" rx="1"/><rect x="5" y="20" width="20" height="7" rx="1"/>',
  vword: '<rect x="5" y="3" width="3.6" height="24" rx="1"/><rect x="9.1" y="3" width="3.6" height="24" rx="1"/><rect x="13.2" y="3" width="3.6" height="24" rx="1"/><rect x="17.3" y="3" width="3.6" height="24" rx="1"/><rect x="21.4" y="3" width="3.6" height="24" rx="1"/>',
  split2: '<rect x="1" y="7" width="13.6" height="17" rx="1"/><rect x="15.4" y="7" width="13.6" height="17" rx="1"/>',
  split3: '<rect x="1" y="9" width="8.9" height="11.2" rx="1"/><rect x="10.55" y="9" width="8.9" height="11.2" rx="1"/><rect x="20.1" y="9" width="8.9" height="11.2" rx="1"/>',
  single: '<rect x="7" y="3" width="16" height="20" rx="1.5"/>',
  poster: '<path d="M7 4.5A1.5 1.5 0 0 1 8.5 3h13A1.5 1.5 0 0 1 23 4.5v19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 7 23.5zM10 7v1.6h10V7z" fill-rule="evenodd"/>',
};

// ---------- фото ----------
const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

// Пирамида уменьшенных копий: рисуем всегда с уровня, который не более чем в 2 раза больше цели — так качество даунскейла высокое.
function getLevel(e, s) {
  let i = 0;
  for (;;) {
    const lv = e.levels[i];
    if (lv.f / 2 < s || lv.w < 64 || lv.h < 64) return lv;
    if (!e.levels[i + 1]) {
      const w = Math.max(1, Math.round(lv.w / 2)), h = Math.max(1, Math.round(lv.h / 2));
      const c = makeCanvas(w, h), x = c.getContext('2d');
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(lv.src, 0, 0, w, h);
      e.levels[i + 1] = { src: c, w, h, f: lv.f / 2 };
    }
    i++;
  }
}

// onload, а не img.decode(): decode() может не завершиться в свёрнутом/скрытом окне
function loadImg(blob) {
  const url = URL.createObjectURL(blob), img = new Image();
  return new Promise((res) => {
    img.onload = () => res(img.naturalWidth ? img : null);
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}

async function addImageFile(file) {
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(file.name)) return null;
  const img = await loadImg(file);
  if (!img) { toast(`Не удалось открыть ${file.name}`); return null; }
  const e = { id: uid++, name: file.name, file, w: img.naturalWidth, h: img.naturalHeight };
  e.levels = [{ src: img, w: e.w, h: e.h, f: 1 }];
  const s = 240 / Math.max(e.w, e.h);
  const tw = Math.max(1, Math.round(e.w * s)), th = Math.max(1, Math.round(e.h * s));
  const tc = makeCanvas(tw, th);
  tc.getContext('2d').drawImage(getLevel(e, s).src, 0, 0, tw, th);
  e.thumb = tc.toDataURL('image/jpeg', 0.8);
  try { e.src = await Catalog.put(file, e.id); } catch (err) { toast(`Не удалось сохранить ${file.name} в каталог: ${err.message}`); }
  S.images.set(e.id, e);
  S.order.push(e.id);
  return e.id;
}

// Фото из каталога грузятся лениво — при первом показе в карусели
function ensureLoaded(e) {
  if (e.levels || e.missing) return Promise.resolve(e);
  if (!e.loading) {
    e.loading = (async () => {
      const blob = e.src ? await Catalog.get(e.src).catch(() => null) : null;
      const img = blob && (await loadImg(blob));
      if (img) { e.levels = [{ src: img, w: img.naturalWidth, h: img.naturalHeight, f: 1 }]; e.w = img.naturalWidth; e.h = img.naturalHeight; }
      else e.missing = true;
      e.loading = null;
      return e;
    })();
  }
  return e.loading;
}
const usedImages = (blocks) => [...new Set(blocks.flatMap((b) => b.cells.map((c) => c.img)).filter((id) => id != null && S.images.has(id)))].map((id) => S.images.get(id));

async function importFiles(list) {
  const files = [...list];
  if (!files.length) return [];
  const ids = [];
  busy(`Загрузка фото… 0/${files.length}`);
  for (let i = 0; i < files.length; i++) {
    const id = await addImageFile(files[i]);
    if (id) ids.push(id);
    busy(`Загрузка фото… ${i + 1}/${files.length}`);
  }
  busy(false);
  renderLibrary();
  return ids;
}

function removeImage(id) {
  const e = S.images.get(id);
  if (!e) return;
  const usedIn = S.projects.filter((p) => p.blocks.some((b) => b.cells.some((c) => c.img === id))).length;
  if (usedIn && !confirm(`Фото используется в ${usedIn} ${plural(usedIn, 'карусели', 'каруселях', 'каруселях')}. Убрать его из каталога?`)) return;
  S.projects.forEach((p) => p.blocks.forEach((b) => b.cells.forEach((c) => { if (c.img === id) { c.img = null; c.crop = mkCrop(); } })));
  if (e.levels) URL.revokeObjectURL(e.levels[0].src.src);
  if (e.src) Catalog.remove(e.src).catch(() => {});
  S.images.delete(id);
  S.order = S.order.filter((x) => x !== id);
  S.sel = S.sel.filter((x) => x !== id);
  refreshAll();
}

// ---------- геометрия кадра ----------
function frameSize(width) { const [a, b] = FRAMES[S.frame]; return { W: width, H: Math.round((width * b) / a) }; }

function layout(b, W, H) {
  if (b.type === 'pano') return { w: W * b.n, h: H, W, H, cells: [{ x: 0, y: 0, w: W * b.n, h: H }] };
  const K = b.cells.length, g = Math.round(b.gap * W), cells = [];
  if (b.type === 'hstrips') {
    const a = (H - g * (K - 1)) / K;
    for (let i = 0; i < K; i++) { const y0 = Math.round(i * (a + g)), y1 = Math.round(i * (a + g) + a); cells.push({ x: 0, y: y0, w: W, h: y1 - y0 }); }
  } else {
    const a = (W - g * (K - 1)) / K;
    for (let i = 0; i < K; i++) { const x0 = Math.round(i * (a + g)), x1 = Math.round(i * (a + g) + a); cells.push({ x: x0, y: 0, w: x1 - x0, h: H }); }
  }
  return { w: W, h: H, W, H, cells };
}

// Кадр хранится как центр (доли от фото) + зум относительно «заполнить ячейку». Так он переживает смену формата и числа полос.
function cropRect(e, crop, a) {
  const coverW = Math.min(e.w, e.h * a);
  const w = coverW / crop.z, h = w / a;
  return { x: crop.cx * e.w - w / 2, y: crop.cy * e.h - h / 2, w, h };
}
function clampCrop(e, crop, a, margins) {
  if (!margins) {
    crop.z = clamp(crop.z, 1, 40);
    const r = cropRect(e, crop, a);
    const hw = r.w / 2 / e.w, hh = r.h / 2 / e.h;
    crop.cx = hw >= 0.5 ? 0.5 : clamp(crop.cx, hw, 1 - hw);
    crop.cy = hh >= 0.5 ? 0.5 : clamp(crop.cy, hh, 1 - hh);
  } else {
    crop.z = clamp(crop.z, 0.1, 40);
    crop.cx = clamp(crop.cx, -0.5, 1.5);
    crop.cy = clamp(crop.cy, -0.5, 1.5);
  }
}
function fitWholeZoom(e, a) { return Math.min(e.w, e.h * a) / Math.max(e.w, e.h * a); }

// ---------- отрисовка ----------
function drawCell(ctx, e, crop, a, r, bg) {
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.fillStyle = bg; ctx.fillRect(r.x, r.y, r.w, r.h);
  const c = cropRect(e, crop, a);
  const s = r.w / c.w;
  const x0 = Math.max(0, c.x), y0 = Math.max(0, c.y), x1 = Math.min(e.w, c.x + c.w), y1 = Math.min(e.h, c.y + c.h);
  if (x1 > x0 && y1 > y0) {
    const L = getLevel(e, s), fx = L.w / e.w, fy = L.h / e.h;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(L.src, x0 * fx, y0 * fy, (x1 - x0) * fx, (y1 - y0) * fy,
      r.x + (x0 - c.x) * s, r.y + (y0 - c.y) * s, (x1 - x0) * s, (y1 - y0) * s);
  }
  ctx.restore();
}

function drawPlaceholder(ctx, r, i, label) {
  ctx.save();
  ctx.fillStyle = '#1a1c21'; ctx.fillRect(r.x, r.y, r.w, r.h);
  const d = Math.max(1, Math.min(r.w, r.h) / 120);
  ctx.strokeStyle = '#3a3d45'; ctx.lineWidth = d; ctx.setLineDash([5 * d, 4 * d]);
  ctx.strokeRect(r.x + 4 * d, r.y + 4 * d, r.w - 8 * d, r.h - 8 * d);
  const fs = clamp(Math.min(r.w, r.h) * 0.12, 7, 15 * dpr());
  ctx.fillStyle = '#6b6f78'; ctx.font = `500 ${fs}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label || (r.w > fs * 9 ? `Фото ${i + 1} — перетащи сюда` : String(i + 1)), r.x + r.w / 2, r.y + r.h / 2);
  ctx.restore();
}

function drawText(ctx, b, L, k) {
  const t = b.text, val = (t.value || '').trim();
  if (t.mode === 'none' || !val) return;
  // Размер шрифта — от ширины одного слайда, а сам текст может тянуться через всю панораму
  const W = L.w * k, H = L.h * k, size = t.size * L.W * k;
  ctx.save();
  ctx.font = `${t.weight} ${size}px "${t.font}", Georgia, serif`;
  ctx.fillStyle = t.color; ctx.globalAlpha = t.opacity; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (t.shadow) { ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = size * 0.3; }
  const y = t.y * H;
  if (t.mode === 'letters') {
    const ch = [...val.replace(/\s+/g, '')];
    const centers = b.type === 'vstrips' && ch.length === L.cells.length
      ? L.cells.map((r) => (r.x + r.w / 2) * k)
      : ch.map((_, i) => ((i + 0.5) * W) / ch.length);
    ch.forEach((c, i) => ctx.fillText(c, centers[i], y));
  } else {
    const sp = t.tracking * size;
    if ('letterSpacing' in ctx) ctx.letterSpacing = sp + 'px';
    ctx.fillText(val, W / 2 + sp / 2, y);
  }
  ctx.restore();
}

function paint(ctx, b, L, ox, oy, k, placeholders) {
  ctx.save();
  ctx.translate(ox, oy);
  ctx.fillStyle = b.type === 'pano' ? b.bg : b.gapColor;
  ctx.fillRect(0, 0, L.w * k, L.h * k);
  L.cells.forEach((r, i) => {
    const c = b.cells[i], e = c.img != null && S.images.get(c.img), a = r.w / r.h;
    const rr = { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
    if (e && e.levels) { clampCrop(e, c.crop, a, b.margins); drawCell(ctx, e, c.crop, a, rr, b.bg); }
    else if (e) {
      if (!e.missing) ensureLoaded(e).then(() => { queueEditor(); dirty(); });
      drawPlaceholder(ctx, rr, i, e.missing ? 'Файл не найден' : 'Загрузка…');
    } else if (placeholders) drawPlaceholder(ctx, rr, i);
    else { ctx.fillStyle = b.bg; ctx.fillRect(rr.x, rr.y, rr.w, rr.h); }
  });
  drawText(ctx, b, L, k);
  ctx.restore();
}

// ---------- редактор ----------
const ed = $('#editor'), edx = ed.getContext('2d');
let EM = null, edQueued = false;
const queueEditor = () => { if (!edQueued) { edQueued = true; requestAnimationFrame(() => { edQueued = false; renderEditor(); }); } };

// Вид холста (как в Photoshop): масштаб поверх «вписать» и сдвиг в CSS-пикселях
const VIEW = { block: null, z: 1, x: 0, y: 0 };
function viewZoomAt(p, f) {
  if (!EM) return;
  const d = dpr(), z = clamp(VIEW.z * f, 0.2, 12);
  const u = (p.x - EM.ox) / EM.k, v = (p.y - EM.oy) / EM.k; // точка кадра под курсором остаётся на месте
  const k2 = EM.kFit * z;
  VIEW.x = (p.x - u * k2 - (ed.width - EM.L.w * k2) / 2) / d;
  VIEW.y = (p.y - v * k2 - (ed.height - EM.L.h * k2) / 2) / d;
  VIEW.z = z;
  queueEditor();
}
function viewFit() { Object.assign(VIEW, { z: 1, x: 0, y: 0 }); queueEditor(); }
function edCenter() { return { x: ed.width / 2, y: ed.height / 2 }; }
function toggleFocus(on = !document.body.classList.contains('focus')) {
  document.body.classList.toggle('focus', on);
  if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setTimeout(viewFit, 60);
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('focus')) toggleFocus(false); });

function sizeEditor() {
  const r = ed.parentElement.getBoundingClientRect(), d = dpr();
  ed.width = Math.max(1, Math.round(r.width * d));
  ed.height = Math.max(1, Math.round(r.height * d));
  renderEditor();
}

function renderEditor() {
  edx.setTransform(1, 0, 0, 1, 0, 0);
  edx.clearRect(0, 0, ed.width, ed.height);
  const b = cur();
  $('#edEmpty').hidden = !!b;
  if (!b) { EM = null; return; }
  const d = dpr();
  const { W, H } = frameSize(S.width);
  const L = layout(b, W, H);
  const pad = (isPhoneLayout() ? 10 : 34) * d;
  const kFit = Math.min((ed.width - 2 * pad) / L.w, (ed.height - 2 * pad - (isPhoneLayout() ? 0 : 36 * d)) / L.h);
  if (VIEW.block !== b.id) Object.assign(VIEW, { block: b.id, z: 1, x: 0, y: 0 }); // новый блок — вписать
  const k = kFit * VIEW.z;
  const ox = Math.round((ed.width - L.w * k) / 2 + VIEW.x * d), oy = Math.round((ed.height - L.h * k) / 2 + VIEW.y * d);
  paint(edx, b, L, ox, oy, k, true);
  EM = { b, L, ox, oy, k, W, H, kFit };
  $('#zoomPct').textContent = `${Math.round(VIEW.z * 100)}%`;

  edx.save();
  if (b.type === 'pano' && b.n > 1) {
    edx.strokeStyle = 'rgba(255,255,255,.75)'; edx.lineWidth = d; edx.setLineDash([6 * d, 5 * d]);
    for (let i = 1; i < b.n; i++) { const x = Math.round(ox + i * W * k) + 0.5; edx.beginPath(); edx.moveTo(x, oy); edx.lineTo(x, oy + H * k); edx.stroke(); }
    edx.setLineDash([]);
    edx.fillStyle = 'rgba(0,0,0,.55)'; edx.font = `600 ${11 * d}px Inter, sans-serif`;
    for (let i = 0; i < b.n; i++) { const x = ox + i * W * k + 8 * d; edx.fillRect(x - 4 * d, oy + 6 * d, 22 * d, 17 * d); edx.fillStyle = '#fff'; edx.fillText(String(i + 1), x + 2 * d, oy + 18 * d); edx.fillStyle = 'rgba(0,0,0,.55)'; }
  }
  if (S.overlay.grid && S.blocks[0] === b) {
    // В сетке профиля Instagram показывает превью 3:4 по центру первого слайда
    const sw = W * k, sh = H * k;
    edx.fillStyle = 'rgba(0,0,0,.5)';
    if (W / H > 0.75) { const vw = sh * 0.75, m = (sw - vw) / 2; edx.fillRect(ox, oy, m, sh); edx.fillRect(ox + sw - m, oy, m, sh); }
    else if (W / H < 0.75) { const vh = sw / 0.75, m = (sh - vh) / 2; edx.fillRect(ox, oy, sw, m); edx.fillRect(ox, oy + sh - m, sw, m); }
  }
  const r = L.cells[S.cell];
  if (r) {
    const rx = ox + r.x * k, ry = oy + r.y * k, rw = r.w * k, rh = r.h * k;
    if (S.overlay.thirds) {
      edx.strokeStyle = 'rgba(255,255,255,.35)'; edx.lineWidth = d;
      for (let i = 1; i < 3; i++) {
        edx.beginPath(); edx.moveTo(rx + (rw * i) / 3, ry); edx.lineTo(rx + (rw * i) / 3, ry + rh); edx.stroke();
        edx.beginPath(); edx.moveTo(rx, ry + (rh * i) / 3); edx.lineTo(rx + rw, ry + (rh * i) / 3); edx.stroke();
      }
    }
    if (b.cells.length > 1) { edx.strokeStyle = '#ff8a3d'; edx.lineWidth = 2 * d; edx.strokeRect(rx + d, ry + d, rw - 2 * d, rh - 2 * d); }
  }
  edx.restore();
  updateResInfo();
}

function edPoint(ev) { const r = ed.getBoundingClientRect(), d = dpr(); return { x: (ev.clientX - r.left) * d, y: (ev.clientY - r.top) * d }; }
function cellAt(p) {
  if (!EM) return -1;
  return EM.L.cells.findIndex((r) => {
    const x = EM.ox + r.x * EM.k, y = EM.oy + r.y * EM.k;
    return p.x >= x && p.x < x + r.w * EM.k && p.y >= y && p.y < y + r.h * EM.k;
  });
}
function cellCtx(i) {
  if (!EM) return null;
  const c = EM.b.cells[i], e = c && c.img != null && S.images.get(c.img);
  if (!e) return null;
  const r = EM.L.cells[i];
  return { c, e, r, a: r.w / r.h };
}
function panBy(i, dx, dy) {
  const x = cellCtx(i); if (!x) return;
  const cr = cropRect(x.e, x.c.crop, x.a), s = cr.w / (x.r.w * EM.k);
  x.c.crop.cx -= (dx * s) / x.e.w;
  x.c.crop.cy -= (dy * s) / x.e.h;
  clampCrop(x.e, x.c.crop, x.a, EM.b.margins);
}
function zoomAt(i, p, f) {
  const x = cellCtx(i); if (!x) return;
  const cr = cropRect(x.e, x.c.crop, x.a);
  const sx = EM.ox + x.r.x * EM.k, sy = EM.oy + x.r.y * EM.k;
  const u = (p.x - sx) / (x.r.w * EM.k), v = (p.y - sy) / (x.r.h * EM.k);
  const ix = cr.x + u * cr.w, iy = cr.y + v * cr.h;
  x.c.crop.z = clamp(x.c.crop.z * f, EM.b.margins ? 0.1 : 1, 40);
  const w2 = Math.min(x.e.w, x.e.h * x.a) / x.c.crop.z, h2 = w2 / x.a;
  x.c.crop.cx = (ix - u * w2 + w2 / 2) / x.e.w;
  x.c.crop.cy = (iy - v * h2 + h2 / 2) / x.e.h;
  clampCrop(x.e, x.c.crop, x.a, EM.b.margins);
  syncZoomSlider();
}

const ptrs = new Map();
let drag = null, pinch = null, viewDrag = null, spaceDown = false;
ed.addEventListener('pointerdown', (ev) => {
  if (!EM) return;
  const p = edPoint(ev);
  const i = cellAt(p);
  // Двигаем холст: пробел + мышь, средняя кнопка или перетаскивание по пустому месту
  if (!ptrs.size && (spaceDown || ev.button === 1 || i < 0)) {
    ev.preventDefault();
    ed.setPointerCapture(ev.pointerId);
    viewDrag = { id: ev.pointerId, last: p };
    ed.classList.add('dragging');
    return;
  }
  if (viewDrag) return;
  ed.setPointerCapture(ev.pointerId);
  ptrs.set(ev.pointerId, p);
  if (ptrs.size === 1) {
    if (S.cell !== i) { S.cell = i; buildPanel(); }
    drag = { i, last: p };
    ed.classList.add('dragging');
    queueEditor();
  } else if (ptrs.size === 2 && drag) {
    const [a, b] = [...ptrs.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
});
ed.addEventListener('pointermove', (ev) => {
  if (viewDrag && viewDrag.id === ev.pointerId) {
    const p = edPoint(ev), d = dpr();
    VIEW.x += (p.x - viewDrag.last.x) / d;
    VIEW.y += (p.y - viewDrag.last.y) / d;
    viewDrag.last = p;
    queueEditor();
    return;
  }
  if (!ptrs.has(ev.pointerId)) return;
  const p = edPoint(ev);
  ptrs.set(ev.pointerId, p);
  if (pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (pinch.dist > 0) zoomAt(drag.i, mid, dist / pinch.dist);
    panBy(drag.i, mid.x - pinch.mid.x, mid.y - pinch.mid.y);
    pinch.dist = dist; pinch.mid = mid;
  } else if (drag) {
    panBy(drag.i, p.x - drag.last.x, p.y - drag.last.y);
    drag.last = p;
  }
  queueEditor();
});
function endPointer(ev) {
  if (viewDrag && viewDrag.id === ev.pointerId) { viewDrag = null; ed.classList.remove('dragging'); return; }
  if (!ptrs.has(ev.pointerId)) return;
  ptrs.delete(ev.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (ptrs.size === 1 && drag) drag.last = [...ptrs.values()][0];
  if (!ptrs.size && drag) { drag = null; ed.classList.remove('dragging'); dirty(); }
}
ed.addEventListener('pointerup', endPointer);
ed.addEventListener('pointercancel', endPointer);
ed.addEventListener('wheel', (ev) => {
  if (!EM) return;
  ev.preventDefault();
  const p = edPoint(ev), i = cellAt(p);
  // Ctrl/Alt + колесо (и щипок на тачпаде) или колесо мимо кадра — масштаб холста; просто колесо над фото — зум фото в кадре
  if (ev.ctrlKey || ev.altKey || ev.metaKey || i < 0) { viewZoomAt(p, Math.exp(-ev.deltaY * 0.002)); return; }
  if (S.cell !== i) { S.cell = i; buildPanel(); }
  zoomAt(i, p, Math.exp(-ev.deltaY * 0.0015));
  queueEditor();
  dirty();
}, { passive: false });
ed.addEventListener('dblclick', (ev) => {
  const i = cellAt(edPoint(ev));
  if (i < 0) return;
  S.cell = i;
  $('#cellFile').click();
});
$('#cellFile').addEventListener('change', async (ev) => {
  const ids = await importFiles(ev.target.files);
  ev.target.value = '';
  if (ids[0] && cur()) assignCell(cur(), S.cell, ids[0]);
});

// Перетаскивание фото: из библиотеки в ячейку или файлов с диска
const edwrap = $('#edwrap');
edwrap.addEventListener('dragover', (ev) => { ev.preventDefault(); edwrap.classList.add('dragover'); });
edwrap.addEventListener('dragleave', () => edwrap.classList.remove('dragover'));
edwrap.addEventListener('drop', async (ev) => {
  ev.preventDefault(); ev.stopPropagation();
  edwrap.classList.remove('dragover');
  const libId = +ev.dataTransfer.getData('application/x-cropper-img');
  const i = cellAt(edPoint(ev));
  let ids = libId ? [libId] : await importFiles(ev.dataTransfer.files);
  if (!ids.length) return;
  const b = cur();
  if (!b) { S.sel = ids; renderLibrary(); return; }
  const start = i >= 0 ? i : S.cell;
  ids.slice(0, b.cells.length - start).forEach((id, j) => assignCell(b, start + j, id, true));
  refreshAll();
});

function assignCell(b, i, id, silent) {
  if (!b || !b.cells[i]) return;
  b.cells[i].img = id;
  b.cells[i].crop = mkCrop(); // новый объект — связь с обложкой разрывается
  S.cell = i;
  if (!silent) refreshAll();
}

document.addEventListener('keydown', (ev) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (!$('#previewModal').hidden) {
    if (ev.key === 'ArrowLeft') igGo(-1); else if (ev.key === 'ArrowRight') igGo(1); else if (ev.key === 'Escape') closeModals();
    return;
  }
  if (ev.key === 'Escape') { if (document.body.classList.contains('focus')) toggleFocus(false); return closeModals(); }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'e') { ev.preventDefault(); doExport(); return; }
  if (ev.code === 'Space') { ev.preventDefault(); if (!spaceDown) { spaceDown = true; ed.classList.add('panmode'); } return; }
  if (ev.ctrlKey || ev.metaKey) {
    if (ev.key === '=' || ev.key === '+') { ev.preventDefault(); viewZoomAt(edCenter(), 1.25); }
    else if (ev.key === '-') { ev.preventDefault(); viewZoomAt(edCenter(), 0.8); }
    else if (ev.key === '0') { ev.preventDefault(); viewFit(); }
    return;
  }
  if (ev.key === '0') return viewFit();
  if (ev.code === 'KeyF') return toggleFocus();
  if (!EM || !cellCtx(S.cell)) return;
  const step = (ev.shiftKey ? 40 : 6) * dpr();
  const mv = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[ev.key];
  if (mv) { ev.preventDefault(); panBy(S.cell, mv[0], mv[1]); }
  else if (ev.key === '+' || ev.key === '=') zoomAt(S.cell, cellCenter(S.cell), 1.08);
  else if (ev.key === '-') zoomAt(S.cell, cellCenter(S.cell), 1 / 1.08);
  else return;
  queueEditor(); dirty();
});
document.addEventListener('keyup', (ev) => {
  if (ev.code === 'Space' && spaceDown) { ev.preventDefault(); spaceDown = false; ed.classList.remove('panmode'); }
});
window.addEventListener('blur', () => { spaceDown = false; ed.classList.remove('panmode'); });
document.querySelector('.ed-view').addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-v]');
  if (!a) return;
  ({ in: () => viewZoomAt(edCenter(), 1.25), out: () => viewZoomAt(edCenter(), 0.8), fit: viewFit, full: () => toggleFocus() })[a.dataset.v]();
});
function cellCenter(i) { const r = EM.L.cells[i]; return { x: EM.ox + (r.x + r.w / 2) * EM.k, y: EM.oy + (r.y + r.h / 2) * EM.k }; }

// ---------- библиотека ----------
function renderLibrary() {
  const g = $('#libGrid');
  g.querySelectorAll('.thumb').forEach((n) => n.remove());
  $('#libEmpty').hidden = S.order.length > 0;
  const used = new Set();
  S.blocks.forEach((b) => b.cells.forEach((c) => c.img != null && used.add(c.img)));
  for (const id of S.order) {
    const e = S.images.get(id), si = S.sel.indexOf(id);
    const d = document.createElement('div');
    d.className = 'thumb' + (si >= 0 ? ' sel' : '') + (e.missing ? ' missing' : '');
    d.draggable = true;
    d.title = `${e.name} · ${e.w}×${e.h}\nДвойной клик — вставить в выбранную ячейку`;
    d.innerHTML = `<img src="${e.thumb}" alt=""><span class="badge">${si + 1}</span>${used.has(id) ? '<i class="used"></i>' : ''}<button class="rm" title="Убрать из библиотеки">✕</button>`;
    d.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('rm')) { removeImage(id); return; }
      const k = S.sel.indexOf(id);
      if (k >= 0) S.sel.splice(k, 1); else S.sel.push(id);
      renderLibrary();
    });
    d.addEventListener('dblclick', (ev) => { if (!ev.target.classList.contains('rm') && cur()) { S.sel = S.sel.filter((x) => x !== id); assignCell(cur(), S.cell, id); } });
    d.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('application/x-cropper-img', String(id)); ev.dataTransfer.effectAllowed = 'copy'; });
    g.appendChild(d);
  }
  $('#libCount').textContent = S.order.length ? `· ${S.order.length}` : '';
  $('#selInfo').textContent = S.sel.length
    ? `Выбрано: ${S.sel.length}. Нажми шаблон сверху — фото встанут по номерам.`
    : 'Клик по фото выбирает его. Номера задают порядок для шаблонов.';
  document.querySelectorAll('[data-lib="insert"],[data-lib="none"],[data-lib="send"]').forEach((bt) => { bt.disabled = !S.sel.length; });
}

$('#addBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (ev) => { const ids = await importFiles(ev.target.files); ev.target.value = ''; if (ids.length) { S.sel.push(...ids); renderLibrary(); } });
const libGrid = $('#libGrid');
libGrid.addEventListener('dragover', (ev) => { if (ev.dataTransfer.types.includes('Files')) { ev.preventDefault(); libGrid.classList.add('dragover'); } });
libGrid.addEventListener('dragleave', () => libGrid.classList.remove('dragover'));
libGrid.addEventListener('drop', async (ev) => { ev.preventDefault(); libGrid.classList.remove('dragover'); const ids = await importFiles(ev.dataTransfer.files); S.sel.push(...ids); renderLibrary(); });
window.addEventListener('dragover', (ev) => ev.preventDefault());
window.addEventListener('drop', async (ev) => { ev.preventDefault(); if (ev.dataTransfer.files.length) { await importFiles(ev.dataTransfer.files); } });

document.querySelector('.lib-actions').addEventListener('click', async (ev) => {
  const a = ev.target.dataset.lib;
  if (!a) return;
  if (a === 'all') S.sel = [...S.order];
  if (a === 'none') S.sel = [];
  if (a === 'insert') {
    const b = cur();
    if (!b) return toast('Сначала выбери или создай блок карусели');
    S.sel.slice(0, b.cells.length - S.cell).forEach((id, j) => assignCell(b, S.cell + j, id, true));
    S.sel = [];
    refreshAll();
    return;
  }
  if (a === 'send') return sendSelectedToPc();
  renderLibrary();
});

// ---------- шаблоны ----------
function renderTemplates() {
  $('#templates').innerHTML = TEMPLATES.map((t, i) => `
    <button class="tpl${t.feature ? ' feature' : ''}" data-tpl="${i}" title="${esc(t.sub)}">
      <svg viewBox="0 0 30 30" fill="${t.feature ? '#ff8a3d' : '#8d9097'}">${ICONS[t.icon]}</svg>
      <span><b>${esc(t.name)}</b><small>${esc(t.sub)}</small></span>
    </button>`).join('');
}
$('#templates').addEventListener('click', (ev) => {
  const bt = ev.target.closest('[data-tpl]');
  if (!bt) return;
  const blocks = TEMPLATES[+bt.dataset.tpl].make([...S.sel]);
  S.blocks.push(...blocks);
  S.cur = blocks[0].id; S.cell = 0; S.sel = [];
  refreshAll();
  if (totalSlides() > MAX_SLIDES) toast(`В карусели ${totalSlides()} слайдов — Instagram примет только ${MAX_SLIDES}`);
});

// ---------- панель настроек ----------
const fmt = {
  n: (v) => String(Math.round(v)),
  gap: (v) => `${Math.round((v / 1000) * S.width)} px`,
  pct: (v) => `${Math.round(v)}%`,
  zoom: (v) => `×${(2 ** v).toFixed(2)}`,
};
const rng = (label, key, min, max, step, val, f) =>
  `<label class="row"><span>${label}</span><input type="range" data-k="${key}" data-f="${f}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${fmt[f](val)}</output></label>`;
const clr = (label, key, val) => `<label class="row two"><span>${label}</span><input type="color" data-k="${key}" value="${val}"></label>`;
const chk = (label, key, val) => `<label class="row check"><input type="checkbox" data-k="${key}" ${val ? 'checked' : ''}><span>${label}</span></label>`;
const sel = (label, key, opts, val) => `<label class="row two"><span>${label}</span><select data-k="${key}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
const txt = (label, key, val) => `<label class="row two"><span>${label}</span><input type="text" data-k="${key}" value="${esc(val)}" spellcheck="false"></label>`;

function buildPanel() {
  const p = $('#panel'), b = cur();
  if (!b) {
    p.innerHTML = `<div class="empty-panel"><h3>Настройки блока</h3><p>Здесь появятся настройки выбранного блока карусели.</p>
      <p><b>Кино-карусель</b> — обложка из трёх полос 21:9, затем каждая полоса разворачивается в 3 бесшовных слайда.</p>
      <p><b>Сплит на 2</b> — кадр 3:2 с камеры режется на два бесшовных слайда 4:5.</p>
      <p><b>Полосы + слово</b> — вертикальные полосы из разных фото, по букве на полосу.</p>
      <p class="muted">Ctrl+E — экспорт. Стрелки — сдвиг кадра, +/− — зум.</p></div>`;
    return;
  }
  S.cell = clamp(S.cell, 0, b.cells.length - 1);
  let h = `<h3>${TYPE_NAME[b.type]}</h3><div class="muted">${slidesOf(b)} ${plural(slidesOf(b), 'слайд', 'слайда', 'слайдов')} · ${S.frame}</div>`;
  if (b.type === 'pano') {
    h += `<div class="sec">Нарезка</div>${rng('Слайдов', 'n', 1, 10, 1, b.n, 'n')}
      <div class="quick">${[1, 2, 3, 4, 5].map((n) => `<button data-act="n" data-v="${n}" class="${b.n === n ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="muted small-text">Кадр режется на ${b.n} ${plural(b.n, 'слайд', 'слайда', 'слайдов')} ${S.frame} встык — при листании без швов.</div>
      ${textSection(b)}`;
  } else {
    const word = b.type === 'hstrips' ? 'Полос' : 'Полос';
    h += `<div class="sec">Сетка</div>
      ${rng(word, 'count', 2, b.type === 'hstrips' ? 4 : 8, 1, b.cells.length, 'n')}
      ${b.type === 'hstrips' ? `<div class="muted small-text">Каждая полоса ≈ ${stripRatio(b)}:1${b.cells.length === 3 && S.frame === '4:5' ? ' (кино-формат ~21:9)' : ''}</div>` : ''}
      ${rng('Разделители', 'gap', 0, 30, 1, Math.round(b.gap * 1000), 'gap')}
      ${clr('Цвет линий', 'gapColor', b.gapColor)}
      ${textSection(b)}
      <button data-act="followups" class="accent wide">${b.type === 'hstrips'
        ? `+ Развороты: каждая полоса → ${b.cells.length} ${plural(b.cells.length, 'слайд', 'слайда', 'слайдов')}`
        : '+ Каждое фото отдельным слайдом'}</button>`;
  }
  h += `<div class="sec">Поля</div>${chk('Разрешить уменьшать фото за край', 'margins', b.margins)}${b.margins ? clr('Цвет полей', 'bg', b.bg) : ''}`;

  const c = b.cells[S.cell], e = c && c.img != null && S.images.get(c.img);
  h += `<div class="sec">${b.type === 'pano' ? 'Кадр' : `Ячейка ${S.cell + 1} из ${b.cells.length}`}</div>`;
  if (e) {
    h += `<div class="cellname">${esc(e.name)} <span class="muted">· ${e.w}×${e.h}</span></div>
      ${isLinked(c.crop) ? '<div class="link-note"><span>Кадр связан с обложкой</span><button class="small ghost" data-act="unlink">Отвязать</button></div>' : ''}
      ${rng('Масштаб', 'zoom', b.margins ? -3 : 0, 4, 0.01, Math.log2(c.crop.z), 'zoom')}
      <div class="info" id="resinfo"></div>
      <div class="btn-row"><button class="small" data-act="reset">Заполнить</button><button class="small" data-act="fit">Вписать целиком</button><button class="small ghost" data-act="clear">Убрать фото</button></div>`;
  } else {
    h += '<div class="muted small-text">Перетащи фото из библиотеки в ячейку, дважды кликни по ячейке или выбери фото и нажми «Вставить в ячейку».</div>';
  }
  h += `<div class="sec">Экспорт</div>
    ${txt('Имя файлов', 'prefix', S.prefix)}
    ${sel('Качество JPEG', 'quality', [[85, '85 — легче'], [92, '92 — оптимально'], [97, '97 — максимум'], [100, '100']], S.quality)}`;
  p.innerHTML = h;
  updateResInfo();
}
function textSection(b) {
  const t = b.text;
  return `<div class="sec">Текст</div>
    ${sel('Режим', 't.mode', [['none', 'Без текста'], ['letters', 'По буквам'], ['title', 'Заголовок']], t.mode)}
    ${t.mode === 'none' ? '' : `
    ${txt('Текст', 't.value', t.value)}
    ${sel('Шрифт', 't.font', FONTS.map((f) => [f, f]), t.font)}
    ${sel('Начертание', 't.weight', [['300', 'Light'], ['400', 'Regular'], ['600', 'SemiBold'], ['700', 'Bold']], t.weight)}
    ${rng('Размер', 't.size', 2, 40, 0.5, t.size * 100, 'pct')}
    ${t.mode === 'title' ? rng('Трекинг', 't.tracking', 0, 100, 1, t.tracking * 100, 'pct') : ''}
    ${rng('Высота', 't.y', 5, 95, 1, t.y * 100, 'pct')}
    ${clr('Цвет', 't.color', t.color)}
    ${rng('Непрозр.', 't.opacity', 10, 100, 1, t.opacity * 100, 'pct')}
    ${chk('Мягкая тень', 't.shadow', t.shadow)}`}`;
}
const plural = (n, a, b, c) => { const m = n % 10, mm = n % 100; return m === 1 && mm !== 11 ? a : m >= 2 && m <= 4 && (mm < 12 || mm > 14) ? b : c; };
function stripRatio(b) { const { W, H } = frameSize(S.width); const r = layout(b, W, H).cells[0]; return (r.w / r.h).toFixed(2); }

function updateResInfo() {
  const el = $('#resinfo');
  if (!el || !EM) return;
  const x = cellCtx(S.cell);
  if (!x) { el.textContent = ''; return; }
  const cr = cropRect(x.e, x.c.crop, x.a), up = x.r.w / cr.w;
  el.className = 'info' + (up > 1.05 ? ' warn' : '');
  el.textContent = up > 1.05
    ? `⚠ Апскейл ×${up.toFixed(2)}: из ${Math.round(cr.w)} px исходника растягиваем до ${x.r.w} px`
    : `Из фото берётся ${Math.round(cr.w)}×${Math.round(cr.h)} px → ${x.r.w}×${x.r.h} px`;
}
function syncZoomSlider() {
  const r = $('#panel [data-k="zoom"]'), x = cellCtx(S.cell);
  if (!r || !x) return;
  r.value = Math.log2(x.c.crop.z);
  r.nextElementSibling.textContent = fmt.zoom(+r.value);
}

$('#panel').addEventListener('input', (ev) => applyKey(ev.target, false));
$('#panel').addEventListener('change', (ev) => applyKey(ev.target, true));
function applyKey(el, final) {
  const k = el.dataset.k;
  if (!k) return;
  const b = cur();
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (k === 'prefix') { S.prefix = String(v).replace(/[\\/:*?"<>|]/g, '_').trim() || 'carousel'; store.set('prefix', S.prefix); return; }
  if (k === 'quality') { S.quality = +v; store.set('quality', S.quality); return; }
  if (!b) return;
  if (k.startsWith('t.')) {
    const f = k.slice(2);
    if (['size', 'tracking', 'y', 'opacity'].includes(f)) v = +v / 100;
    b.text[f] = v;
    if (f === 'font' || f === 'weight') loadFont(b.text).then(queueEditor);
    if (f === 'mode' && final) buildPanel();
  } else if (k === 'n') b.n = +v;
  else if (k === 'count') setCount(b, +v);
  else if (k === 'gap') b.gap = +v / 1000;
  else if (k === 'gapColor') b.gapColor = v;
  else if (k === 'bg') b.bg = v;
  else if (k === 'margins') { b.margins = v; buildPanel(); }
  else if (k === 'zoom') { const x = cellCtx(S.cell); if (x) { x.c.crop.z = 2 ** +v; clampCrop(x.e, x.c.crop, x.a, b.margins); } }
  if (el.dataset.f) el.nextElementSibling.textContent = fmt[el.dataset.f](+el.value);
  renderEditor();
  dirty();
  if (final && (k === 'count' || k === 'n')) buildPanel();
}
function setCount(b, n) {
  while (b.cells.length < n) b.cells.push(mkCell(null));
  b.cells.length = n;
  S.cell = Math.min(S.cell, n - 1);
}

$('#panel').addEventListener('click', (ev) => {
  const a = ev.target.dataset.act, b = cur();
  if (!a || !b) return;
  const x = cellCtx(S.cell);
  if (a === 'n') { b.n = +ev.target.dataset.v; }
  if (a === 'followups') {
    const nb = followupsOf(b);
    if (!nb.length) return toast('Сначала вставь фото в полосы');
    S.blocks.splice(S.blocks.indexOf(b) + 1, 0, ...nb);
    toast(`Добавлено ${nb.length} ${plural(nb.length, 'блок', 'блока', 'блоков')} разворотов`);
  }
  if (a === 'unlink' && x) x.c.crop = { ...x.c.crop };
  if (a === 'reset' && x) x.c.crop = Object.assign(x.c.crop, mkCrop());
  if (a === 'fit' && x) { b.margins = true; Object.assign(x.c.crop, { cx: 0.5, cy: 0.5, z: fitWholeZoom(x.e, x.a) }); }
  if (a === 'clear' && b.cells[S.cell]) { b.cells[S.cell].img = null; b.cells[S.cell].crop = mkCrop(); }
  refreshAll();
});

// ---------- таймлайн ----------
let tlTimer = 0;
function dirty() { clearTimeout(tlTimer); tlTimer = setTimeout(() => { renderTimeline(); renderLibrary(); }, 140); scheduleSave(); }

function renderTimeline() {
  const tl = $('#timeline');
  tl.innerHTML = '';
  if (!S.blocks.length) tl.innerHTML = '<div class="tl-empty">Карусель пуста — выбери шаблон сверху.</div>';
  const th = isPhoneLayout() ? 84 : 118, d = dpr();
  const { W, H } = frameSize(S.width);
  let no = 1;
  S.blocks.forEach((b, bi) => {
    const n = slidesOf(b);
    const item = document.createElement('div');
    item.className = 'tl-item' + (b.id === S.cur ? ' sel' : '');
    const label = n > 1 ? `${no}–${no + n - 1}` : `${no}`;
    no += n;
    item.innerHTML = `<div class="tl-head"><span class="tl-num" style="${no - 1 > MAX_SLIDES ? 'color:#ff5d5d' : ''}">${label}</span><span class="tl-type">${b.type === 'pano' ? (n === 1 ? 'кадр' : 'сплит') : 'коллаж'}</span>
      <span class="tl-actions"><button data-a="left" title="Сдвинуть влево">‹</button><button data-a="right" title="Сдвинуть вправо">›</button><button data-a="dup" title="Дублировать">⧉</button><button data-a="del" title="Удалить">✕</button></span></div>`;
    const L = layout(b, W, H), k = (th * d) / L.h;
    const cv = makeCanvas(Math.round(L.w * k), Math.round(th * d));
    cv.style.width = cv.width / d + 'px'; cv.style.height = th + 'px';
    const x = cv.getContext('2d');
    paint(x, b, L, 0, 0, k, true);
    if (b.type === 'pano') { x.fillStyle = 'rgba(14,15,17,.9)'; for (let i = 1; i < b.n; i++) x.fillRect(Math.round(i * W * k) - d, 0, 2 * d, cv.height); }
    item.appendChild(cv);
    item.addEventListener('click', (ev) => {
      const act = ev.target.dataset.a;
      if (act === 'left' && bi > 0) [S.blocks[bi - 1], S.blocks[bi]] = [S.blocks[bi], S.blocks[bi - 1]];
      else if (act === 'right' && bi < S.blocks.length - 1) [S.blocks[bi + 1], S.blocks[bi]] = [S.blocks[bi], S.blocks[bi + 1]];
      else if (act === 'dup') {
        const c = JSON.parse(JSON.stringify(b)); c.id = uid++;
        S.blocks.splice(bi + 1, 0, c); S.cur = c.id;
      } else if (act === 'del') {
        S.blocks.splice(bi, 1);
        if (S.cur === b.id) S.cur = (S.blocks[bi] || S.blocks[bi - 1] || {}).id ?? null;
      } else { if (S.cur === b.id) return; S.cur = b.id; S.cell = 0; }
      refreshAll();
    });
    tl.appendChild(item);
  });
  const t = totalSlides();
  $('#slideCount').textContent = t ? `· ${t} ${plural(t, 'слайд', 'слайда', 'слайдов')} из ${MAX_SLIDES}` : '';
  $('#slideCount').style.color = t > MAX_SLIDES ? '#ff5d5d' : '';
  const sel = tl.querySelector('.tl-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function refreshAll() {
  renderProjects();
  renderLibrary();
  buildPanel();
  renderEditor();
  renderTimeline();
  scheduleSave();
}

// ---------- шрифты ----------
const loadFont = (t) => (document.fonts ? document.fonts.load(`${t.weight} 64px "${t.font}"`).catch(() => {}) : Promise.resolve());
async function ensureFonts() {
  await Promise.all(S.blocks.filter((b) => b.text.mode !== 'none').map((b) => loadFont(b.text)));
}
if (document.fonts) document.fonts.addEventListener('loadingdone', () => { queueEditor(); dirty(); });

// ---------- рендер слайдов ----------
const toBlob = (c, q) => new Promise((res) => c.toBlob(res, 'image/jpeg', q));

// Каждый слайд рисуется отдельно со сдвигом: геометрия общая, поэтому швов нет, а память не раздувается.
async function renderSlides(W, onStep) {
  await ensureFonts();
  await Promise.all(usedImages(S.blocks).map(ensureLoaded));
  const { H } = frameSize(W);
  const out = [], total = totalSlides();
  let idx = 1;
  for (const b of S.blocks) {
    const L = layout(b, W, H);
    for (let j = 0; j < slidesOf(b); j++) {
      const c = makeCanvas(W, H), x = c.getContext('2d');
      paint(x, b, L, -j * W, 0, 1, false);
      out.push({ name: `${S.prefix}_${String(idx).padStart(2, '0')}.jpg`, canvas: c });
      if (onStep) onStep(idx, total);
      idx++;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return out;
}

function checkBeforeExport() {
  if (!S.blocks.length) { toast('Карусель пуста'); return false; }
  const empty = S.blocks.reduce((n, b) => n + b.cells.filter((c) => c.img == null).length, 0);
  if (empty && !confirm(`Есть пустые ячейки (${empty}) — они будут залиты цветом фона. Продолжить?`)) return false;
  if (totalSlides() > MAX_SLIDES && !confirm(`Слайдов ${totalSlides()}, а Instagram принимает до ${MAX_SLIDES}. Всё равно экспортировать?`)) return false;
  return true;
}

async function doExport() {
  if (!checkBeforeExport()) return;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  if (NATIVE) {
    const folder = await NATIVE.pickFolder();
    if (!folder) return;
    try {
      busy('Рендер слайдов…');
      const slides = await renderSlides(S.width, (i, t) => busy(`Рендер слайдов… ${i}/${t}`));
      const files = [];
      for (const s of slides) { files.push({ name: s.name, data: await (await toBlob(s.canvas, S.quality / 100)).arrayBuffer() }); s.canvas.width = 0; }
      const dir = await NATIVE.saveFiles(folder, `${S.prefix}_${stamp}`, files);
      busy(false);
      toast(`Сохранено ${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')}`, 'Открыть папку', () => NATIVE.openPath(dir));
    } catch (e) { busy(false); toast('Ошибка экспорта: ' + e.message); }
    return;
  }
  // Телефон / браузер: показываем готовые картинки — их можно сохранить в галерею или поделиться в Instagram
  busy('Рендер слайдов…');
  const slides = await renderSlides(S.width, (i, t) => busy(`Рендер слайдов… ${i}/${t}`));
  const files = [];
  for (const s of slides) { const blob = await toBlob(s.canvas, S.quality / 100); s.canvas.width = 0; files.push({ name: s.name, blob, url: URL.createObjectURL(blob) }); }
  busy(false);
  showResults(files, stamp);
}

let resultFiles = [];
function showResults(files, stamp) {
  resultFiles.forEach((f) => URL.revokeObjectURL(f.url));
  resultFiles = files;
  $('#resultTitle').textContent = `Готово: ${files.length} ${plural(files.length, 'слайд', 'слайда', 'слайдов')}`;
  $('#resultGrid').innerHTML = files.map((f) => `<figure><img src="${f.url}" alt="${esc(f.name)}"><figcaption>${esc(f.name)}</figcaption></figure>`).join('');
  const shareFiles = files.map((f) => new File([f.blob], f.name, { type: 'image/jpeg' }));
  const canShare = !!(navigator.canShare && navigator.canShare({ files: shareFiles }));
  $('#shareBtn').hidden = !canShare;
  $('#shareBtn').onclick = () => navigator.share({ files: shareFiles }).catch(() => {});
  $('#dlAllBtn').onclick = async () => {
    for (const f of files) { const a = document.createElement('a'); a.href = f.url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); await new Promise((r) => setTimeout(r, 350)); }
  };
  $('#toPcBtn').hidden = !HAS_API || !!NATIVE;
  $('#toPcBtn').onclick = async () => {
    try {
      busy('Отправка на ПК…');
      for (let i = 0; i < files.length; i++) {
        busy(`Отправка на ПК… ${i + 1}/${files.length}`);
        const r = await api(`/api/export?folder=${encodeURIComponent(`${S.prefix}_${stamp}`)}&name=${encodeURIComponent(files[i].name)}`, { method: 'POST', body: files[i].blob });
        if (!r.ok) throw new Error(r.status);
      }
      busy(false);
      toast('Сохранено на ПК: Изображения → Cropper → Экспорт');
    } catch (e) { busy(false); toast('Не получилось отправить на ПК: ' + e.message); }
  };
  openModal('resultModal');
}

// ---------- предпросмотр как в Instagram ----------
let igIndex = 0, igCount = 0;
async function openPreview() {
  if (!S.blocks.length) return toast('Карусель пуста');
  busy('Готовлю превью…');
  const slides = await renderSlides(720);
  busy(false);
  const tr = $('#igTrack');
  tr.innerHTML = '';
  slides.forEach((s) => tr.appendChild(s.canvas));
  igCount = slides.length; igIndex = 0;
  $('#igDots').innerHTML = slides.map(() => '<i></i>').join('');
  openModal('previewModal');
  igGo(0);
}
function igGo(d) {
  igIndex = clamp(igIndex + d, 0, igCount - 1);
  $('#igTrack').style.transform = `translateX(${-igIndex * 100}%)`;
  $('#igCounter').textContent = `${igIndex + 1}/${igCount}`;
  [...$('#igDots').children].forEach((n, i) => n.classList.toggle('on', i === igIndex));
  $('#igPrev').hidden = igIndex === 0;
  $('#igNext').hidden = igIndex === igCount - 1;
}
$('#igPrev').addEventListener('click', () => igGo(-1));
$('#igNext').addEventListener('click', () => igGo(1));
{
  let sx = null;
  const f = $('#igFrame');
  f.addEventListener('pointerdown', (e) => { if (!e.target.closest('.ig-nav')) sx = e.clientX; });
  f.addEventListener('pointerup', (e) => { if (sx != null && Math.abs(e.clientX - sx) > 40) igGo(e.clientX < sx ? 1 : -1); sx = null; });
}

// ---------- телефон ↔ ПК ----------
async function openPhoneModal() {
  const info = await NATIVE.info();
  if (!info.urls.length) { toast('Не найдена Wi-Fi/локальная сеть на этом компьютере'); return; }
  $('#qrImg').src = info.qr;
  $('#phoneUrl').textContent = info.urls[0];
  openModal('phoneModal');
}

async function sendSelectedToPc() {
  if (!HAS_API) return;
  const ids = [...S.sel];
  try {
    for (let i = 0; i < ids.length; i++) {
      const e = S.images.get(ids[i]);
      busy(`Отправка на ПК… ${i + 1}/${ids.length}`);
      const body = e.file || (e.src && (await Catalog.get(e.src)));
      if (!body) throw new Error(`нет файла ${e.name}`);
      const r = await api(`/api/upload?name=${encodeURIComponent(e.name)}`, { method: 'POST', body });
      if (!r.ok) throw new Error(r.status);
    }
    busy(false);
    toast(`Отправлено ${ids.length} фото во «Входящие» на ПК`);
  } catch (e) { busy(false); toast('Не получилось отправить: ' + e.message); }
}

async function pollInbox() {
  try {
    const r = await api('/api/inbox');
    if (!r.ok) return;
    S.inboxNew = await r.json();
    const bt = $('#inboxBtn');
    bt.hidden = !S.inboxNew.length;
    bt.textContent = `📥 С телефона: ${S.inboxNew.length} ${plural(S.inboxNew.length, 'новое фото', 'новых фото', 'новых фото')} — забрать`;
  } catch {}
}
$('#inboxBtn').addEventListener('click', async () => {
  const list = [...S.inboxNew];
  const files = [];
  busy('Забираю фото с телефона…');
  for (const f of list) {
    const r = await api(`/api/inbox/file?name=${encodeURIComponent(f.name)}`);
    if (r.ok) files.push(new File([await r.blob()], f.name, { type: r.headers.get('Content-Type') || 'image/jpeg' }));
  }
  busy(false);
  const ids = await importFiles(files);
  await Promise.all(list.map((f) => api(`/api/inbox/done?name=${encodeURIComponent(f.name)}`, { method: 'POST' })));
  S.sel.push(...ids);
  renderLibrary();
  pollInbox();
});

// ---------- модалки, тосты, занятость ----------
function openModal(id) { $('#' + id).hidden = false; }
function closeModals() { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); }
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (ev) => { if (ev.target === m || ev.target.hasAttribute('data-close')) m.hidden = true; }));

let toastTimer = 0;
function toast(text, actionLabel, action) {
  $('#toastText').textContent = text;
  const bt = $('#toastBtn');
  bt.hidden = !actionLabel;
  if (actionLabel) { bt.textContent = actionLabel; bt.onclick = () => { action(); $('#toast').hidden = true; }; }
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, actionLabel ? 9000 : 4000);
}
function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busyText').textContent = text;
}

// ---------- шапка, вкладки, старт ----------
function fillWidths() {
  $('#widthSel').innerHTML = WIDTHS.map((w) => { const { H } = frameSize(w); return `<option value="${w}" ${w === S.width ? 'selected' : ''}>${w}×${H}</option>`; }).join('');
}
$('#frameSel').value = S.frame;
$('#frameSel').addEventListener('change', (ev) => { S.frame = ev.target.value; store.set('frame', S.frame); fillWidths(); refreshAll(); });
$('#widthSel').addEventListener('change', (ev) => { S.width = +ev.target.value; store.set('width', S.width); refreshAll(); });
$('#exportBtn').addEventListener('click', doExport);
$('#previewBtn').addEventListener('click', openPreview);
$('#phoneBtn').addEventListener('click', openPhoneModal);
$('#ovGrid').checked = !!S.overlay.grid;
$('#ovThirds').checked = !!S.overlay.thirds;
$('#ovGrid').addEventListener('change', (ev) => { S.overlay.grid = ev.target.checked; store.set('overlay', S.overlay); renderEditor(); });
$('#ovThirds').addEventListener('change', (ev) => { S.overlay.thirds = ev.target.checked; store.set('overlay', S.overlay); renderEditor(); });

$('#mtabs').addEventListener('click', (ev) => {
  const t = ev.target.dataset.tab;
  if (!t) return;
  document.querySelectorAll('#mtabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $('#libPane').classList.toggle('show', t === 'lib');
  $('#panel').classList.toggle('show', t === 'panel');
});
$('#libPane').classList.add('show');

if (NATIVE) {
  $('#phoneBtn').hidden = false;
  if (HAS_API) { pollInbox(); setInterval(pollInbox, 4000); }
} else if (HAS_API) $('[data-lib="send"]').hidden = false;

// ---------- карусели: выбор, создание, переименование, удаление ----------
$('#projSel').addEventListener('change', (ev) => switchProject(+ev.target.value));
$('#projNew').addEventListener('click', () => { switchProject(newProject().id); toast('Новая карусель создана'); });
$('#projRen').addEventListener('click', () => {
  const p = S.projects.find((x) => x.id === S.project);
  $('#renameInput').value = p.name;
  openModal('renameModal');
  setTimeout(() => { $('#renameInput').focus(); $('#renameInput').select(); }, 30);
});
function applyRename() {
  const p = S.projects.find((x) => x.id === S.project);
  p.name = $('#renameInput').value.trim() || p.name;
  closeModals();
  refreshAll();
}
$('#renameOk').addEventListener('click', applyRename);
$('#renameInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyRename(); });
$('#projDel').addEventListener('click', () => {
  const p = S.projects.find((x) => x.id === S.project);
  if (!confirm(`Удалить карусель «${p.name}»? Фото останутся в каталоге.`)) return;
  S.projects = S.projects.filter((x) => x !== p);
  if (!S.projects.length) newProject();
  S.project = null;
  switchProject(S.projects[0].id);
});

// ---------- настройки ----------
function buildSettings() {
  const zoom = S.zoom || 1.15;
  $('#settingsBody').innerHTML = NATIVE ? `
    <div class="sec">Каталог</div>
    <p class="small-text">Фото и все карусели сохраняются сюда автоматически и остаются после закрытия — пока ты сам их не уберёшь.</p>
    <div class="url-box">${esc(S.catalogDir || '')}</div>
    <div class="btn-row"><button class="small" data-set="open">Открыть папку</button><button class="small ghost" data-set="switch">Сменить каталог…</button></div>
    <div class="sec">Импорт фото</div>
    <label class="radio"><input type="radio" name="imode" value="copy" ${S.importMode === 'copy' ? 'checked' : ''}><span><b>Копировать в каталог</b><br><span class="muted">Надёжно: фото не пропадут, даже если отключить флешку или удалить исходник.</span></span></label>
    <label class="radio"><input type="radio" name="imode" value="link" ${S.importMode === 'link' ? 'checked' : ''}><span><b>Только ссылка на файл</b><br><span class="muted">Экономит место. Если исходник переместить или удалить — фото пропадёт из Cropper.</span></span></label>
    <div class="sec">Интерфейс</div>
    <label class="row two"><span>Масштаб</span><select data-set="zoom">${[1, 1.1, 1.15, 1.25, 1.35, 1.5].map((z) => `<option value="${z}" ${Math.abs(z - zoom) < 0.001 ? 'selected' : ''}>${Math.round(z * 100)}%</option>`).join('')}</select></label>
    <div class="sec">Обновления и версии</div>
    <div id="updInfo" class="small-text"></div>
    <label class="row check"><input type="checkbox" data-set="auto"><span>Обновлять автоматически</span></label>
    <div class="btn-row"><button class="small" data-set="check">Проверить сейчас</button></div>
    <p class="muted small-text">Если новая версия что-то сломала — установи предыдущую из списка. Каталог и карусели при этом сохранятся, автообновление выключится.</p>
    <div id="relList" class="rel-list"><span class="muted small-text">Загружаю список версий…</span></div>`
    : `
    <div class="sec">Хранение</div>
    <p class="small-text">Фото и карусели сохраняются в памяти браузера на этом устройстве и остаются после закрытия. В другом браузере или на другом устройстве их не будет.</p>
    <button class="small ghost" data-set="wipe">Очистить всё на этом устройстве</button>`;
}
$('#settingsBtn').addEventListener('click', () => {
  buildSettings();
  openModal('settingsModal');
  if (NATIVE) { NATIVE.updateStatus().then(renderUpdate); loadReleases(); }
});
$('#settingsBody').addEventListener('change', (ev) => {
  if (ev.target.name === 'imode') { S.importMode = ev.target.value; store.set('importMode', S.importMode); }
  if (ev.target.dataset.set === 'zoom') { S.zoom = +ev.target.value; NATIVE.setZoom(S.zoom); }
  if (ev.target.dataset.set === 'auto') { S.update.auto = ev.target.checked; NATIVE.setAutoUpdate(ev.target.checked); }
});
$('#settingsBody').addEventListener('click', async (ev) => {
  const a = ev.target.dataset.set;
  if (a === 'check') { NATIVE.updateCheck(); toast('Проверяю обновления…'); }
  if (a === 'install') {
    const rel = S.releases[+ev.target.dataset.i];
    const older = rel.version.localeCompare(S.update.current, undefined, { numeric: true }) < 0;
    if (!confirm(`Установить версию ${rel.version}?${older ? ' Это откат на более старую версию — автообновление выключится.' : ''} Приложение перезапустится.`)) return;
    saveNow();
    busy(`Скачиваю версию ${rel.version}…`);
    try { await NATIVE.installRelease(rel); } catch (e) { busy(false); toast('Не получилось: ' + e.message); }
  }
  if (a === 'open') NATIVE.openPath(S.catalogDir);
  if (a === 'switch') {
    saveNow();
    const dir = await NATIVE.catalogSwitch();
    if (!dir) return;
    catalogReady = false; // не записывать текущее состояние в новый каталог
    location.reload();
  }
  if (a === 'wipe' && confirm('Удалить все фото и карусели из памяти этого браузера?')) {
    catalogReady = false;
    indexedDB.deleteDatabase('cropper');
    setTimeout(() => location.reload(), 300);
  }
});

// ---------- обновления ----------
S.update = { state: 'idle' };
S.releases = [];
function renderUpdate(u) {
  Object.assign(S.update, u);
  u = S.update;
  const bt = $('#updateBtn');
  bt.hidden = u.state !== 'ready';
  if (u.state === 'ready') bt.textContent = `⬆ Версия ${u.version} готова — перезапустить`;
  const info = $('#updInfo');
  if (info) {
    const st = { checking: 'проверяю…', downloading: `скачиваю ${u.version || ''} — ${u.progress || 0}%`, ready: `версия ${u.version} скачана, установится при перезапуске`, latest: 'это последняя версия', error: `ошибка проверки: ${u.error || ''}` }[u.state];
    info.innerHTML = `Сейчас установлена <b>${esc(u.current || '?')}</b>${st ? ' · ' + esc(st) : ''}${u.packaged === false ? ' · (режим разработки — обновления отключены)' : ''}`;
    const auto = $('#settingsBody [data-set="auto"]');
    if (auto) auto.checked = u.auto !== false;
  }
}
async function loadReleases() {
  const box = $('#relList');
  try {
    S.releases = await NATIVE.releases();
    if (!$('#relList')) return;
    box.innerHTML = S.releases.length ? S.releases.map((r, i) => `
      <div class="rel ${r.version === S.update.current ? 'current' : ''}">
        <div><b>${esc(r.version)}</b> <span class="muted">· ${new Date(r.date).toLocaleDateString('ru-RU')}</span>${r.notes ? `<div class="muted rel-notes">${esc(r.notes)}</div>` : ''}</div>
        ${r.version === S.update.current ? '<span class="muted small-text">установлена</span>' : `<button class="small ghost" data-set="install" data-i="${i}">Установить</button>`}
      </div>`).join('') : '<span class="muted small-text">Опубликованных версий пока нет.</span>';
  } catch (e) { box.innerHTML = `<span class="muted small-text">Список версий недоступен: ${esc(e.message)}</span>`; }
}
if (NATIVE && NATIVE.onUpdate) {
  NATIVE.onUpdate(renderUpdate);
  NATIVE.updateStatus().then(renderUpdate);
  NATIVE.onRollbackProgress((p) => busy(`Скачиваю версию… ${p}%`));
  $('#updateBtn').addEventListener('click', () => { saveNow(); NATIVE.updateInstall(); });
}

// Офлайн-режим только для онлайн-версии (https). В окне приложения кэш не нужен — там всегда свежие файлы.
if (location.protocol === 'https:' && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

window.addEventListener('beforeunload', saveNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });

async function init() {
  fillWidths();
  renderTemplates();
  new ResizeObserver(sizeEditor).observe(edwrap);
  window.addEventListener('resize', () => dirty());
  let ok = true;
  try {
    const r = await Catalog.load();
    S.catalogDir = r.dir; S.zoom = r.zoom;
    if (r.data) restore(r.data);
  } catch (e) {
    ok = false; // не перезаписываем каталог, который не смогли прочитать
    toast('Каталог не открылся, изменения не сохраняются: ' + e.message);
  }
  if (!S.projects.length) switchProject(newProject().id, true);
  catalogReady = ok;
  refreshAll();
  if (!NATIVE && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
init();
