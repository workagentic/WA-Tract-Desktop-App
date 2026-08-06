import { app } from 'electron';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { SYNC_INTERVAL_MS } from '../shared/config';
import { getPendingTimeEntries, markTimeEntrySynced } from './local-db';
import { apiFetch, ApiError } from './api-client';
import type { SyncResult } from '../shared/types';

let syncTimer: NodeJS.Timeout | null = null;
let lastResult: SyncResult | null = null;
let syncInFlight = false;

function logSync(line: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'sync.log'), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // best-effort logging only
  }
}

export function getLastSyncResult(): SyncResult | null {
  return lastResult;
}

export async function runSyncCycle(): Promise<SyncResult> {
  if (syncInFlight) return lastResult ?? { attempted: 0, synced: 0 };
  syncInFlight = true;

  const pending = getPendingTimeEntries();
  if (pending.length === 0) {
    syncInFlight = false;
    lastResult = { attempted: 0, synced: 0 };
    return lastResult;
  }

  try {
    // The backend's SyncTimeEntriesDto expects a single batched
    // { entries: [...] } body (@ArrayMinSize(1)) — one call for everything
    // pending, not one call per entry.
    await apiFetch('/time-entries/sync', {
      method: 'POST',
      body: JSON.stringify({
        entries: pending.map((entry) => ({
          localId: entry.localId,
          taskId: Number(entry.taskId),
          employeeId: Number(entry.employeeId),
          startTime: entry.startTime,
          endTime: entry.endTime ?? undefined,
          durationSeconds: entry.durationSeconds,
          syncStatus: entry.syncStatus,
          lastHeartbeat: entry.lastHeartbeat ?? undefined,
        })),
      }),
    });
    for (const entry of pending) markTimeEntrySynced(entry.localId);
    lastResult = { attempted: pending.length, synced: pending.length };
    return lastResult;
  } catch (err) {
    const message = err instanceof ApiError ? err.message : String(err);
    logSync(`cycle failed: ${message}`);
    lastResult = { attempted: pending.length, synced: 0, error: message };
    return lastResult;
  } finally {
    syncInFlight = false;
  }
}

export function startSyncWorker(): void {
  stopSyncWorker();
  syncTimer = setInterval(() => {
    runSyncCycle().catch((err) => logSync(`cycle failed: ${err}`));
  }, SYNC_INTERVAL_MS);
}

export function stopSyncWorker(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
