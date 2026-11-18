import { afterEach, it, expect, vi } from 'vitest';
import { POST } from '@/app/api/search-status/route';
import { serviceJson } from '@/lib/server/discovery-services';
vi.mock('@/lib/server/discovery-services', () => ({ serviceJson: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
it('status checks never spend Brave credits and require application authentication', async () => {
  vi.stubEnv('BRAVE_SEARCH_API_KEY', 'brave-secret');
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.stubEnv('MVP_ACCESS_PASSWORD', 'protected');
  const req = () =>
    new Request('https://shelf.site/api/search-status', {
      method: 'POST',
      headers: { Origin: 'https://shelf.site' },
    });
  expect((await POST(req())).status).toBe(401);
  expect(serviceJson).not.toHaveBeenCalled();
  vi.stubEnv('MVP_ACCESS_PASSWORD', '');
  vi.stubEnv('NODE_ENV', 'development');
  expect((await POST(req())).status).toBe(200);
  expect(serviceJson).not.toHaveBeenCalled();
});
