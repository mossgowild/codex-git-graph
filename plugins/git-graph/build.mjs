import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const ui = await build({ entryPoints: ['ui.mjs'], bundle: true, minify: true, format: 'iife', platform: 'browser', write: false });
const html = (await readFile('window.html', 'utf8')).replace('/* APP_SCRIPT */', () => ui.outputFiles[0].text.replaceAll('</script', '<\\/script'));
await writeFile('dist/window.html', html);
await build({ entryPoints: ['server.mjs'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: 'dist/server.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
console.log('Built window UI and bundled MCP server.');
