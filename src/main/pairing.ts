import { app } from 'electron';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { resolveApiBaseUrl } from './env';
import { saveTokens } from './token-store';
import type { PairingStatus } from '../shared/types';

type StatusListener = (status: PairingStatus) => void;
const listeners = new Set<StatusListener>();

let status: PairingStatus = { state: 'idle' };
let currentGeneration = 0;
let pollTimer: NodeJS.Timeout | null = null;

function logPairing(line: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'pairing.log'), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // best-effort logging only
  }
}

function setStatus(next: PairingStatus): void {
  status = next;
  logPairing(`status -> ${JSON.stringify(next)} (listeners: ${listeners.size})`);
  for (const cb of listeners) cb(next);
}

export function getPairingStatus(): PairingStatus {
  return status;
}

export function onPairingStatusChange(cb: StatusListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function resetPairingState(): void {
  currentGeneration += 1;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  status = { state: 'idle' };
}

/** Requests a device code, then polls /auth/pairing/token until the web portal confirms it (or it expires). */
export async function startPairing(): Promise<PairingStatus> {
  const generation = ++currentGeneration;

  try {
    const res = await fetch(`${resolveApiBaseUrl()}/auth/pairing/device-code`, { method: 'POST' });
    if (!res.ok) throw new Error(`device-code request failed: ${res.status}`);
    const data: { userCode: string; deviceCode: string; expiresAt: string; pollIntervalSeconds: number } =
      await res.json();

    setStatus({
      state: 'awaiting_confirmation',
      userCode: data.userCode,
      expiresAt: data.expiresAt,
      pollIntervalSeconds: data.pollIntervalSeconds,
    });

    poll(data.deviceCode, data.pollIntervalSeconds * 1000, generation);
  } catch (err) {
    setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
  }

  return status;
}

function poll(deviceCode: string, intervalMs: number, generation: number): void {
  let consecutiveErrors = 0;

  const tick = async () => {
    if (generation !== currentGeneration) return; // superseded by a newer pairing attempt

    try {
      const res = await fetch(`${resolveApiBaseUrl()}/auth/pairing/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });

      if (res.status === 201) {
        const data = await res.json();
        saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        logPairing(`gen=${generation} current=${generation === currentGeneration} deviceCode=${deviceCode.slice(0, 8)}... result=success`);
        setStatus({ state: 'paired' });
        return;
      }

      if (res.status === 410) {
        setStatus({ state: 'error', message: 'Pairing code expired' });
        return;
      }

      // 428 (authorization_pending) / 429 (slow_down) — keep polling.
      logPairing(`gen=${generation} current=${generation === currentGeneration} deviceCode=${deviceCode.slice(0, 8)}... result=pending`);
      consecutiveErrors = 0;
      pollTimer = setTimeout(tick, intervalMs);
    } catch (err) {
      // A transient network blip while polling isn't itself fatal —
      // keep retrying at the current interval. But if it's persistent,
      // silently retrying forever leaves the user staring at a dead/expired
      // code with no feedback. Surface it after a few failures instead of
      // hiding it.
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        setStatus({ state: 'error', message: `Can't reach the WA Track server: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      pollTimer = setTimeout(tick, intervalMs);
    }
  };

  pollTimer = setTimeout(tick, intervalMs);
}
