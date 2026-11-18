import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const reportPath = resolve('.runtime/browser-qa-results.json');
const playwright = 'node_modules/@playwright/test/cli.js';
await mkdir('.runtime', { recursive: true });
await mkdir('public/qa-browser', { recursive: true });
const env = {
  ...process.env,
  CI: '1',
  NODE_ENV: 'development',
  PORT: '3000',
  NEXT_TELEMETRY_DISABLED: '1',
  MVP_ACCESS_PASSWORD: '',
  DATABASE_URL: '',
  DATABASE_URL_UNPOOLED: '',
  SHELF_WORKER_URL: '',
  BRAVE_SEARCH_API_KEY: '',
  TAVILY_API_KEY: '',
  GEMINI_API_KEY: '',
  PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
};
function run(args, timeout) {
  const result = spawnSync(process.execPath, [playwright, ...args], { env, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  return result;
}
const install = run(['install', '--only-shell', 'chromium'], 120_000);
const test = install.status === 0 ? run(['test', '--reporter=json'], 480_000) : null;
const reportText = await readFile(reportPath, 'utf8').catch(() => 'null');
const report = JSON.parse(reportText);
const failureTypes = new Set();
const diagnostics = [install.stdout, install.stderr, test?.stdout, test?.stderr, ...((report?.errors ?? []).map((item) => item.message))].join('\n');
for (const [label, pattern] of [
  ['missing-system-libraries', /missing dependencies|cannot open shared object file|libatk-/i],
  ['browser-download', /Failed to download|Download failure/i],
  ['browser-launch', /browserType\.launch|Target page, context or browser has been closed/i],
  ['server-start', /webServer|Timed out waiting.*server/i],
  ['no-test-files', /No tests found/i],
]) if (pattern.test(diagnostics)) failureTypes.add(label);

function failedTests(suites) {
  return suites.flatMap((suite) => [
    ...suite.specs.filter((spec) => !spec.ok).map((spec) => ({ file: spec.file, title: spec.title })),
    ...failedTests(suite.suites ?? []),
  ]);
}
const result = {
  commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  installExitCode: install.status,
  testExitCode: test?.status ?? null,
  timeout: test?.error?.code === 'ETIMEDOUT',
  stats: report?.stats ?? null,
  specsAvailable: existsSync('tests/workflow-settings.spec.ts'),
  errors: diagnostics.split('\n').map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((line) => /Error:|EADDRINUSE|EACCES|EPERM|ENOENT|Timed out|No tests found|Cannot find module|shared object file|libatk-/i.test(line))
    .filter((line) => !/token|secret|password|credential|authorization/i.test(line))
    .slice(0, 10).map((line) => line.slice(0, 300)),
  failureTypes: [...failureTypes],
  failedTests: failedTests(report?.suites ?? []),
};
await writeFile('public/qa-browser/result.json', JSON.stringify(result) + '\n');
console.log('Browser QA summary:', JSON.stringify(result));
