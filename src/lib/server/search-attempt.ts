import { sourceFailureDetails } from '../source-status';
import type { SearchAttempt } from '../types';

export async function recordSearchAttempt<T>(
  attempts: SearchAttempt[],
  query: string,
  run: () => Promise<T>,
  countResults: (response: T) => number,
): Promise<T> {
  const start = Date.now();
  try {
    const response = await run();
    const count = countResults(response);
    attempts.push({
      query,
      status: count ? 'ok' : 'empty',
      count,
      elapsedMs: Date.now() - start,
    });
    return response;
  } catch (error) {
    attempts.push({
      query,
      count: 0,
      elapsedMs: Date.now() - start,
      ...sourceFailureDetails(error),
    });
    throw error;
  }
}
