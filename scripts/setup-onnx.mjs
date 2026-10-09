import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
await mkdir(resolve(root, 'public/onnx'), { recursive: true });
for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  await copyFile(
    resolve(root, 'node_modules/onnxruntime-web/dist', name),
    resolve(root, 'public/onnx', name),
  );
}
console.log('ONNX WASM assets copied to public/onnx.');
