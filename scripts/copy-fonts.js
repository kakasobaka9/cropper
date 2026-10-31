// Копирует нужные woff2 из @fontsource в app/fonts и генерирует app/fonts/fonts.css,
// чтобы шрифты работали офлайн и на телефоне в локальной сети.
const fs = require('fs');
const path = require('path');

const FONTS = [
  { pkg: 'cormorant-garamond', family: 'Cormorant Garamond', weights: [300, 400, 600, 700] },
  { pkg: 'bodoni-moda', family: 'Bodoni Moda', weights: [400, 600, 700] },
  { pkg: 'playfair-display', family: 'Playfair Display', weights: [400, 600, 700] },
  { pkg: 'bebas-neue', family: 'Bebas Neue', weights: [400] },
  { pkg: 'inter', family: 'Inter', weights: [300, 400, 500, 600, 700] },
];
const SUBSETS = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
};

const root = path.join(__dirname, '..');
const out = path.join(root, 'app', 'fonts');
fs.mkdirSync(out, { recursive: true });
let css = '';
for (const f of FONTS) {
  for (const w of f.weights) {
    for (const [subset, range] of Object.entries(SUBSETS)) {
      const file = `${f.pkg}-${subset}-${w}-normal.woff2`;
      const src = path.join(root, 'node_modules', '@fontsource', f.pkg, 'files', file);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(out, file));
      css += `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${w};font-display:swap;src:url(${file}) format('woff2');unicode-range:${range}}\n`;
    }
  }
}
fs.writeFileSync(path.join(out, 'fonts.css'), css);
console.log('fonts copied');
