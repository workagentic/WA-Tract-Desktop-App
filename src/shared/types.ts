/** Shared types between main and renderer processes (via preload bridge). */

export interface DeviceCodeResponse {
  userCode: string;
  deviceCode: string;
  expiresAt: string;
  pollIntervalSeconds: number;
}

export interface PairingTokenSuccess {
  accessToken: string;
  refreshToken: string;
  deviceSessionId: string;
}

export type PairingStatus =
  | { state: 'idle' }
  | { state: 'awaiting_confirmation'; userCode: string; expiresAt: string; pollIntervalSeconds: number }
  | { state: 'paired' }
  | { state: 'error'; message: string };

export interface JwtPayload {
  sub: string; // employeeId
  email: string;
  fullName: string;
  role: string;
  departmentId: string;
  iat: number;
  exp: number;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dueDate: string | null;
}

export interface TimeEntryRecord {
  localId: string;
  taskId: string;
  employeeId: string;
  startTime: string;
  endTime: string | null;
  durationSeconds: number;
  syncStatus: 'pending' | 'synced' | 'recovered';
  lastHeartbeat: string | null;
}

export interface TimerSnapshot {
  entry: TimeEntryRecord | null;
  /** true if the timer is currently counting (running, not paused) */
  running: boolean;
}

export interface UnresolvedTimerInfo {
  entry: TimeEntryRecord;
  task: TaskRecord | null;
}

export interface SyncResult {
  attempted: number;
  synced: number;
  error?: string;
}

/** The API surface exposed to the renderer via contextBridge. */
export interface DesktopBridge {
  pairing: {
    start: () => Promise<PairingStatus>;
    getStatus: () => Promise<PairingStatus>;
    onStatusChange: (cb: (status: PairingStatus) => void) => () => void;
  };
  auth: {
    getEmployee: () => Promise<JwtPayload | null>;
    logout: () => Promise<void>;
  };
  tasks: {
    list: () => Promise<TaskRecord[]>;
    openPicker: () => Promise<void>;
    closePicker: () => Promise<void>;
  };
  timer: {
    getActive: () => Promise<TimerSnapshot>;
    start: (taskId: string) => Promise<TimeEntryRecord>;
    pause: () => Promise<TimeEntryRecord | null>;
    resume: () => Promise<TimeEntryRecord | null>;
    stop: () => Promise<TimeEntryRecord | null>;
    closeWidget: () => Promise<void>;
    resizeWidget: (width: number) => Promise<void>;
    getUnresolved: () => Promise<UnresolvedTimerInfo | null>;
    resolveUnresolved: (action: 'resume' | 'stop') => Promise<void>;
    onTick: (cb: (snapshot: TimerSnapshot) => void) => () => void;
  };
  sync: {
    getStatus: () => Promise<SyncResult | null>;
    syncNow: () => Promise<SyncResult>;
  };
  app: {
    getApiBaseUrl: () => Promise<string>;
  };
}

declare global {
  interface Window {
    api: DesktopBridge;
  }
}
