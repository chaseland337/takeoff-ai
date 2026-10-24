import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  single: vi.fn(),
  createClient: vi.fn(),
  rpc: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
beforeEach(() => {
  vi.resetModules(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'user' } } }, error: null });
  mocks.createClient.mockReturnValue({ rpc: mocks.rpc, auth: { getSession: mocks.getSession, getUser: mocks.getUser, signOut: mocks.signOut }, from: () => ({ select: () => ({ eq: () => ({ single: mocks.single }) }) }) });
});
describe('company authentication', () => {
  it('bypasses browser HTTP caches for every Supabase request, including private PDF downloads', async () => {
    vi.stubEnv('VITE_AI_SERVICE', '1'); vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-key');
    const fetchMock = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', fetchMock);
    const { supabase } = await import('../src/webAuth');
    supabase();
    const options = mocks.createClient.mock.calls.at(-1)![2] as { global: { fetch: typeof fetch } };
    await options.global.fetch('https://example.supabase.co/storage/v1/object/authenticated/project-drawings/private.pdf', { cache: 'force-cache' });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].cache).toBe('no-store');
    vi.unstubAllGlobals();
  });
  it('uses SDK local signout and tolerates offline revocation errors only after session removal', async () => {
    vi.stubEnv('VITE_AI_SERVICE', '1'); vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-key');
    const offline = new Error('offline');
    mocks.signOut.mockResolvedValue({ error: offline });
    mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    const { signOutThisDevice } = await import('../src/webAuth');
    await expect(signOutThisDevice()).resolves.toBeUndefined();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    await expect(signOutThisDevice()).rejects.toThrow('offline');
  });
  it('retains verified account context on transient lookup failure and distinguishes confirmed revocation', async () => {
    vi.stubEnv('VITE_AI_SERVICE', '1'); vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-key');
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user' } }, error: null });
    mocks.single.mockResolvedValueOnce({ data: { organization_id: 'org', role: 'member' }, error: null });
    const auth = await import('../src/webAuth');
    const member = await auth.validateMembership();
    const offline = { message: 'Failed to fetch', status: 0 };
    mocks.single.mockResolvedValueOnce({ data: null, error: offline });
    await expect(auth.validateMembership()).rejects.toEqual(offline);
    expect(auth.currentMembership()).toBe(member);
    expect(auth.confirmedAccessLoss(offline)).toBe(false);
    auth.lockCompanyAccess(true);
    expect(auth.companyAccessLocked()).toBe(true);
    expect(auth.currentMembership()).toBe(member);
    mocks.single.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });
    try { await auth.validateMembership(); } catch (error) { expect(auth.confirmedAccessLoss(error)).toBe(true); }
    expect(auth.currentMembership()).toBe(null);
  });
  it('fails closed when public configuration is missing', async () => {
    vi.stubEnv('VITE_AI_SERVICE', '1');
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    const { supabase } = await import('../src/webAuth');
    expect(() => supabase()).toThrow('not configured');
  });
  it('rejects a signed-in account without membership', async () => {
    vi.stubEnv('VITE_AI_SERVICE', '1'); vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-key');
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user' } }, error: null });
    mocks.single.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'missing' } });
    const { validateMembership, currentMembership } = await import('../src/webAuth');
    await expect(validateMembership()).rejects.toThrow('does not have company access');
    expect(currentMembership()).toBe(null);
    expect(mocks.rpc).toHaveBeenCalledWith('accept_company_invite');
    expect(mocks.rpc.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.single.mock.invocationCallOrder.at(-1)!);
  });
  it('obtains a fresh SDK session for every authenticated request', async () => {
    vi.stubEnv('VITE_AI_SERVICE', '1'); vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-key');
    mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'first' } } }).mockResolvedValueOnce({ data: { session: { access_token: 'refreshed' } } });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ members: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { companyRequest } = await import('../src/webAuth');
    await companyRequest('GET'); await companyRequest('GET');
    expect(fetchMock.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].headers)).toEqual([
      { Authorization: ['Bearer', 'first'].join(' '), 'Content-Type': 'application/json' },
      { Authorization: ['Bearer', 'refreshed'].join(' '), 'Content-Type': 'application/json' },
    ]);
    vi.unstubAllGlobals();
  });
  it('does not restore a membership from a lookup completed after signout', async () => {
    vi.stubEnv('VITE_AI_SERVICE', '1'); vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-key');
    let finish!: (value: unknown) => void;
    let queried!: () => void;
    const lookup = new Promise((resolve) => { finish = resolve; });
    const queryStarted = new Promise<void>((resolve) => { queried = resolve; });
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user' } }, error: null });
    mocks.single.mockImplementationOnce(() => { queried(); return lookup; });
    const { validateMembership, clearMembership, currentMembership } = await import('../src/webAuth');
    const pending = validateMembership();
    const rejected = expect(pending).rejects.toThrow('Account changed');
    await queryStarted;
    clearMembership();
    finish({ data: { organization_id: 'org', role: 'member' }, error: null });
    await rejected;
    expect(currentMembership()).toBe(null);
  });
  it('checks the latest SDK user before publishing a completed membership lookup', async () => {
    vi.stubEnv('VITE_AI_SERVICE', '1'); vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-key');
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'previous-user' } }, error: null });
    mocks.single.mockResolvedValueOnce({ data: { organization_id: 'org', role: 'member' }, error: null });
    mocks.getSession.mockResolvedValueOnce({ data: { session: { user: { id: 'new-user' } } }, error: null });
    const { validateMembership, currentMembership, confirmedAccessLoss } = await import('../src/webAuth');
    await expect(validateMembership()).rejects.toSatisfy(confirmedAccessLoss);
    expect(currentMembership()).toBe(null);
  });
});
