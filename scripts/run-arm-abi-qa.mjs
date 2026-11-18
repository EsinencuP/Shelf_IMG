import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import JSZip from 'jszip';

const expected = {
  "node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64-0.35.5.node": "6c3c549bd1bae0fe0b34832917a39950abd4db8feea874f8447ed07cded7854b",
  "node_modules/@img/sharp-libvips-linux-arm64/lib/libvips-cpp.so.8.18.7": "97c2ae9a663cd3de58a34d68820994e49e0e261fddbd4616bd726a72610bbc8f"
};

const root = resolve('.runtime/arm-abi');
const out = resolve('arm-abi-evidence/qa-arm');
const sysroot = join(root, 'arm64');
const emulator = join(root, 'emulator');
const worker = join(root, 'worker');
const debian = 'https://deb.debian.org/debian/pool/main/';
const nodeVersion = '24.21.0';
const distribution = 'node-v' + nodeVersion + '-linux-arm64';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

await Promise.all([root, out, sysroot, emulator, worker].map((path) => mkdir(path, { recursive: true })));

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    timeout: 160_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

async function download(url, digest) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Runtime download HTTP ' + response.status + ' (' + new URL(url).pathname + ').');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== digest) throw new Error('Runtime archive checksum mismatch: ' + new URL(url).pathname);
  return bytes;
}

function debData(archive) {
  assert.equal(archive.toString('ascii', 0, 8), '!<arch>\n');
  for (let offset = 8; offset + 60 < archive.length;) {
    const name = archive.toString('ascii', offset, offset + 16).trim().replace(/\/$/, '');
    const size = Number(archive.toString('ascii', offset + 48, offset + 58).trim());
    const start = offset + 60;
    assert.ok(Number.isSafeInteger(size) && size > 0 && start + size <= archive.length);
    if (name.startsWith('data.tar.')) return { name, bytes: archive.subarray(start, start + size) };
    offset = start + size + (size % 2);
  }
  throw new Error('Debian package data archive missing.');
}

const assets = [
  { name: 'qemu', url: debian + 'q/qemu/qemu-user-static_7.2+dfsg-7+deb12u18+b3_amd64.deb', sha: 'c3e3ba2bd87f8c5b9a5da5ef21b5a3b82d7c63b89dd448d9ddaa4eabc5b6e402', root: emulator },
  { name: 'glibc', url: debian + 'g/glibc/libc6_2.36-9+deb12u14_arm64.deb', sha: '01f4330719fd4f65580e16ea5a0527f372fca750e8f588d26deaf09f2d3b1cf4', root: sysroot },
  { name: 'libstdc++', url: debian + 'g/gcc-12/libstdc++6_12.2.0-14+deb12u1_arm64.deb', sha: '26e138c677a985775331373828a6c286c551ff397cb735d00e2383cb273d1cb2', root: sysroot },
  { name: 'libgcc', url: debian + 'g/gcc-12/libgcc-s1_12.2.0-14+deb12u1_arm64.deb', sha: '576926b283613db80168ddf76380a3bd877602778cf0d226caa7bfbfa71eacf3', root: sysroot },
];
const result = { commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null, host: process.arch, stage: 'build', ok: false };
try {
  command('npm', ['run', 'worker:build']);
  result.stage = 'archive';
  const archive = await readFile('.runtime/cloud-worker.zip');
  const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
  const seen = {};
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'));
    const bytes = await file.async('nodebuffer');
    if (Object.hasOwn(expected, path)) seen[path] = sha256(bytes);
    const destination = join(worker, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  assert.deepEqual(seen, expected);
  result.archiveComponents = { ...seen, 'index.mjs': sha256(await zip.file('index.mjs').async('nodebuffer')) };
  result.archiveSha256 = sha256(archive);
  result.releaseSourceCommit = '111f5515cc10c4d657e9baa7dacc0d5725fbd0b2';
  result.stage = 'runtime-download';
  const downloads = await Promise.all([
    ...assets.map(({ url, sha }) => download(url, sha)),
    download('https://nodejs.org/dist/v' + nodeVersion + '/' + distribution + '.tar.xz', '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2'),
  ]);
  result.stage = 'runtime-extract';
  for (const [index, asset] of assets.entries()) {
    const { name, bytes } = debData(downloads[index]);
    const archive = join(root, asset.name + '-' + name);
    await writeFile(archive, bytes);
    const only = asset.name === 'qemu' ? ['./usr/bin/qemu-aarch64-static'] : [];
    command('tar', ['-xf', archive, '-C', asset.root, ...only]);
  }
  const nodeArchive = join(root, distribution + '.tar.xz');
  await writeFile(nodeArchive, downloads.at(-1));
  command('tar', ['-xf', nodeArchive, '-C', root, distribution + '/bin/node']);
  await writeFile(join(worker, 'smoke.mjs'), await readFile('scripts/check-arm-abi-runtime.mjs'));
  result.stage = 'worker-run';
  const data = command(join(emulator, 'usr/bin/qemu-aarch64-static'), [
    '-L', sysroot, join(root, distribution, 'bin/node'), join(worker, 'smoke.mjs'),
  ], {
    cwd: worker,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', SHELF_WORKER_SECRET: 'offline-arm-qa', VIPS_CONCURRENCY: '1' },
    timeout: 100_000,
  });
  result.runtime = JSON.parse(data.trim());
  await writeFile(join(out, 'cloud-worker.zip'), archive);
  result.stage = 'done';
  result.ok = true;
} catch (error) {
  const diagnostic = [error?.message, error?.stderr].filter(Boolean).join('\n').split('\n')
    .filter((line) => !/password|credential|authorization|bearer|token/i.test(line));
  result.error = diagnostic.slice(0, 6).map((line) => line.slice(0, 350));
  console.error('Shelf ARM QA:', result.stage, result.error);
}
await writeFile(join(out, 'runtime.json'), JSON.stringify(result) + '\n');
console.log('Shelf ARM QA:', result.stage, result.ok);
