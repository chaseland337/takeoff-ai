import { describe, expect, it } from 'vitest';
import { handleInvites } from '../worker/companyInvites';
import type { CompanyEnv, CompanyRole } from '../worker/companyAuth';

const actor = '11111111-1111-4111-8111-111111111111';
const inviteId = '22222222-2222-4222-8222-222222222222';
const env: CompanyEnv = {
  SUPABASE_URL: 'https://company.supabase.co', SUPABASE_ANON_KEY: 'public-key',
  SUPABASE_SERVICE_ROLE_KEY: 'server-secret', APP_URL: 'https://app.example/path?untrusted=ignored',
};
function request(method: string, body?: unknown) {
  return new Request('https://evil.test/api/invites', {
    method, headers: { authorization: ['Bearer', 'user-jwt'].join(' '), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function backend(role: CompanyRole = 'owner', options: { existing?: boolean; providerStatus?: number; rpcStatus?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: actor, email: 'owner@example.com' });
    if (url.includes('organization_members?user_id=')) return Response.json([{ organization_id: actor, role }]);
    if (url.includes('/rpc/')) return Response.json({ id: inviteId, existing_user: options.existing ?? false }, { status: options.rpcStatus ?? 200 });
    if (url.includes('/auth/v1/')) return Response.json({ secret: 'do-not-leak' }, { status: options.providerStatus ?? 200 });
    return Response.json([]);
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('company invitations', () => {
  it('denies members and denies admin invitations to non-owners', async () => {
    const member = backend('member');
    expect((await handleInvites(request('GET'), env, member.fetchFn)).status).toBe(403);
    expect(member.calls).toHaveLength(2);
    const admin = backend('admin');
    expect((await handleInvites(request('POST', { email: 'a@example.com', role: 'admin' }), env, admin.fetchFn)).status).toBe(403);
    expect(admin.calls).toHaveLength(2);
  });

  it('validates email and roles before privileged calls', async () => {
    for (const body of [null, [], { email: 'invalid', role: 'member' }, { email: 'a@example.com', role: 'owner' }, { email: 'a@example.com\r\nx', role: 'member' }]) {
      const b = backend();
      expect((await handleInvites(request('POST', body), env, b.fetchFn)).status).toBe(400);
      expect(b.calls).toHaveLength(2);
    }
  });

  it('prepares an authorized pending invite before sending email to a trusted redirect', async () => {
    const b = backend();
    const response = await handleInvites(request('POST', { email: ' A@EXAMPLE.COM ', role: 'admin' }), env, b.fetchFn);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, inviteId });
    expect(JSON.parse(b.calls[2].init!.body as string)).toEqual({ p_actor: actor, p_email: 'a@example.com', p_role: 'admin' });
    expect(b.calls[3].url).toBe('https://company.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fapp.example%2F');
    expect(new Headers(b.calls[3].init!.headers).get('apikey')).toBe('server-secret');
    expect(JSON.parse(b.calls[3].init!.body as string)).toEqual({ email: 'a@example.com' });
  });

  it('supports already registered accounts using recovery without metadata role grants', async () => {
    const b = backend('admin', { existing: true });
    expect((await handleInvites(request('POST', { email: 'a@example.com', role: 'member' }), env, b.fetchFn)).status).toBe(201);
    expect(b.calls[3].url).toContain('/recover?');
  });

  it('does not send email after cross-company or role authorization rejection', async () => {
    const b = backend('owner', { rpcStatus: 403 });
    expect((await handleInvites(request('POST', { email: 'a@example.com', role: 'member' }), env, b.fetchFn)).status).toBe(403);
    expect(b.calls).toHaveLength(3);
  });

  it('returns only generic provider errors and fails closed without trusted config', async () => {
    const b = backend('owner', { providerStatus: 500 });
    const response = await handleInvites(request('POST', { email: 'a@example.com', role: 'member' }), env, b.fetchFn);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('do-not-leak');
    for (const over of [{ APP_URL: undefined }, { APP_URL: 'http://evil.test' }, { SUPABASE_SERVICE_ROLE_KEY: undefined }]) {
      expect((await handleInvites(request('POST', { email: 'a@example.com', role: 'member' }), { ...env, ...over }, backend().fetchFn)).status).toBe(503);
    }
  });

  it('lists members and pending invites with the caller JWT', async () => {
    const b = backend();
    expect(await (await handleInvites(request('GET'), env, b.fetchFn)).json()).toEqual({ members: [], invites: [] });
    expect(b.calls.slice(2).every(c => new Headers(c.init!.headers).get('apikey') === 'public-key')).toBe(true);
  });

  it('validates revocation and delegates target org/role enforcement to an atomic service RPC', async () => {
    const b = backend('admin');
    expect((await handleInvites(request('DELETE', { userId: actor }), env, b.fetchFn)).status).toBe(200);
    expect(JSON.parse(b.calls[2].init!.body as string)).toEqual({ p_actor: actor, p_user_id: actor, p_invite_id: null });
    for (const body of [{}, { userId: 'bad' }, { userId: actor, inviteId }]) {
      expect((await handleInvites(request('DELETE', body), env, backend().fetchFn)).status).toBe(400);
    }
  });
});
