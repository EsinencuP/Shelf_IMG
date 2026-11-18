import { build } from 'esbuild';
import JSZip from 'jszip';
import { mkdir, writeFile } from 'node:fs/promises';

const built = await build({
  entryPoints: ['functions/search-worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  write: false,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
const zip = new JSZip();
zip.file('index.mjs', built.outputFiles[0].contents);
await mkdir('.runtime', { recursive: true });
await writeFile(
  '.runtime/cloud-worker.zip',
  await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
);
console.log('Cloud worker bundled: .runtime/cloud-worker.zip');
