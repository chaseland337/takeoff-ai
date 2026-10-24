/**
 * The hosted web app's AI route: requests go to this site's own /api/ai with the user's
 * access code, and the server picks the model and holds its key. Only builds made with
 * `npm run build:web` (VITE_AI_SERVICE=1) use it; the desktop app and local runs don't.
 */

import { accessToken, currentMembership } from '../webAuth';
export const serviceBuild = import.meta.env.VITE_AI_SERVICE === '1';
const URL_PATH: string = serviceBuild ? '/api/ai' : import.meta.env.VITE_AI_SERVICE_URL || 'api/ai';
const CODE_STORAGE = 'takeoff-ai:access-code';

export function getAccessCode(): string | null {
  try {
    return localStorage.getItem(CODE_STORAGE);
  } catch {
    return null;
  }
}

export function setAccessCode(code: string | null): void {
  try {
    if (code) localStorage.setItem(CODE_STORAGE, code);
    else localStorage.removeItem(CODE_STORAGE);
  } catch {
    // Storage unavailable (private window); the code just won't be remembered.
  }
}

export const serviceReady = () => serviceBuild && !!currentMembership();

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AccessInfo {
  name: string;
  used: number;
  limit: number;
  model: string | null;
}

async function call(method: 'GET' | 'POST', code: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  if (serviceBuild) code = await accessToken();
  let res: Response;
  try {
    res = await fetch(URL_PATH, {
      method,
      signal,
      headers: { authorization: `Bearer ${code}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ServiceError('offline', 'Could not reach the AI service. Check your internet connection.');
  }
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) throw new ServiceError(data?.error ?? 'error', data?.message ?? `The AI service returned an error (${res.status}).`);
  return data;
}

/** Checks a code and returns who it belongs to and today's use. */
export async function checkAccess(code = ''): Promise<AccessInfo> {
  return (await call('GET', code)) as AccessInfo;
}

/** The first JSON object in a model's answer (some wrap it in ``` fences or a sentence). */
export function firstJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the first {...} block
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ServiceError('invalid_json', 'The AI answer could not be read. Try again.');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ServiceError('invalid_json', 'The AI answer could not be read. Try again.');
  }
}

/** Sends one request and returns the JSON object the model answered with. */
export async function askService<T>(
  request: { task: 'legend' | 'sheet-name'; system?: string; prompt: string; images: string[]; maxTokens?: number },
  signal?: AbortSignal,
): Promise<{ json: T; model: string; used: number; limit: number }> {
  const code = serviceBuild ? await accessToken() : getAccessCode();
  if (!code) throw new ServiceError('session', 'Sign in to use company AI.');
  const res = (await call('POST', code, request, signal)) as { text: string; model: string; used: number; limit: number };
  return { json: firstJsonObject(res.text) as T, model: res.model, used: res.used, limit: res.limit };
}

export async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
