const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { createServer, lanAddresses } = require('./server');

// Для тестов: все данные в отдельной папке, а не в «Изображениях» пользователя
if (process.env.CROPPER_HOME) {
  app.setPath('userData', path.join(process.env.CROPPER_HOME, 'userData'));
  app.setPath('pictures', process.env.CROPPER_HOME);
}

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let port = 0;
let config = {};

const configPath = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { config = {}; }
  // Ключ постоянный, чтобы ярлык на телефоне продолжал работать после перезапуска
  if (!config.token) config.token = crypto.randomBytes(9).toString('base64url');
  saveConfig();
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

const baseDir = () => path.join(app.getPath('pictures'), 'Cropper');
const inboxDir = () => path.join(baseDir(), 'Входящие');
const exportDir = () => path.join(baseDir(), 'Экспорт');
const catalogDir = () => config.catalogDir || path.join(baseDir(), 'Каталог');
const catalogFile = () => path.join(catalogDir(), 'catalog.json');
const DEFAULT_ZOOM = 1.15;

function createWindow() {
  const b = config.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1640, height: b.height || 1000, x: b.x, y: b.y, minWidth: 1000, minHeight: 660,
    backgroundColor: '#0e0f11', title: 'Cropper', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'app', 'icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  if (config.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(config.zoom || DEFAULT_ZOOM));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', () => {
    config.maximized = win.isMaximized();
    if (!config.maximized) config.bounds = win.getBounds();
    saveConfig();
  });
  win.loadURL(`http://127.0.0.1:${port}/?k=${encodeURIComponent(config.token)}`);
}

// ---------- каталог: фото и карусели живут на диске между запусками ----------
let backedUp = false;
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Раз за запуск сохраняем предыдущую версию каталога — страховка от порчи
  if (!backedUp && fs.existsSync(file)) { fs.copyFileSync(file, file.replace(/\.json$/, '.bak.json')); backedUp = true; }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const insideCatalog = (p) => path.resolve(p).startsWith(path.resolve(catalogDir()) + path.sep);

ipcMain.handle('catalog-load', () => {
  let data = null;
  try { data = fs.readFileSync(catalogFile(), 'utf8'); } catch {}
  return { dir: catalogDir(), data, zoom: config.zoom || DEFAULT_ZOOM };
});
ipcMain.handle('catalog-save', (_e, data) => { writeAtomic(catalogFile(), data); return true; });
ipcMain.on('catalog-save-sync', (e, data) => {
  try { writeAtomic(catalogFile(), data); e.returnValue = true; } catch { e.returnValue = false; }
});
ipcMain.handle('catalog-write', (_e, name, data) => {
  const dir = path.join(catalogDir(), 'Фото');
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(name).replace(/[\\/:*?"<>|]/g, '_');
  const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
  let p = path.join(dir, safe), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base}-${i++}${ext}`);
  fs.writeFileSync(p, Buffer.from(data));
  return p;
});
ipcMain.handle('read-file', async (_e, p) => {
  try { return await fs.promises.readFile(p); } catch { return null; }
});
// Удаляем только собственные копии каталога, и только в корзину
ipcMain.handle('trash', async (_e, p) => {
  if (!insideCatalog(p) || !fs.existsSync(p)) return false;
  await shell.trashItem(p);
  return true;
});
ipcMain.handle('catalog-switch', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Папка каталога Cropper', defaultPath: catalogDir(), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  config.catalogDir = r.filePaths[0];
  saveConfig();
  backedUp = false;
  return config.catalogDir;
});
ipcMain.handle('set-zoom', (_e, f) => {
  config.zoom = f;
  saveConfig();
  win.webContents.setZoomFactor(f);
});

ipcMain.handle('info', async () => {
  const urls = lanAddresses().map((ip) => `http://${ip}:${port}/?k=${encodeURIComponent(config.token)}`);
  const qr = urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 360, color: { dark: '#000000', light: '#ffffff' } }) : null;
  return { urls, qr, inboxDir: inboxDir(), exportDir: exportDir() };
});

ipcMain.handle('pick-folder', async () => {
  const defaultPath = config.lastExportDir && fs.existsSync(config.lastExportDir) ? config.lastExportDir : exportDir();
  fs.mkdirSync(exportDir(), { recursive: true });
  const r = await dialog.showOpenDialog(win, {
    title: 'Куда сохранить карусель', defaultPath, properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  config.lastExportDir = r.filePaths[0];
  saveConfig();
  return r.filePaths[0];
});

ipcMain.handle('save-files', async (_e, folder, subfolder, files) => {
  const dir = subfolder ? path.join(folder, subfolder.replace(/[\\/:*?"<>|]/g, '_')) : folder;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, path.basename(f.name)), Buffer.from(f.data));
  return dir;
});

ipcMain.handle('open-path', (_e, p) => shell.openPath(p));

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  loadConfig();
  fs.mkdirSync(inboxDir(), { recursive: true });
  const srv = createServer({ appDir: path.join(__dirname, 'app'), inboxDir: inboxDir(), exportDir: exportDir(), token: config.token });
  port = await srv.listen(config.port || 47800);
  if (config.port !== port) { config.port = port; saveConfig(); }
  createWindow();
});

app.on('window-all-closed', () => app.quit());
