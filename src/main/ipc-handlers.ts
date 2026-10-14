import { app, ipcMain } from 'electron';
import { apiFetch, ApiError } from './api-client';
import { resolveApiBaseUrl } from './env';
import { loadTokens } from './token-store';
import { signOut } from './logout';
import { decodeJwt } from './jwt';
import { startPairing, getPairingStatus } from './pairing';
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
  resizeTimerWidget: (width: number, height?: number) => void;
  openTaskPicker: () => void;
  closeTaskPicker: () => void;
  onLogout: () => void;
  dragTimerBarStart: () => void;
  dragTimerBarStep: () => void;
  dragTimerBarEnd: () => void;
}

/**
 * Every renderer -> main call is registered here via ipcMain.handle. The
 * renderer only ever sees these through preload's contextBridge — it never
 * gets direct access to ipcRenderer, Node, or Electron internals
 * (contextIsolation stays on, nodeIntegration stays off).
 */
/**
 * The backend caps a page at 100 and sorts newest first, so a single request silently drops the oldest
 * tasks once a department has more than 100 - they must be paged through.
 */
async function fetchAllPages<T>(path: string, baseParams = new URLSearchParams()): Promise<T[]> {
  const PAGE_SIZE = 100;
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams(baseParams);
    params.set('limit', String(PAGE_SIZE));
    params.set('page', String(page));
    const res = await apiFetch<PaginatedResult<T>>(`${path}?${params.toString()}`);
    all.push(...res.data);
    if (res.data.length < PAGE_SIZE || all.length >= res.total) return all;
  }
}

function cachedDescendantsOf(rootId: string): TaskRecord[] {
  const cached = getCachedTasks();
  const found: TaskRecord[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const t of cached) {
      if (t.parentId === parentId) {
        found.push(t);
        queue.push(t.id);
      }
    }
  }
  return found;
}

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
    await signOut();
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
      const params = new URLSearchParams();
      if (departmentId !== undefined && departmentId !== null) {
        params.set('departmentId', String(departmentId));
      }
      const topLevelTasks = await fetchAllPages<TaskRecord>('/tasks', params);
      // The backend's Task.id is a numeric PK — coerced to a string here so
      // it actually matches the TaskRecord.id: string contract. Without this,
      // comparing it against a TimeEntryRecord.taskId (always a string, since
      // the local SQLite column is TEXT) silently fails: number 5 !== "5".
      const topLevel = topLevelTasks.map((t) => ({
        ...t,
        id: String(t.id),
        parentId: null,
        client: t.client ? { ...t.client, id: String(t.client.id) } : null,
      }));
      // GET /tasks only ever returns top-level tasks (no subtasks mixed in —
      // same as the web app's tree), so the picker has to walk
      // GET /tasks/:id/subtasks itself, at every depth, to see anything below
      // that. Each parent's own children fetch is independent of its
      // siblings', so siblings run in parallel; depth-first recursion is
      // still sequential (a task's children can't be requested before its id
      // is known), but that's normally only 2-3 levels deep in practice.
      const tasks: TaskRecord[] = [...topLevel];
      async function fetchChildrenOf(parent: TaskRecord): Promise<void> {
        let children: TaskRecord[];
        try {
          children = (await fetchAllPages<TaskRecord>(`/tasks/${parent.id}/subtasks`)).map((t) => ({
            ...t,
            id: String(t.id),
            parentId: parent.id,
            client: t.client ? { ...t.client, id: String(t.client.id) } : null,
          }));
        } catch (err) {
          // One parent's failed children fetch must not throw away the whole fresh list (that would drop every
          // newly created task until the next fully successful load) - keep just this branch from the cache.
          console.warn(`[ipc] subtasks of ${parent.id} failed, using cached branch`, err instanceof ApiError ? err.status : err);
          tasks.push(...cachedDescendantsOf(parent.id));
          return;
        }
        tasks.push(...children);
        await Promise.all(children.map(fetchChildrenOf));
      }
      await Promise.all(topLevel.map(fetchChildrenOf));

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
  ipcMain.handle('timer:start', async (_evt, taskId: string, taskTitle?: string | null) =>
    startTimer(taskId, taskTitle),
  );
  ipcMain.handle('timer:pause', async () => pauseTimer());
  ipcMain.handle('timer:resume', async () => resumeTimer());
  ipcMain.handle('timer:stop', async () => stopTimer());
  ipcMain.handle('timer:closeWidget', async () => {
    deps.closeTimerWidget();
  });
  ipcMain.handle('timer:resizeWidget', async (_evt, width: number, height?: number) => {
    deps.resizeTimerWidget(width, height);
  });
  ipcMain.handle('timer:dragStart', async () => deps.dragTimerBarStart());
  ipcMain.handle('timer:dragStep', async () => deps.dragTimerBarStep());
  ipcMain.handle('timer:dragEnd', async () => deps.dragTimerBarEnd());
  ipcMain.handle('timer:getUnresolved', async () => findUnresolvedTimer());
  ipcMain.handle('timer:resolveUnresolved', async (_evt, action: 'resume' | 'stop') =>
    resolveUnresolvedTimer(action),
  );

  // --- sync --------------------------------------------------------------
  ipcMain.handle('sync:getStatus', async () => getLastSyncResult());
  ipcMain.handle('sync:syncNow', async () => runSyncCycle());

  // --- app -----------------------------------------------------------
  ipcMain.handle('app:getApiBaseUrl', async () => resolveApiBaseUrl());
  ipcMain.handle('app:getVersion', async () => app.getVersion());
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
    'timer:dragStart',
    'timer:dragStep',
    'timer:dragEnd',
    'timer:getUnresolved',
    'timer:resolveUnresolved',
    'sync:getStatus',
    'sync:syncNow',
    'app:getApiBaseUrl',
    'app:getVersion',
  ];
  for (const channel of channels) ipcMain.removeHandler(channel);
}
