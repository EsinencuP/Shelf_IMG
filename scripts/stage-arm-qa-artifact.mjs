import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const directory = 'public/qa-arm';
await mkdir(directory, { recursive: true });
const build = spawnSync('npm', ['run', 'worker:build'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
process.stdout.write(build.stdout ?? '');
process.stderr.write(build.stderr ?? '');
const status = {
  arch: process.arch,
  node: process.versions.node,
  exitCode: build.status,
  spawnCode: build.error?.code ?? null,
  errors: (build.stderr ?? '').split('\n').filter((line) =>
    /(?:ENOENT|ERR_MODULE_NOT_FOUND|unsupported platform|npm error code|archive exceeds|locked dependency|Linux ARM64 ELF)/i.test(line) &&
    !/https?:\/\/|password|secret|token|credential/i.test(line),
  ).slice(0, 12),
};
await writeFile(directory + '/status.json', JSON.stringify(status) + '\n');
if (build.status !== 0) process.exit(0);

const archive = await readFile('.runtime/cloud-worker.zip');
const bytesPerPart = 240_000;
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
