import { describe, expect, it } from 'vitest';
import { hasCompanyConfig, requireCompanyUser } from '../worker/companyAuth';

const env = { SUPABASE_URL: 'https://company.supabase.co', SUPABASE_ANON_KEY: 'public-key' };
const request = () => new Request('https://app.test/api/ai', { headers: { authorization: ['Bearer', 'user-jwt'].join(' ') } });
const user = { id: 'user-id', email: 'owner@example.com' };
const membership = { organization_id: 'org-id', role: 'owner' };

describe('company authorization', () => {
  it('verifies the live session before querying RLS membership with the user token and public key', async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return Response.json(calls.length === 1 ? user : [membership]);
    }) as typeof fetch;
    expect(await requireCompanyUser(request(), env, fetchFn)).toEqual({
      userId: user.id, email: user.email, organizationId: 'org-id', role: 'owner', token: 'user-jwt',
    });
    expect(calls[0].url).toBe('https://company.supabase.co/auth/v1/user');
    expect(calls[1].url).toContain('user_id=eq.user-id');
    expect(calls.every(c => c.headers.get('apikey') === 'public-key' && c.headers.get('authorization') === ['Bearer', 'user-jwt'].join(' '))).toBe(true);
  });

  it('rejects missing, revoked, uninvited, ambiguous and invalid-role users', async () => {
    await expect(requireCompanyUser(new Request('https://app.test'), env)).rejects.toMatchObject({ status: 401 });
    await expect(requireCompanyUser(request(), env, (async () => new Response('', { status: 401 })) as typeof fetch)).rejects.toMatchObject({ status: 401 });
    for (const rows of [[], [membership, membership], [{ ...membership, role: 'superuser' }]]) {
      const fetchFn = (async (url: string) => Response.json(url.endsWith('/user') ? user : rows)) as typeof fetch;
      await expect(requireCompanyUser(request(), env, fetchFn)).rejects.toMatchObject({ status: 403 });
    }
  });

  it('fails closed for partial configuration, lookup failures and transport errors', async () => {
    expect(hasCompanyConfig({ SUPABASE_SERVICE_ROLE_KEY: 'secret' })).toBe(true);
    await expect(requireCompanyUser(request(), { SUPABASE_URL: env.SUPABASE_URL })).rejects.toMatchObject({ status: 503 });
    await expect(requireCompanyUser(request(), env, (async () => { throw new Error('secret'); }) as typeof fetch)).rejects.toMatchObject({ status: 503 });
    const broken = (async (url: string) => url.endsWith('/user') ? Response.json(user) : new Response('secret', { status: 500 })) as typeof fetch;
    await expect(requireCompanyUser(request(), env, broken)).rejects.toMatchObject({ status: 503, message: 'Company access is unavailable.' });
  });
});
