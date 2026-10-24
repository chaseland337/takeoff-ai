import { describe, expect, it, vi } from 'vitest';
import { handle, parseCodes, type Env, type UsageStore } from '../worker/aiProxy';
import { firstJsonObject } from '../src/ai/service';
import { onRequest as pagesAi } from '../functions/api/ai';

function memoryStore(): UsageStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v) };
}

const env = (over: Partial<Env> = {}): Env => ({
  AI_API_KEY: 'provider-key',
  AI_MODEL: 'vision-model',
  ACCESS_CODES: 'good=Joe Drywall; other=Sam',
  DAILY_LIMIT: '2',
  GLOBAL_DAILY_LIMIT: '3',
  USAGE: memoryStore(),
  ...over,
});

const post = (code: string | null, body: unknown = { task: 'legend', prompt: 'read it', images: ['AAAA'] }) =>
  new Request('https://x/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(code ? { authorization: `Bearer ${code}` } : {}) },
    body: JSON.stringify(body),
  });

/** A provider that answers every call and records what it was sent. */
function provider(answer = '{"assemblies":[]}', status = 200) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify({ model: 'vision-model-v2', choices: [{ message: { content: answer }, finish_reason: 'stop' }] }), {
      status,
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe('AI proxy', () => {
  it('reads access codes with names', () => {
    expect([...parseCodes('a=Joe; b = Sam Ceilings ;c')]).toEqual([
      ['a', 'Joe'],
      ['b', 'Sam Ceilings'],
      ['c', 'c'],
    ]);
  });

  it('turns away a missing or wrong access code without calling the model', async () => {
    const p = provider();
    expect((await handle(post(null), env(), p.fetchFn)).status).toBe(401);
    expect((await handle(post('nope'), env(), p.fetchFn)).status).toBe(401);
    expect(p.calls).toHaveLength(0);
  });

  it('forwards the request with the server key, images first, and returns the answer', async () => {
    const p = provider();
    const res = await handle(post('good', { task: 'legend', system: 'sys', prompt: 'read it', images: ['AAAA'], maxTokens: 99999 }), env(), p.fetchFn);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '{"assemblies":[]}', model: 'vision-model-v2', used: 1, limit: 2 });
    const call = p.calls[0];
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.auth).toBe('Bearer provider-key');
    expect(call.body.model).toBe('vision-model');
    expect(call.body.max_tokens).toBe(16000);
    expect(call.body.response_format).toEqual({ type: 'json_object' });
    const messages = call.body.messages as { role: string; content: unknown }[];
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'read it' },
    ]);
  });

  it('uses the cheaper model for sheet names when one is set', async () => {
    const p = provider('{"number":"A6.1"}');
    await handle(post('good', { task: 'sheet-name', prompt: 'name it', images: [] }), env({ AI_MODEL_SHEET_NAME: 'tiny-model' }), p.fetchFn);
    expect(p.calls[0].body.model).toBe('tiny-model');
  });

  it('stops each code at its daily limit, and everyone at the global limit', async () => {
    const e = env();
    const p = provider();
    expect((await handle(post('good'), e, p.fetchFn)).status).toBe(200);
    expect((await handle(post('good'), e, p.fetchFn)).status).toBe(200);
    const third = await handle(post('good'), e, p.fetchFn);
    expect(third.status).toBe(429);
    expect((await third.json()).error).toBe('daily_limit');
    expect((await handle(post('other'), e, p.fetchFn)).status).toBe(200);
    const global = await handle(post('other'), e, p.fetchFn);
    expect((await global.json()).error).toBe('global_limit');
    expect(p.calls).toHaveLength(3);
  });

  it('counts per UTC day', async () => {
    const e = env();
    const p = provider();
    const d1 = new Date('2026-10-16T12:00:00Z');
    const d2 = new Date('2026-10-17T12:00:00Z');
    await handle(post('good'), e, p.fetchFn, d1);
    await handle(post('good'), e, p.fetchFn, d1);
    expect((await handle(post('good'), e, p.fetchFn, d1)).status).toBe(429);
    expect((await handle(post('good'), e, p.fetchFn, d2)).status).toBe(200);
  });

  it('reports a code and its use on GET', async () => {
    const res = await handle(new Request('https://x/api/ai', { headers: { authorization: 'Bearer good' } }), env());
    expect(await res.json()).toEqual({ ok: true, name: 'Joe Drywall', used: 0, limit: 2, model: 'vision-model' });
  });

  it('refuses oversized or malformed requests before calling the model', async () => {
    const p = provider();
    const many = Array.from({ length: 9 }, () => 'AA');
    expect((await handle(post('good', { task: 'legend', prompt: 'x', images: many }), env(), p.fetchFn)).status).toBe(400);
    expect((await handle(post('good', { task: 'chat', prompt: 'x' }), env(), p.fetchFn)).status).toBe(400);
    expect((await handle(post('good', { task: 'legend', prompt: '' }), env(), p.fetchFn)).status).toBe(400);
    expect((await handle(post('good', { task: 'legend', prompt: 'x', maxTokens: 'many' }), env(), p.fetchFn)).status).toBe(400);
    expect((await handle(post('good', { task: 'legend', prompt: 'x', system: { length: 1 } }), env(), p.fetchFn)).status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });

  it('says so when the service has no model key yet', async () => {
    const res = await handle(post('good'), env({ AI_API_KEY: undefined }), provider().fetchFn);
    expect(res.status).toBe(503);
  });

  it('passes on provider errors as a 502 with the status', async () => {
    const res = await handle(post('good'), env(), provider('nope', 402).fetchFn);
    expect(res.status).toBe(502);
    expect((await res.json()).message).toContain('402');
  });

  it('does not leak provider error bodies', async () => {
    const fetchFn = (async () => new Response('internal provider credential details', { status: 500 })) as typeof fetch;
    const response = await handle(post('good'), env(), fetchFn);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('credential');
  });

  it('rejects non-finite token numbers from JSON', async () => {
    const p = provider();
    const request = new Request('https://app.test/api/ai', {
      method: 'POST', headers: { authorization: ['Bearer', 'good'].join(' ') },
      body: '{"task":"legend","prompt":"x","maxTokens":1e999}',
    });
    expect((await handle(request, env(), p.fetchFn)).status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });

  it('rejects oversized content-length before reading or parsing the request', async () => {
    const p = provider();
    const request = new Request('https://app.test/api/ai', {
      method: 'POST', headers: { authorization: ['Bearer', 'good'].join(' '), 'content-length': '28000001' },
      body: '{"task":"legend","prompt":"small"}',
    });
    expect((await handle(request, env(), p.fetchFn)).status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect(p.calls).toHaveLength(0);
  });

  it('enforces the streaming byte cap even without a content-length and cancels the body', async () => {
    const p = provider();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(28_000_001)); },
      cancel() { cancelled = true; },
    });
    const request = new Request('https://app.test/api/ai', {
      method: 'POST', headers: { authorization: ['Bearer', 'good'].join(' ') },
      body, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect((await handle(request, env(), p.fetchFn)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(p.calls).toHaveLength(0);
  });

  it('decodes UTF-8 across buffered stream boundaries', async () => {
    const p = provider();
    const prefix = '{"task":"legend","prompt":"';
    const prompt = 'x'.repeat(65_535 - prefix.length) + '工地';
    const bytes = new TextEncoder().encode(JSON.stringify({ task: 'legend', prompt }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 65_536));
        controller.enqueue(bytes.subarray(65_536));
        controller.close();
      },
    });
    const request = new Request('https://app.test/api/ai', {
      method: 'POST', headers: { authorization: ['Bearer', 'good'].join(' ') },
      body, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect((await handle(request, env(), p.fetchFn)).status).toBe(200);
    expect(JSON.stringify(p.calls[0].body)).toContain('工地');
  });

  it('can leave out JSON mode for models that reject it', async () => {
    const p = provider();
    await handle(post('good'), env({ AI_JSON_MODE: 'off' }), p.fetchFn);
    expect(p.calls[0].body.response_format).toBeUndefined();
  });
});

