import { net } from 'electron';
import { resolveApiBaseUrl } from './env';
import { loadTokens, saveTokens, clearTokens } from './token-store';
import { describeError } from './error-utils';
import type { ApiEnvelope } from '../shared/types';

// net.fetch() (Chromium's network stack, via Electron's `net` module) rather
// than the global fetch() (Node's undici) - undici only trusts Node's own
// bundled CA list, never the OS certificate store. Any network that does
// TLS/SSL inspection (a corporate security gateway transparently re-signing
// HTTPS with an internal root CA installed into Windows via Group Policy)
// trusts that CA at the OS level - curl.exe and browsers work fine - but
// Node's fetch() has never heard of it and fails certificate verification
// on every single request, surfacing as an opaque "TypeError: fetch
// failed" with no indication anything is TLS-related. net.fetch() reads
// the same OS trust store (and system proxy config) curl/browsers do.

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(cb: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(cb);
  return () => sessionExpiredListeners.delete(cb);
}

function notifySessionExpired(): void {
  for (const cb of sessionExpiredListeners) cb();
}

let refreshInFlight: Promise<boolean> | null = null;

/** Refreshes the access token if needed. Returns false (and clears tokens) only if the server rejects the refresh token itself (401/403). */
export async function ensureFreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const tokens = loadTokens();
    if (!tokens?.refreshToken) return false;

    try {
      const res = await net.fetch(`${resolveApiBaseUrl()}/auth/refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      // Only an explicit rejection of the refresh token means the session is dead. A 5xx, 429 or a proxy
      // error page says nothing about the token, so keep it and let the next cycle retry.
      if (res.status === 401 || res.status === 403) {
        clearTokens();
        notifySessionExpired();
        return false;
      }
      if (!res.ok) {
        console.warn(`[api-client] refresh got HTTP ${res.status}, keeping tokens for retry`);
        return true;
      }
      const body = (await res.json()) as ApiEnvelope<{ accessToken: string; refreshToken: string }>;
      saveTokens({ accessToken: body.data.accessToken, refreshToken: body.data.refreshToken });
      return true;
    } catch (err) {
      console.warn('[api-client] refresh failed:', describeError(err));
      // Network failure — keep the stale tokens; don't treat a transient
      // outage as "session expired".
      return true;
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const tokens = loadTokens();
  const headers = new Headers(init.headers);
  if (tokens?.accessToken) headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  let res = await net.fetch(`${resolveApiBaseUrl()}${path}`, { ...init, headers });

  if (res.status === 401) {
    const refreshed = await ensureFreshAccessToken();
    if (!refreshed) throw new ApiError(401, 'Session expired');
    const retryTokens = loadTokens();
    if (retryTokens?.accessToken) headers.set('Authorization', `Bearer ${retryTokens.accessToken}`);
    res = await net.fetch(`${resolveApiBaseUrl()}${path}`, { ...init, headers });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body || `Request failed with status ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  const body = (await res.json()) as ApiEnvelope<T>;
  return body.data;
}
