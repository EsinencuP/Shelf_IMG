import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const archive = await readFile('.runtime/cloud-worker.zip');
const bytesPerPart = 240_000;
const directory = 'public/qa-arm';
await mkdir(directory, { recursive: true });
const parts = [];
for (let offset = 0; offset < archive.length; offset += bytesPerPart) {
  const name = String(parts.length).padStart(3, '0') + '.txt';
  const part = archive.subarray(offset, offset + bytesPerPart);
  await writeFile(directory + '/' + name, part.toString('base64'));
  parts.push({ name, bytes: part.length });
}
const manifest = {
  commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  sha256: createHash('sha256').update(archive).digest('hex'),
  bytes: archive.length,
  parts,
};
await writeFile(directory + '/manifest.json', JSON.stringify(manifest) + '\n');
console.log('Neon ARM64 archive ready:', archive.length, 'bytes, SHA-256', manifest.sha256);
