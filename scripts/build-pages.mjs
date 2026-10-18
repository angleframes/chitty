// Builds the browser-only version of the app into docs/ for GitHub Pages.
// docs/ = public/ + local-backend.js loaded before app.js. Run: node scripts/build-pages.mjs
import { cpSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs');
const keep = join(out, 'legacy'); // the previous single-page app lives here; never touched

mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'app.css', 'app.js', 'recorder.js', 'share.js', 'local-backend.js', 'logo.png', 'logo-mark.png']) {
  cpSync(join(root, 'public', f), join(out, f));
}
const html = join(out, 'index.html');
let s = readFileSync(html, 'utf8');
if (!s.includes('local-backend.js')) {
  s = s.replace('<script src="app.js"></script>', '<script src="local-backend.js"></script>\n  <script src="app.js"></script>');
}
writeFileSync(html, s);
writeFileSync(join(out, '.nojekyll'), '');
console.log(`Built docs/ for GitHub Pages${existsSync(keep) ? ' (legacy/ kept)' : ''}`);
