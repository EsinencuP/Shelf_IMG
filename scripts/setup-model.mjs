import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('../public/models/', import.meta.url));
const target = join(directory, 'u2netp.onnx');
const source = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx';
const expectedLength = 4_574_861;
const sha256 = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const md5 = '8e83ca70e441ab06c318d82300c84806';
function validate(bytes) {
  if (bytes.length !== expectedLength || createHash('sha256').update(bytes).digest('hex') !== sha256 || createHash('md5').update(bytes).digest('hex') !== md5) {
    throw new Error('U²-Net checksum mismatch. The existing model was not replaced.');
  }
}

await mkdir(directory, { recursive: true });
let existing;
try { existing = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing) {
  try { validate(existing); }
  catch { console.warn('Existing U²-Net weights failed verification; downloading a verified replacement.'); existing = undefined; }
}
if (existing) {
  console.log('Local U²-Net weights verified (SHA-256 + upstream MD5).');
} else {
  console.log('Downloading U²-Net weights from the official rembg release (4.57 MB).');
  const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > expectedLength) throw new Error('Model download exceeds expected size.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  validate(bytes);
  const temporary = join(directory, `u2netp.${process.pid}.tmp`);
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, target);
  console.log('Local U²-Net weights installed and verified. No API token is needed.');
}

// Retain upstream licensing beside the converted model when distributing the app.
const license = join(directory, 'U-2-Net-LICENSE.txt');
try { await readFile(license); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch('https://raw.githubusercontent.com/xuebinqin/U-2-Net/master/LICENSE', { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Could not download the upstream Apache-2.0 license.');
  const text = await response.text();
  if (!text.includes('Apache License') || !text.includes('Version 2.0')) throw new Error('Unexpected upstream license.');
  await writeFile(license, text);
}
