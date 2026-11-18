import { boundedWork, errorResponse, guardRequest } from '@/lib/server/http';
import { serviceJson } from '@/lib/server/discovery-services';
import { tavilyFreeRemaining } from '@/lib/server/web-discovery';
export const runtime = 'nodejs';
export const maxDuration = 30;
export async function POST(request: Request) {
  try {
    guardRequest(request);
    return await boundedWork(async () => {
      let status: 'ok' | 'unavailable' | 'not_configured' = 'not_configured';
      let message = 'Нужен ключ Tavily Free.';
      if (process.env.TAVILY_API_KEY) {
        try {
          if (!process.env.TAVILY_API_KEY.startsWith('tvly-')) throw Error();
          tavilyFreeRemaining(
            await serviceJson(
              new URL('https://api.tavily.com/usage'),
              process.env.TAVILY_API_KEY,
              undefined,
              4000,
            ),
          );
          status = 'ok';
          message = 'Free-тариф проверен; поиск не запускался.';
        } catch {
          status = 'unavailable';
          message = 'Free-тариф, квота или соединение не подтверждены.';
        }
      }
      return Response.json(
        { services: [{ id: 'tavily', source: 'Tavily Free', status, message }] },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    });
  } catch (error) {
    return errorResponse(error);
  }
}
