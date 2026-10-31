// Локальный HTTP-сервер: отдаёт интерфейс (и окну приложения, и телефону в Wi-Fi)
// и принимает фото с телефона во «Входящие» / готовые слайды в «Экспорт».
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic',
};
const MAX_BODY = 300 * 1024 * 1024;

const safeName = (s) => path.basename(String(s || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';

function uniquePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base}-${i++}${ext}`);
  return p;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Tailscale|ZeroTier|Radmin|Hamachi|VPN/i.test(name)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

function createServer({ appDir, inboxDir, exportDir, token }) {
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  async function handleApi(req, res, url) {
    const key = url.searchParams.get('k') || req.headers['x-cropper-key'];
    if (key !== token) return send(res, 403, { error: 'bad key' });
    const route = url.pathname;

    if (route === '/api/info') return send(res, 200, { ok: true });

    if (route === '/api/upload' && req.method === 'POST') {
      fs.mkdirSync(inboxDir, { recursive: true });
      const p = uniquePath(inboxDir, safeName(url.searchParams.get('name')));
      fs.writeFileSync(p, await readBody(req));
      return send(res, 200, { ok: true, name: path.basename(p) });
    }

    if (route === '/api/inbox') {
      fs.mkdirSync(inboxDir, { recursive: true });
      const files = fs.readdirSync(inboxDir, { withFileTypes: true })
        .filter((d) => d.isFile() && /\.(jpe?g|png|webp|avif|heic|heif)$/i.test(d.name))
        .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(inboxDir, d.name)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
      return send(res, 200, files);
    }

    if (route === '/api/inbox/file') {
      const p = path.join(inboxDir, safeName(url.searchParams.get('name')));
      if (!fs.existsSync(p)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(p), MIME[path.extname(p).toLowerCase()] || 'application/octet-stream');
    }

    if (route === '/api/inbox/done' && req.method === 'POST') {
      // Импортированное убираем в подпапку, чтобы не показывать повторно
      const name = safeName(url.searchParams.get('name'));
      const done = path.join(inboxDir, 'Импортированы');
      fs.mkdirSync(done, { recursive: true });
      const p = path.join(inboxDir, name);
      if (fs.existsSync(p)) fs.renameSync(p, uniquePath(done, name));
      return send(res, 200, { ok: true });
    }

    if (route === '/api/export' && req.method === 'POST') {
      const dir = path.join(exportDir, safeName(url.searchParams.get('folder') || 'phone'));
      fs.mkdirSync(dir, { recursive: true });
      const p = uniquePath(dir, safeName(url.searchParams.get('name')));
      fs.writeFileSync(p, await readBody(req));
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'unknown' });
  }

  function handleStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const p = path.normalize(path.join(appDir, rel));
    if (!p.startsWith(appDir)) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(p, (err, data) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else handleStatic(req, res, url);
    } catch (e) {
      send(res, 500, { error: String(e.message || e) });
    }
  });

  function listen(port, tries = 20) {
    return new Promise((resolve, reject) => {
      const attempt = (p, left) => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && left > 0) attempt(p + 1, left - 1);
          else reject(err);
        });
        server.listen(p, '0.0.0.0', () => resolve(p));
      };
      attempt(port, tries);
    });
  }

  return { listen, server };
}

module.exports = { createServer, lanAddresses };
