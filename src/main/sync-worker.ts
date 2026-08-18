import { app } from 'electron';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { SYNC_INTERVAL_MS } from '../shared/config';
import { getPendingTimeEntries, markTimeEntrySynced } from './local-db';
import { apiFetch, ApiError } from './api-client';
import { currentEmployeeId } from './timer-service';
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

  // local-db's time_entries cache is a single shared table, not scoped per
  // employee — on a shared machine, a previous employee's session can leave
  // rows behind that never got synced (e.g. the app was closed offline).
  // The backend rejects a MANAGER/EMPLOYEE token syncing someone else's
  // entry (ForbiddenException), and since this used to be one all-or-nothing
  // batched call, a single leftover foreign entry permanently blocked every
  // other pending entry in the same batch from ever syncing — including the
  // current employee's own. Filtering to the currently authenticated
  // employee here means the batch we actually send can never contain a
  // foreign entry in the first place; whoever those leftover rows belong to
  // will sync them correctly next time they log in.
  const employeeId = currentEmployeeId();
  const allPending = getPendingTimeEntries();
  // Number(...) on both sides, not string comparison: entry.employeeId comes
  // back from SQLite's TEXT-affinity employee_id column (which can mangle a
  // bound number into e.g. "2.0"), while employeeId here is the raw numeric
  // value decoded straight off the JWT's `sub` claim — never actually the
  // same JS type as entry.employeeId despite both being declared `string` in
  // shared/types.ts (a type declaration neither value's runtime shape
  // matches). A strict `===` between them is always false.
  const pending = employeeId
    ? allPending.filter((entry) => Number(entry.employeeId) === Number(employeeId))
    : [];

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
