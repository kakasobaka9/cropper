// Рисует иконку (тёмный скруглённый квадрат с тремя «кино»-полосами) и пишет PNG без зависимостей.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function render(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.22, m = size * 0.16, gap = size * 0.035;
  const stripH = (size - 2 * m - 2 * gap) / 3;
  const top = [[255, 170, 80], [240, 96, 54], [178, 46, 52]];
  const bot = [[226, 112, 40], [170, 52, 40], [96, 24, 40]];
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // скруглённый квадрат со сглаживанием
      const dx = Math.max(r - x - 0.5, 0, x + 0.5 - (size - r)), dy = Math.max(r - y - 0.5, 0, y + 0.5 - (size - r));
      const a = Math.max(0, Math.min(1, r - Math.hypot(dx, dy) + 0.5));
      let col = [20, 21, 25];
      const iy = y - m;
      if (x >= m && x < size - m && iy >= 0) {
        const i = Math.floor(iy / (stripH + gap));
        const local = iy - i * (stripH + gap);
        if (i < 3 && local < stripH) {
          const t = local / stripH, u = (x - m) / (size - 2 * m);
          col = top[i].map((c, k) => Math.round((c * (1 - t) + bot[i][k] * t) * (0.85 + 0.15 * (1 - u))));
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.png'), render(512));
fs.writeFileSync(path.join(root, 'app', 'icon-512.png'), render(512));
fs.writeFileSync(path.join(root, 'app', 'icon-192.png'), render(192));
console.log('icons written');
