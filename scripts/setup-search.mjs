import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'infra', 'free-search');
const serviceEnv = path.join(dir, '.env');
const token = () => randomBytes(32).toString('hex');
let contents;
try {
  contents = await fs.readFile(serviceEnv, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  contents = `CRAWL4AI_API_TOKEN=${token()}\nCRAWL4AI_SECRET_KEY=${token()}\n`;
  await fs.writeFile(serviceEnv, contents, { flag: 'wx', mode: 0o600 });
}
const apiToken = contents.match(/^CRAWL4AI_API_TOKEN=([a-f0-9]{64})$/m)?.[1];
if (!apiToken)
  throw Error('Existing service .env has no valid CRAWL4AI_API_TOKEN; it was not overwritten.');
const settings = path.join(dir, 'settings.local.yml');
try {
  await fs.writeFile(
    settings,
    `use_default_settings: true
server:
  secret_key: "${token()}"
  bind_address: "0.0.0.0"
  port: 8080
  limiter: false
  image_proxy: false
search:
  formats: [html, json]
  safe_search: 2
outgoing:
  request_timeout: 8.0
`,
    // SearXNG runs as its unprivileged container user; only the search cookie secret is here.
    { flag: 'wx', mode: 0o644 },
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}

// Keep all existing secrets/settings. Only fill missing/blank local service values.
const filename = path.join(root, '.env.local');
let local = await fs.readFile(filename, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
for (const [key, value] of Object.entries({
  SEARXNG_URL: 'http://127.0.0.1:8080',
  CRAWL4AI_URL: 'http://127.0.0.1:11235',
  CRAWL4AI_API_TOKEN: apiToken,
  CRAWL4AI_ALLOWED_HOSTS: 'linella.md,bucuria.md',
})) {
  const expression = new RegExp(`^${key}=(.*)$`, 'm');
  const existing = local.match(expression);
  if (!existing) local += `${local.endsWith('\n') || !local ? '' : '\n'}${key}=${value}\n`;
  else if (!existing[1].trim()) local = local.replace(expression, `${key}=${value}`);
}
await fs.writeFile(filename, local, { mode: 0o600 });
console.log('Local search settings prepared; secrets retained in ignored files.');
console.log('Run npm run search:start, then restart npm run dev. Docker is required.');
console.log(
  'These loopback addresses work locally only. Vercel needs your own HTTPS service endpoints.',
);
