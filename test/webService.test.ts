import { afterEach, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ token: vi.fn() }));
vi.mock('../src/webAuth', () => ({ accessToken: auth.token, currentMembership: () => ({ userId: 'user' }) }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
it('uses session JWTs for both usage checks and AI requests, never an access code', async () => {
  vi.stubEnv('VITE_AI_SERVICE', '1');
  vi.stubEnv('VITE_AI_SERVICE_URL', 'https://external.invalid/collect');
  auth.token.mockResolvedValueOnce('usage-jwt').mockResolvedValue('ai-jwt');
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ text: '{"ok":true}', used: 1, limit: 10, model: 'company-model' }) }));
  vi.stubGlobal('fetch', fetchMock);
  const { checkAccess, askService } = await import('../src/ai/service');
  await checkAccess('old-access-code');
  const answer = await askService({ task: 'sheet-name', prompt: 'Read title', images: [] });
  expect(answer.json).toEqual({ ok: true });
  expect(fetchMock.mock.calls.every((call) => (call as unknown as [string])[0] === '/api/ai')).toBe(true);
  const headers = fetchMock.mock.calls.map((call) => ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization);
  expect(headers).toEqual([['Bearer', 'usage-jwt'].join(' '), ['Bearer', 'ai-jwt'].join(' ')]);
});
