import { ipcMain } from 'electron';
import { apiFetch, ApiError } from './api-client';
import { resolveApiBaseUrl } from './env';
import { loadTokens, clearTokens } from './token-store';
import { decodeJwt } from './jwt';
import { startPairing, getPairingStatus, resetPairingState } from './pairing';
import { getCachedTasks, replaceTasksCache } from './local-db';
import {
  getSnapshot,
  startTimer,
  pauseTimer,
  resumeTimer,
  stopTimer,
  findUnresolvedTimer,
  resolveUnresolvedTimer,
} from './timer-service';
import { runSyncCycle, getLastSyncResult } from './sync-worker';
import type { PaginatedResult, TaskRecord } from '../shared/types';

export interface IpcDeps {
  closeTimerWidget: () => void;
  resizeTimerWidget: (width: number) => void;
  openTaskPicker: () => void;
  closeTaskPicker: () => void;
  onLogout: () => void;
}

/**
 * Every renderer -> main call is registered here via ipcMain.handle. The
 * renderer only ever sees these through preload's contextBridge — it never
 * gets direct access to ipcRenderer, Node, or Electron internals
 * (contextIsolation stays on, nodeIntegration stays off).
 */
export function registerIpcHandlers(deps: IpcDeps): void {
  // --- pairing -------------------------------------------------------------
  ipcMain.handle('pairing:start', async () => startPairing());
  ipcMain.handle('pairing:getStatus', async () => getPairingStatus());

  // --- auth ------------------------------------------------------------
  ipcMain.handle('auth:getEmployee', async () => {
    const tokens = loadTokens();
    if (!tokens?.accessToken) return null;
    return decodeJwt(tokens.accessToken);
  });
  ipcMain.handle('auth:logout', async () => {
    // A timer left running/paused across logout would otherwise leak into
    // the next employee's session: timer-service's activeLocalId is
    // process-wide, not per-employee, so startTimer() for whoever logs in
    // next would immediately throw ("a timer is already active") instead of
    // starting their task. Stopping it here — while the outgoing employee's
    // token is still valid — finalizes their entry with an endTime and
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
        // Non-fatal — see comment above.
      }
    }
    clearTokens();
    resetPairingState();
    deps.onLogout();
  });

  // --- tasks -----------------------------------------------------------
  ipcMain.handle('tasks:openPicker', async () => {
    deps.openTaskPicker();
  });
  ipcMain.handle('tasks:closePicker', async () => {
    deps.closeTaskPicker();
  });
  ipcMain.handle('tasks:list', async () => {
    const tokens = loadTokens();
    const departmentId = tokens?.accessToken ? decodeJwt(tokens.accessToken)?.departmentId : undefined;
    try {
      // limit=100 (the backend's max) rather than looping pages — this is a
      // single employee's task picker, not an admin-scale browser, so one
      // generously-sized page covers the realistic case.
      const params = new URLSearchParams({ limit: '100' });
      if (departmentId !== undefined && departmentId !== null) {
        params.set('departmentId', String(departmentId));
      }
      const page = await apiFetch<PaginatedResult<TaskRecord>>(`/tasks?${params.toString()}`);
      // The backend's Task.id is a numeric PK — coerced to a string here so
      // it actually matches the TaskRecord.id: string contract. Without this,
      // comparing it against a TimeEntryRecord.taskId (always a string, since
      // the local SQLite column is TEXT) silently fails: number 5 !== "5".
      const tasks = page.data.map((t) => ({
        ...t,
        id: String(t.id),
        client: t.client ? { ...t.client, id: String(t.client.id) } : null,
      }));
      replaceTasksCache(tasks);
      return tasks;
    } catch (err) {
      // Network/API failure -> fall back to whatever we cached last, per spec,
      // so the picker still renders something useful offline.
      console.warn('[ipc] tasks:list falling back to local cache', err instanceof ApiError ? err.status : err);
      return getCachedTasks();
    }
  });

  // --- timer -----------------------------------------------------------
  ipcMain.handle('timer:getActive', async () => getSnapshot());
  ipcMain.handle('timer:start', async (_evt, taskId: string) => startTimer(taskId));
  ipcMain.handle('timer:pause', async () => pauseTimer());
  ipcMain.handle('timer:resume', async () => resumeTimer());
  ipcMain.handle('timer:stop', async () => stopTimer());
  ipcMain.handle('timer:closeWidget', async () => {
    deps.closeTimerWidget();
  });
  ipcMain.handle('timer:resizeWidget', async (_evt, width: number) => {
    deps.resizeTimerWidget(width);
  });
  ipcMain.handle('timer:getUnresolved', async () => findUnresolvedTimer());
  ipcMain.handle('timer:resolveUnresolved', async (_evt, action: 'resume' | 'stop') =>
    resolveUnresolvedTimer(action),
  );

  // --- sync --------------------------------------------------------------
  ipcMain.handle('sync:getStatus', async () => getLastSyncResult());
  ipcMain.handle('sync:syncNow', async () => runSyncCycle());

  // --- app -----------------------------------------------------------
  ipcMain.handle('app:getApiBaseUrl', async () => resolveApiBaseUrl());
}

export function unregisterIpcHandlers(): void {
  const channels = [
    'pairing:start',
    'pairing:getStatus',
    'auth:getEmployee',
    'auth:logout',
    'tasks:openPicker',
    'tasks:closePicker',
    'tasks:list',
    'timer:getActive',
    'timer:start',
    'timer:pause',
    'timer:resume',
    'timer:stop',
    'timer:closeWidget',
    'timer:resizeWidget',
    'timer:getUnresolved',
    'timer:resolveUnresolved',
    'sync:getStatus',
    'sync:syncNow',
    'app:getApiBaseUrl',
  ];
  for (const channel of channels) ipcMain.removeHandler(channel);
}
