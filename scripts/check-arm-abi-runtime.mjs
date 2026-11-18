import assert from 'node:assert/strict';
import sharp from 'sharp';
import worker from './index.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
const fixture = sharp({ create: { width: 40, height: 60, channels: 3, background: '#085' } });
const codecs = [
  ['jpeg', await fixture.clone().jpeg().toBuffer()],
  ['png', await fixture.clone().png().toBuffer()],
  ['webp', await fixture.clone().webp().toBuffer()],
];
for (const [format, bytes] of codecs) {
  const image = sharp(bytes);
  const info = await image.metadata();
  assert.equal(info.format, format);
  assert.equal(info.width, 40);
  assert.equal(info.height, 60);
  assert.equal((await image.stats()).channels.length, 3);
}
await assert.rejects(sharp(Buffer.from([255, 216, 255, 217])).stats());
const url = 'https://worker.neon.tech/health';
assert.equal((await worker.fetch(new Request(url))).status, 401);
const authenticated = await worker.fetch(new Request(url, { headers: { 'x-secret': 'offline-arm-qa' } }));
assert.equal(authenticated.status, 200);
assert.deepEqual(await authenticated.json(), { ready: false, executor: 'neon', version: 1 });
console.log(JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  node: process.versions.node,
  glibc: process.report.getReport().header.glibcVersionRuntime,
  sharp: sharp.versions.sharp,
  vips: sharp.versions.vips,
  codecs: codecs.map(([name]) => name),
  damagedJpegRejected: true,
  health: [401, authenticated.status],
}));
