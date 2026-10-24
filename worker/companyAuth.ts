export interface CompanyEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  APP_URL?: string;
}

export type CompanyRole = 'owner' | 'admin' | 'member';
export interface CompanyUser {
  userId: string;
  email: string;
  organizationId: string;
  role: CompanyRole;
  token: string;
}

export class CompanyAuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Partial configuration must not silently re-enable legacy access codes. */
export const hasCompanyConfig = (env: CompanyEnv) => Boolean(env.SUPABASE_URL || env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY);

export function supabaseUrl(env: CompanyEnv): string {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new CompanyAuthError(503, 'Company access is not configured.');
  const url = new URL(env.SUPABASE_URL);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new CompanyAuthError(503, 'Company access is not configured.');
  }
  return url.origin;
}

export async function requireCompanyUser(request: Request, env: CompanyEnv, fetchFn: typeof fetch = fetch): Promise<CompanyUser> {
  const base = supabaseUrl(env);
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) throw new CompanyAuthError(401, 'Sign in to continue.');
  const headers = { apikey: env.SUPABASE_ANON_KEY!, authorization: ['Bearer', token].join(' ') };
  try {
    const auth = await fetchFn(`${base}/auth/v1/user`, { headers });
    if (!auth.ok) throw new CompanyAuthError(auth.status >= 500 ? 503 : 401, 'Your session could not be verified.');
    const user = await auth.json() as { id?: string; email?: string };
    if (!user.id || !user.email) throw new CompanyAuthError(401, 'Your session could not be verified.');
    const response = await fetchFn(`${base}/rest/v1/organization_members?user_id=eq.${encodeURIComponent(user.id)}&select=organization_id,role&limit=2`, { headers });
    if (!response.ok) throw new CompanyAuthError(503, 'Company access is unavailable.');
    const rows = await response.json() as { organization_id?: string; role?: CompanyRole }[];
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0].organization_id || !['owner', 'admin', 'member'].includes(rows[0].role ?? '')) {
      throw new CompanyAuthError(403, 'A company invitation is required.');
    }
    return { userId: user.id, email: user.email, token, organizationId: rows[0].organization_id, role: rows[0].role! };
  } catch (error) {
    if (error instanceof CompanyAuthError) throw error;
    throw new CompanyAuthError(503, 'Company access is unavailable.');
  }
}

export function companyError(error: unknown): Response {
  const status = error instanceof CompanyAuthError ? error.status : 503;
  const message = error instanceof CompanyAuthError ? error.message : 'Company access is unavailable.';
  return companyJson({ error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'unavailable', message }, status);
}

export function companyJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
