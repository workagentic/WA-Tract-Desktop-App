import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, PairingStatus, TimerSnapshot } from '../shared/types';

/**
 * The ONLY surface the renderer gets. contextIsolation is on and
 * nodeIntegration is off (see main.ts BrowserWindow webPreferences), so the
 * renderer has zero direct access to ipcRenderer, Node, or fs — everything
 * goes through the narrow, typed `window.api` object below.
 */
const bridge: DesktopBridge = {
  pairing: {
    start: () => ipcRenderer.invoke('pairing:start'),
    getStatus: () => ipcRenderer.invoke('pairing:getStatus'),
    onStatusChange: (cb: (status: PairingStatus) => void) => {
      const listener = (_event: unknown, status: PairingStatus) => cb(status);
      ipcRenderer.on('pairing:status-changed', listener);
      return () => ipcRenderer.removeListener('pairing:status-changed', listener);
    },
  },
  auth: {
    getEmployee: () => ipcRenderer.invoke('auth:getEmployee'),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    openPicker: () => ipcRenderer.invoke('tasks:openPicker'),
    closePicker: () => ipcRenderer.invoke('tasks:closePicker'),
  },
  timer: {
    getActive: () => ipcRenderer.invoke('timer:getActive'),
    start: (taskId: string) => ipcRenderer.invoke('timer:start', taskId),
    pause: () => ipcRenderer.invoke('timer:pause'),
    resume: () => ipcRenderer.invoke('timer:resume'),
    stop: () => ipcRenderer.invoke('timer:stop'),
    closeWidget: () => ipcRenderer.invoke('timer:closeWidget'),
    resizeWidget: (width: number) => ipcRenderer.invoke('timer:resizeWidget', width),
    getUnresolved: () => ipcRenderer.invoke('timer:getUnresolved'),
    resolveUnresolved: (action: 'resume' | 'stop') => ipcRenderer.invoke('timer:resolveUnresolved', action),
    onTick: (cb: (snapshot: TimerSnapshot) => void) => {
      const listener = (_event: unknown, snapshot: TimerSnapshot) => cb(snapshot);
      ipcRenderer.on('timer:tick', listener);
      return () => ipcRenderer.removeListener('timer:tick', listener);
    },
  },
  sync: {
    getStatus: () => ipcRenderer.invoke('sync:getStatus'),
    syncNow: () => ipcRenderer.invoke('sync:syncNow'),
  },
  app: {
    getApiBaseUrl: () => ipcRenderer.invoke('app:getApiBaseUrl'),
  },
};

contextBridge.exposeInMainWorld('api', bridge);
