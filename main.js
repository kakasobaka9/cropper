const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { createServer, lanAddresses } = require('./server');

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

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 980, minHeight: 640,
    backgroundColor: '#0e0f11', title: 'Cropper', autoHideMenuBar: true,
    icon: path.join(__dirname, 'app', 'icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${port}/?k=${encodeURIComponent(config.token)}`);
}

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
