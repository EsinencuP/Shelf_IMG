import { expect, it } from 'vitest';
import config from '../vercel.json';
import { maxDuration as searchDuration } from '@/app/api/search/route';
import { maxDuration as probeDuration } from '@/app/api/health/sources/route';

it('keeps Vercel region and function limits aligned with the route exports', () => {
  expect(config.regions).toEqual(['fra1']);
  expect(config.functions['src/app/api/search/route.ts'].maxDuration).toBe(searchDuration);
  expect(config.functions['src/app/api/health/sources/route.ts'].maxDuration).toBe(probeDuration);
  expect(searchDuration).toBe(180);
  expect(probeDuration).toBe(300);
});
