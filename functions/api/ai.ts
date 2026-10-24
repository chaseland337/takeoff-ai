// Cloudflare Pages Function at /api/ai. The logic and its tests live in worker/aiProxy.ts.
import { handle, type Env } from '../../worker/aiProxy';
import { companyJson } from '../../worker/companyAuth';

export const onRequest = (context: { request: Request; env: Env }) => {
  // Pages is always company mode; legacy access codes are standalone-worker only.
  if (!context.env.SUPABASE_URL || !context.env.SUPABASE_ANON_KEY) {
    return companyJson({ error: 'not_configured', message: 'Company access is not configured.' }, 503);
  }
  return handle(context.request, context.env);
};
