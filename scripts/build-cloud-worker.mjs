import { build } from 'esbuild';
import JSZip from 'jszip';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run worker:build to stage the Neon runtime dependencies.');
const { packages } = JSON.parse(await readFile('package-lock.json', 'utf8'));
const sharp = packages['node_modules/sharp'];
const nativePackages = ['@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64'];
const names = ['sharp', ...Object.keys(sharp.dependencies), ...nativePackages];
const dependencies = { sharp: sharp.version };
const packageJson = { name: 'shelf-neon-runtime', version: '0.1.0', private: true, dependencies };
const staged = Object.fromEntries(
  names.map((name) => {
    const path = `node_modules/${name}`;
    const entry = packages[path];
    if (!entry?.integrity) throw new Error(`Missing locked dependency: ${name}`);
    return [path, entry];
  }),
);
staged['node_modules/sharp'] = {
  ...sharp,
  optionalDependencies: Object.fromEntries(
    nativePackages.map((name) => [name, sharp.optionalDependencies[name]]),
  ),
};

await mkdir('.runtime', { recursive: true });
const root = await realpath(process.cwd());
const output = await realpath('.runtime');
if (dirname(output) !== root)
  throw new Error('The worker build directory must be inside the project.');
const stage = await mkdtemp(join(output, 'neon-sharp-'));
try {
  await writeFile(join(stage, 'package.json'), JSON.stringify(packageJson));
  await writeFile(
    join(stage, 'package-lock.json'),
    JSON.stringify({
      ...packageJson,
      lockfileVersion: 3,
      packages: { '': packageJson, ...staged },
    }),
  );
  // Neon runs Linux ARM64/glibc, regardless of the workstation used to make the ZIP.
  execFileSync(
    process.execPath,
    [
      npm,
      'ci',
      '--omit=dev',
      '--include=optional',
      '--ignore-scripts',
      '--os=linux',
      '--cpu=arm64',
      '--libc=glibc',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: stage, stdio: 'inherit' },
  );

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

  const addon = await readFile(
    join(stage, 'node_modules', nativePackages[0], 'lib', 'sharp-linux-arm64.node'),
  );
  if (addon.readUInt32BE(0) !== 0x7f454c46 || addon.readUInt16LE(18) !== 183)
    throw new Error('Sharp addon is not Linux ARM64 ELF.');
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (archive.length > 10 * 1024 * 1024) throw new Error('Neon worker archive exceeds 10 MiB.');
  await writeFile(join(output, 'cloud-worker.zip'), archive);
  console.log('Cloud worker bundled: .runtime/cloud-worker.zip');
} finally {
  if (dirname(await realpath(stage)) === output) await rm(stage, { recursive: true, force: true });
}
