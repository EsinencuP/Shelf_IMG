import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const reportPath = resolve('.runtime/browser-qa-results.json');
const playwright = 'node_modules/@playwright/test/cli.js';
await mkdir('.runtime', { recursive: true });
await mkdir('qa-browser-results/qa-browser', { recursive: true });
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
const prefix = resolve('.runtime/chromium-runtime');
const packed = spawnSync('npm', ['install', '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', '--prefix', prefix, '@sparticuz/chromium@153.0.0'], { timeout: 180_000, encoding: 'utf8' });
process.stdout.write(packed.stdout ?? '');
process.stderr.write(packed.stderr ?? '');
let browser = null;
let bootFailure = '';
try {
  if (packed.status !== 0) throw new Error('Serverless Chromium npm package failed to install.');
  process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs24.x';
  const find = createRequire(resolve(prefix, 'package.json'));
  const imported = await import(pathToFileURL(find.resolve('@sparticuz/chromium')).href);
  const serverless = imported.default?.executablePath ? imported.default : imported.default?.default;
  if (!serverless?.executablePath) throw new Error('Serverless Chromium loader export was not found.');
  const fallback = await serverless.executablePath();
  env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH ?? '/tmp/al2023/lib';
  const { chromium } = await import('playwright-core');
  const headlessShell = join(dirname(chromium.executablePath()), '..', '..', 'chromium_headless_shell-1248', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  const deps = spawnSync('ldd', [headlessShell], { env, encoding: 'utf8' });
  if (deps.status === 0 && !/not found/i.test(deps.stdout)) {
    browser = 'playwright-chromium-156 + AL2023 libraries';
  } else {
    browser = 'serverless-chromium-153';
    env.SHELF_QA_CHROMIUM_PATH = fallback;
    env.SHELF_QA_CHROMIUM_ARGS = JSON.stringify(serverless.args);
  }
} catch (error) {
  bootFailure = error instanceof Error ? error.message : String(error);
  console.error('Browser bootstrap error:', bootFailure);
}
const test = browser ? run(['test', '--config=playwright.qa.config.ts', '--reporter=json'], 480_000) : null;
const reportText = await readFile(reportPath, 'utf8').catch(() => 'null');
let report;
try { report = JSON.parse(reportText); } catch { report = null; }
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
    ...(suite.specs ?? []).filter((spec) => !spec.ok).map((spec) => ({ file: spec.file, title: spec.title })),
    ...failedTests(suite.suites ?? []),
  ]);
}
const result = {
  commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  installExitCode: install.status,
  packagedBrowserExitCode: packed.status,
  browser,
  bootFailure: /token|secret|password|credential|authorization/i.test(bootFailure) ? 'Browser bootstrap failed' : bootFailure.slice(0, 400),
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
await writeFile('qa-browser-results/qa-browser/result.json', JSON.stringify(result) + '\n');
console.log('Browser QA summary:', JSON.stringify(result));
