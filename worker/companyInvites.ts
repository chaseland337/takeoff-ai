import { CompanyAuthError, companyError, companyJson, requireCompanyUser, supabaseUrl, type CompanyEnv } from './companyAuth';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleInvites(request: Request, env: CompanyEnv, fetchFn: typeof fetch = fetch): Promise<Response> {
  try {
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) return companyJson({ error: 'method', message: 'Use GET, POST or DELETE.' }, 405);
    const user = await requireCompanyUser(request, env, fetchFn);
    if (user.role === 'member') throw new CompanyAuthError(403, 'Only company owners and administrators can manage invitations.');
    const base = supabaseUrl(env);
    if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new CompanyAuthError(503, 'Invitations are not configured.');
    const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: ['Bearer', env.SUPABASE_SERVICE_ROLE_KEY].join(' '), 'content-type': 'application/json' };
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const response = await fetchFn(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args) });
      if (!response.ok) throw new CompanyAuthError(response.status >= 500 ? 503 : 403, 'The company change could not be completed.');
      return response.json();
    };
    if (request.method === 'GET') {
      // Listing uses the caller's JWT and RLS, not service-role project access.
      const readHeaders = { apikey: env.SUPABASE_ANON_KEY!, authorization: ['Bearer', user.token].join(' ') };
      const query = `organization_id=eq.${user.organizationId}`;
      const [members, invites] = await Promise.all([
        fetchFn(`${base}/rest/v1/organization_members?${query}&select=user_id,email,role,created_at`, { headers: readHeaders }),
        fetchFn(`${base}/rest/v1/organization_invites?${query}&accepted_at=is.null&select=id,email,role,created_at,expires_at`, { headers: readHeaders }),
      ]);
      if (!members.ok || !invites.ok) throw new CompanyAuthError(503, 'Company members are unavailable.');
      return companyJson({ members: await members.json(), invites: await invites.json() });
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch { return companyJson({ error: 'bad_request', message: 'Provide a JSON object.' }, 400); }
    if (request.method === 'DELETE') {
      const target = body.userId ?? body.inviteId;
      if (typeof target !== 'string' || !uuid.test(target) || Boolean(body.userId) === Boolean(body.inviteId)) {
        return companyJson({ error: 'bad_request', message: 'Provide one userId or inviteId.' }, 400);
      }
      await rpc('revoke_company_access', { p_actor: user.userId, p_user_id: body.userId ?? null, p_invite_id: body.inviteId ?? null });
      return companyJson({ ok: true });
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const role = body.role;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (role !== 'admin' && role !== 'member')) {
      return companyJson({ error: 'bad_request', message: 'Provide a valid email and admin or member role.' }, 400);
    }
    if (role === 'admin' && user.role !== 'owner') throw new CompanyAuthError(403, 'Only an owner can invite administrators.');
    let redirect: URL;
    try {
      redirect = new URL(env.APP_URL ?? '');
      if (redirect.protocol !== 'https:' && redirect.hostname !== 'localhost' && redirect.hostname !== '127.0.0.1') throw new Error();
    } catch { throw new CompanyAuthError(503, 'Invitation redirects are not configured.'); }
    const prepared = await rpc('prepare_company_invite', { p_actor: user.userId, p_email: email, p_role: role }) as { id: string; existing_user: boolean };
    // Existing accounts receive a recovery link; new accounts receive an invite link.
    // Neither link's editable user_metadata grants access: the database pending row does.
    const endpoint = prepared.existing_user ? 'recover' : 'invite';
    const response = await fetchFn(`${base}/auth/v1/${endpoint}?redirect_to=${encodeURIComponent(`${redirect.origin}/`)}`, {
      method: 'POST', headers, body: JSON.stringify({ email }),
    });
    if (!response.ok) {
      // Keep the pending row for safe retry; never expose provider details.
      throw new CompanyAuthError(503, 'The invitation email could not be sent. Try again.');
    }
    return companyJson({ ok: true, inviteId: prepared.id }, 201);
  } catch (error) { return companyError(error); }
}
