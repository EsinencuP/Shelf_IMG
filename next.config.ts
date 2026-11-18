import type { NextConfig } from 'next';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['sharp'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
function buildCommit() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function buildFingerprint() {
  const hash = createHash('sha256');
  function add(path: string) {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) add(`${path}/${entry}`);
    } else {
      hash.update(path).update('\0');
      hash.update(createHash('sha256').update(readFileSync(path)).digest());
    }
  }
  for (const path of [
    'src',
    'public',
    'next.config.ts',
    'package-lock.json',
    'package.json',
    'tsconfig.json',
  ])
    add(path);
  return hash.digest('hex');
}

export default function nextConfig(phase: string): NextConfig {
  if (phase !== PHASE_PRODUCTION_BUILD) return config;
  return {
    ...config,
    env: {
      SHELF_BUILD_COMMIT: buildCommit(),
      SHELF_BUILD_FINGERPRINT: buildFingerprint(),
    },
  };
}
