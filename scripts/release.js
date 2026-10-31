// Выпуск новой версии одной командой: npm run release -- "что нового"
// Тег vX.Y.Z → сборка → публикация в GitHub Releases (оттуда берёт обновления апдейтер) → описание релиза.
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
const out = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
const GH = fs.existsSync('C:/Program Files/GitHub CLI/gh.exe') ? 'C:/Program Files/GitHub CLI/gh.exe' : 'gh';

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;
const notes = process.argv.slice(2).join(' ').trim();

if (out('git status --porcelain')) {
  console.error('Есть незакоммиченные изменения — сначала закоммить их.');
  process.exit(1);
}
if (out(`git ls-remote --tags origin ${tag}`)) {
  console.error(`Версия ${tag} уже опубликована — подними version в package.json.`);
  process.exit(1);
}

run('git push origin HEAD');
if (!out(`git tag --list ${tag}`)) run(`git tag ${tag}`);
// GitHub не создаёт опубликованный релиз без существующего тега
run(`git push origin ${tag}`);

// Релиз создаём сами заранее: electron-builder шлёт два параллельных запроса на создание
// и может завести два релиза с одним тегом. В существующий он просто догружает файлы.
execFileSync(GH, ['release', 'create', tag, '--title', version, '--notes', notes || `Cropper ${version}`, '--verify-tag'], { cwd: root, stdio: 'inherit' });

const token = execFileSync(GH, ['auth', 'token'], { encoding: 'utf8' }).trim();
run('node scripts/copy-fonts.js');
run('node scripts/make-icon.js');
run('npx electron-builder --win nsis --publish always', { env: { ...process.env, GH_TOKEN: token } });
console.log(`\nОпубликовано: https://github.com/kakasobaka9/cropper/releases/tag/${tag}`);
