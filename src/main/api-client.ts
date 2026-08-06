import { resolveApiBaseUrl } from './env';
import { loadTokens, saveTokens, clearTokens } from './token-store';

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

/** Refreshes the access token if needed. Returns false (and clears tokens) only if the refresh token itself is dead. */
export async function ensureFreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const tokens = loadTokens();
    if (!tokens?.refreshToken) return false;

    try {
      const res = await fetch(`${resolveApiBaseUrl()}/auth/refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      if (!res.ok) {
        clearTokens();
        notifySessionExpired();
        return false;
      }
      const data = await res.json();
      saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      return true;
    } catch (err) {
      console.warn('[api-client] refresh failed', err);
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

  let res = await fetch(`${resolveApiBaseUrl()}${path}`, { ...init, headers });

  if (res.status === 401) {
    const refreshed = await ensureFreshAccessToken();
    if (!refreshed) throw new ApiError(401, 'Session expired');
    const retryTokens = loadTokens();
    if (retryTokens?.accessToken) headers.set('Authorization', `Bearer ${retryTokens.accessToken}`);
    res = await fetch(`${resolveApiBaseUrl()}${path}`, { ...init, headers });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body || `Request failed with status ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
