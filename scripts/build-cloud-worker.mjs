import { build } from 'esbuild';
import JSZip from 'jszip';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run worker:build to stage the Neon runtime dependencies.');
const { packages } = JSON.parse(await readFile('package-lock.json', 'utf8'));
const sharp = packages['node_modules/sharp'];
const nativePackages = ['@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64'];
const names = ['sharp', ...Object.keys(sharp.dependencies), ...nativePackages];
const locked = names.map((name) => {
  const entry = packages[`node_modules/${name}`];
  if (!entry?.resolved || !entry.integrity?.startsWith('sha512-'))
    throw new Error(`Missing locked dependency: ${name}`);
  return { name, ...entry };
});

await mkdir('.runtime', { recursive: true });
const root = await realpath(process.cwd());
const output = await realpath('.runtime');
if (dirname(output) !== root)
  throw new Error('The worker build directory must be inside the project.');
const stage = await mkdtemp(join(output, 'neon-sharp-'));
try {
  // npm can omit optional packages for another CPU. Pack the locked tarballs
  // directly, then extract them without running package installation scripts.
  const packed = JSON.parse(
    execFileSync(
      process.execPath,
      [npm, 'pack', ...locked.map(({ resolved }) => resolved), '--ignore-scripts', '--json'],
      { cwd: stage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    ),
  );
  const packedFiles = new Map(packed.map(({ name, filename }) => [name, filename]));
  for (const { name, integrity } of locked) {
    const filename = packedFiles.get(name);
    if (typeof filename !== 'string' || basename(filename) !== filename)
      throw new Error(`Missing packed dependency: ${name}`);
    const archive = join(stage, filename);
    const digest = createHash('sha512')
      .update(await readFile(archive))
      .digest('base64');
    if (`sha512-${digest}` !== integrity)
      throw new Error(`Invalid locked dependency archive: ${name}`);
    const destination = join(stage, 'node_modules', name);
    await mkdir(destination, { recursive: true });
    execFileSync('tar', ['-xzf', archive, '-C', destination, '--strip-components=1'], {
      stdio: 'inherit',
    });
  }

  const built = await build({
    entryPoints: ['functions/search-worker.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['sharp'],
    write: false,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  const zip = new JSZip();
  zip.file('index.mjs', built.outputFiles[0].contents);

  async function addPackage(path) {
    for (const entry of await readdir(join(stage, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await addPackage(child);
      else if (entry.isFile()) zip.file(child, await readFile(join(stage, child)));
    }
  }
  for (const name of names) await addPackage(`node_modules/${name}`);

  const addonDir = join(stage, 'node_modules', nativePackages[0], 'lib');
  const vipsDir = join(stage, 'node_modules', nativePackages[1], 'lib');
  const vips = (await readdir(vipsDir)).find((file) => /^libvips-cpp\.so(?:\.|$)/.test(file));
  if (!vips) throw new Error('Sharp libvips shared library is missing.');
  for (const file of [join(addonDir, 'sharp-linux-arm64.node'), join(vipsDir, vips)]) {
    const binary = await readFile(file);
    if (
      binary.length < 20 ||
      binary.readUInt32BE(0) !== 0x7f454c46 ||
      binary.readUInt16LE(18) !== 183
    )
      throw new Error(`Expected Linux ARM64 ELF: ${basename(file)}`);
  }
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (archive.length > 10 * 1024 * 1024) throw new Error('Neon worker archive exceeds 10 MiB.');
  await writeFile(join(output, 'cloud-worker.zip'), archive);
  console.log('Cloud worker bundled: .runtime/cloud-worker.zip');
} finally {
  if (dirname(await realpath(stage)) === output) await rm(stage, { recursive: true, force: true });
}
