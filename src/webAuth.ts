import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const webMode = import.meta.env.VITE_AI_SERVICE === '1';
let client: SupabaseClient | undefined;
export function supabase(): SupabaseClient {
  if (!webMode) throw new Error('Company services are only available in web mode.');
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Company sign-in is not configured. Contact your administrator.');
  return client ??= createClient(url, key, {
    global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
  });
}
export interface Membership { userId: string; organizationId: string; role: string; email: string }
export class CompanyAccessDenied extends Error {}
export function companyErrorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : String(error);
}
export function confirmedAccessLoss(error: unknown): boolean {
  if (error instanceof CompanyAccessDenied) return true;
  const value = error as { status?: number; code?: string; name?: string } | null;
  return value?.status === 401 || value?.status === 403 || value?.name === 'AuthSessionMissingError'
    || ['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used', 'user_not_found'].includes(value?.code ?? '');
}
let accessLocked = false;
export const companyAccessLocked = () => accessLocked;
export function lockCompanyAccess(locked: boolean) { accessLocked = locked; }
let membership: Membership | null = null;
let validationGeneration = 0;
export const currentMembership = () => membership;
export function clearMembership() { validationGeneration++; membership = null; accessLocked = false; }
export async function accessToken(): Promise<string> {
  const { data, error } = await supabase().auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error('Your session has expired. Sign in again.');
  return data.session.access_token;
}
export async function signOutThisDevice(): Promise<void> {
  const result = await supabase().auth.signOut({ scope: 'local' });
  // The SDK removes the local session even when remote revocation is unreachable.
  // Verify that removal before treating an offline sign-out error as success.
  if (result.error) {
    const { data, error } = await supabase().auth.getSession();
    if (error || data.session) throw result.error;
  }
  clearMembership();
}
export async function validateMembership(): Promise<Membership> {
  const generation = ++validationGeneration;
  const { data: auth, error: authError } = await supabase().auth.getUser();
  if (authError) throw authError;
  if (!auth.user) throw new CompanyAccessDenied('Sign in to continue.');
  const acceptance = await supabase().rpc('accept_company_invite');
  if (acceptance.error) throw acceptance.error;
  const { data, error } = await supabase().from('organization_members').select('organization_id,role').eq('user_id', auth.user.id).single();
  if (generation !== validationGeneration) throw new Error('Account changed. Sign in again.');
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) {
    membership = null;
    throw new CompanyAccessDenied('Your account does not have company access. Contact your administrator.');
  }
  const { data: latest, error: latestError } = await supabase().auth.getSession();
  if (latestError) throw latestError;
  if (generation !== validationGeneration) throw new Error('Account changed. Sign in again.');
  if (latest.session?.user.id !== auth.user.id) throw new CompanyAccessDenied('Account changed. Sign in again.');
  membership = { userId: auth.user.id, organizationId: data.organization_id, role: data.role, email: auth.user.email ?? '' };
  return membership;
}
export async function companyRequest(method: string, body?: unknown): Promise<unknown> {
  const token = await accessToken();
  const response = await fetch('/api/invites', {
    method,
    headers: { Authorization: ['Bearer', token].join(' '), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || result.error || 'Company request failed.');
  return result;
}