describe('reading the model answer', () => {
  it('takes plain JSON, fenced JSON or JSON inside a sentence', () => {
    expect(firstJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(firstJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(firstJsonObject('Here it is: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => firstJsonObject('no json here')).toThrow();
  });

  describe('company AI proxy', () => {
    const companyEnv = (over: Partial<Env> = {}) => env({
      SUPABASE_URL: 'https://company.supabase.co', SUPABASE_ANON_KEY: 'public-key',
      SUPABASE_SERVICE_ROLE_KEY: 'quota-secret', ...over,
    });

    describe('Pages AI company-only wrapper', () => {
      it('never enables standalone legacy access codes when company configuration is missing or partial', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        try {
          for (const config of [
            {}, { SUPABASE_URL: 'https://company.supabase.co' }, { SUPABASE_ANON_KEY: 'public-key' },
          ]) {
            expect((await pagesAi({ request: post('good'), env: env(config) })).status).toBe(503);
          }
          expect(fetchSpy).not.toHaveBeenCalled();
        } finally { fetchSpy.mockRestore(); }
      });

      it('requires live company authentication even when legacy codes remain configured', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
        try {
          const response = await pagesAi({
            request: post('good'),
            env: env({ SUPABASE_URL: 'https://company.supabase.co', SUPABASE_ANON_KEY: 'public-key' }),
          });
          expect(response.status).toBe(401);
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expect(fetchSpy.mock.calls[0][0]).toBe('https://company.supabase.co/auth/v1/user');
        } finally { fetchSpy.mockRestore(); }
      });
    });
    function companyBackend(options: { authStatus?: number; members?: unknown[]; quotaStatus?: number; allowed?: boolean; error?: string } = {}) {
      const calls: { url: string; init?: RequestInit }[] = [];
      const fetchFn = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-id', email: 'user@example.com' }, { status: options.authStatus ?? 200 });
        if (url.includes('/organization_members?')) return Response.json(options.members ?? [{ organization_id: 'org-id', role: 'member' }]);
        if (url.includes('/rpc/')) return Response.json({ allowed: options.allowed ?? true, used: 1, limit: 2, error: options.error }, { status: options.quotaStatus ?? 200 });
        return Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] });
      }) as typeof fetch;
      return { calls, fetchFn };
    }

    it('never falls back to access codes with full or partial Supabase config', async () => {
      const b = companyBackend({ authStatus: 401 });
      expect((await handle(post('good'), companyEnv(), b.fetchFn)).status).toBe(401);
      expect(b.calls).toHaveLength(1);
      expect((await handle(post('good'), env({ SUPABASE_URL: 'https://company.supabase.co' }), b.fetchFn)).status).toBe(503);
    });

    it('requires exactly one membership before any quota or provider call', async () => {
      const b = companyBackend({ members: [] });
      expect((await handle(post('user-jwt'), companyEnv(), b.fetchFn)).status).toBe(403);
      expect(b.calls).toHaveLength(2);
    });

    it('reserves a quota atomically using server credentials but authenticates using user credentials', async () => {
      const b = companyBackend();
      const response = await handle(post('user-jwt'), companyEnv(), b.fetchFn);
      expect(response.status).toBe(200);
      expect((await response.json()).used).toBe(1);
      expect(b.calls.map(c => c.url)).toEqual([
        'https://company.supabase.co/auth/v1/user',
        'https://company.supabase.co/rest/v1/organization_members?user_id=eq.user-id&select=organization_id,role&limit=2',
        'https://company.supabase.co/rest/v1/rpc/company_ai_quota',
        'https://openrouter.ai/api/v1/chat/completions',
      ]);
      expect(new Headers(b.calls[0].init!.headers).get('apikey')).toBe('public-key');
      expect(new Headers(b.calls[2].init!.headers).get('apikey')).toBe('quota-secret');
      expect(JSON.parse(b.calls[2].init!.body as string)).toEqual({
        p_user_id: 'user-id', p_user_limit: 2, p_org_limit: 100, p_global_limit: 3, p_consume: true,
      });
    });

    it('fails closed when atomic quota storage is absent or broken', async () => {
      for (const options of [{ quotaStatus: 404 }, { quotaStatus: 500 }]) {
        const b = companyBackend(options);
        expect((await handle(post('user-jwt'), companyEnv(), b.fetchFn)).status).toBe(503);
        expect(b.calls).toHaveLength(3);
      }
      const b = companyBackend();
      expect((await handle(post('user-jwt'), companyEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined }), b.fetchFn)).status).toBe(503);
      expect(b.calls).toHaveLength(2);
    });

    it('passes the configured company daily cap to the atomic reservation', async () => {
      const b = companyBackend();
      expect((await handle(post('user-jwt'), companyEnv({ ORG_DAILY_LIMIT: '7' }), b.fetchFn)).status).toBe(200);
      expect(JSON.parse(b.calls[2].init!.body as string).p_org_limit).toBe(7);
    });

    it('rejects exhausted organization quota before provider use and does not charge malformed requests', async () => {
      const b = companyBackend({ allowed: false, error: 'organization_limit' });
      const response = await handle(post('user-jwt'), companyEnv(), b.fetchFn);
      expect(response.status).toBe(429);
      expect((await response.json()).error).toBe('organization_limit');
      expect(b.calls).toHaveLength(3);
      const malformed = companyBackend();
      expect((await handle(post('user-jwt', { task: 'chat' }), companyEnv(), malformed.fetchFn)).status).toBe(400);
      expect(malformed.calls).toHaveLength(2);
    });

    it('reads usage without reserving on GET', async () => {
      const b = companyBackend();
      const response = await handle(new Request('https://app.test/api/ai', { headers: { authorization: ['Bearer', 'user-jwt'].join(' ') } }), companyEnv(), b.fetchFn);
      expect(await response.json()).toEqual({ ok: true, name: 'user@example.com', used: 1, limit: 2, model: 'vision-model' });
      expect(JSON.parse(b.calls[2].init!.body as string).p_consume).toBe(false);
    });
  });
});
