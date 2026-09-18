import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../archify/package.json', import.meta.url));
const { build } = require('esbuild');
const output = new URL('../archify/assets/architecture-editor.js', import.meta.url);
const result = await build({
  entryPoints: [fileURLToPath(new URL('../viewer/architecture-editor.js', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2020',
  minify: true, legalComments: 'none', charset: 'ascii',
});
// The bundle lives inside a script element in standalone HTML.
const source = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== source) {
    throw new Error('Architecture editor bundle is stale; run npm run generate:editor.');
  }
} else {
  fs.writeFileSync(output, source);
  console.log('generated archify/assets/architecture-editor.js');
}
