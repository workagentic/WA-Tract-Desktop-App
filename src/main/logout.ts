import { apiFetch } from './api-client';
import { clearTokens } from './token-store';
import { resetPairingState } from './pairing';
import { getSnapshot, stopTimer } from './timer-service';
import { runSyncCycle } from './sync-worker';

/**
 * Signs the current employee out of this device: finalizes their timer, revokes the device session on the
 * server, then forgets the local login. Callers still tear down the windows afterwards (main.ts handleLogout).
 */
export async function signOut(): Promise<void> {
  // A timer left running/paused across logout would otherwise leak into
  // the next employee's session: timer-service's activeLocalId is
  // process-wide, not per-employee, so startTimer() for whoever logs in
  // next would immediately throw ("a timer is already active") instead of
  // starting their task. Stopping it here - while the outgoing employee's
  // token is still valid - finalizes their entry with an endTime and
  // clears activeLocalId before the next login can ever see it. The sync
  // attempt is best-effort, same as switchToTask()'s pattern; if it fails
  // the entry just stays 'pending' in the local cache for the background
  // worker to retry (it will fail to attribute to whoever logs in next,
  // since the backend rejects a mismatched employeeId, so it's safely
  // stuck rather than misattributed).
  if (getSnapshot().entry) {
    stopTimer();
    try {
      await runSyncCycle();
    } catch {
      // Non-fatal - see comment above.
    }
  }
  // Revoke the device session so its refresh token can't be used again. Best-effort: logout must still work
  // offline (HR can revoke the device from the Devices page in that case).
  try {
    await apiFetch<void>('/auth/logout', { method: 'POST' });
  } catch {
    // Non-fatal - see comment above.
  }
  clearTokens();
  resetPairingState();
}
