import { build } from 'esbuild';
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/main.js'],
  outfile: 'dist/main.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
});
copyFileSync('src/styles.css', 'dist/styles.css');
copyFileSync('node_modules/leaflet/dist/leaflet.css', 'dist/leaflet.css');
copyFileSync('src/index.html', 'dist/index.html');
const shell = readFileSync('src/shell.html', 'utf8');
for (const [role, title] of Object.entries({
  barista: 'Бариста', logistics: 'Логистика', production: 'Производство', manager: 'Управление',
})) {
  writeFileSync(`dist/${role}.html`, shell.replaceAll('{{ROLE}}', role).replaceAll('{{TITLE}}', title));
}
