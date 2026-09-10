/** Shared types between main and renderer processes (via preload bridge). */

/** Every backend response is wrapped in this envelope by its global ResponseInterceptor. */
export interface ApiEnvelope<T> {
  statusCode: number;
  message: string;
  data: T;
}

/** Shape of `data` for every paginated list endpoint (tasks, clients, etc). */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

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

export interface ClientRecord {
  id: string;
  name: string;
  description: string | null;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  /** @deprecated Removed from the backend — kept optional only for old cached rows. */
  status?: string;
  /** @deprecated Removed from the backend — kept optional only for old cached rows. */
  dueDate?: string | null;
  client: ClientRecord | null;
  /**
   * The parent task's id, or null for a top-level task. tasks:list (see
   * ipc-handlers.ts) walks GET /tasks/:id/subtasks itself at every depth and
   * stamps this on the way down — the backend's own list endpoints don't
   * include it directly. Old cached rows from before this field existed read
   * back as undefined, which the picker treats the same as null (top-level).
   */
  parentId: string | null;
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
  /**
   * Resolved from the local task cache (or passed in directly by
   * startTimer() at pick-time) — never from a network call. This is what
   * lets the widget show the task name immediately instead of waiting on a
   * tasks:list() round trip (see timer-service.ts).
   */
  taskTitle: string | null;
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
    /** taskTitle is the already-known title from the picker's own click - see timer-service.ts's startTimer(). */
    start: (taskId: string, taskTitle?: string | null) => Promise<TimeEntryRecord>;
    pause: () => Promise<TimeEntryRecord | null>;
    resume: () => Promise<TimeEntryRecord | null>;
    stop: () => Promise<TimeEntryRecord | null>;
    closeWidget: () => Promise<void>;
    resizeWidget: (width: number, height?: number) => Promise<void>;
    /** Manual drag trio — see main.ts's startTimerBarDrag/stepTimerBarDrag/endTimerBarDrag for why this isn't -webkit-app-region: drag. */
    dragStart: () => Promise<void>;
    dragStep: () => Promise<void>;
    dragEnd: () => Promise<void>;
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
    getVersion: () => Promise<string>;
  };
}

declare global {
  interface Window {
    api: DesktopBridge;
  }
}
