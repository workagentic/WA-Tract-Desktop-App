import { randomUUID } from 'crypto';
import { powerMonitor } from 'electron';
import { HEARTBEAT_INTERVAL_MS } from '../shared/config';
import {
  getTimeEntry,
  getOpenTimeEntry,
  insertTimeEntry,
  updateTimeEntry,
  getCachedTasks,
} from './local-db';
import { loadTokens } from './token-store';
import { decodeJwt } from './jwt';
import type { TimeEntryRecord, TimerSnapshot, UnresolvedTimerInfo } from '../shared/types';

type TickListener = (snapshot: TimerSnapshot) => void;
const tickListeners = new Set<TickListener>();

// Fires when a suspend- or lock-triggered auto-pause has just resumed on
// wake/unlock — lets main.ts show a "timer resumed" confirmation notification.
type TimerResumedListener = (taskId: string | null) => void;
const timerResumedListeners = new Set<TimerResumedListener>();

let activeLocalId: string | null = null;
let running = false;
let segmentStartMs: number | null = null;
let baseDurationSeconds = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;
// Set only when suspend or lock-screen itself pauses a running timer —
// distinguishes "auto-paused, waiting for wake/unlock to resume it" from a
// manual pause, so resume/unlock-screen only resumes+notifies for the case
// it's meant for. Windows commonly fires both suspend+lock-screen together
// on lid-close (and both resume+unlock-screen together on lid-open) — this
// being a single flag (not per-trigger) means whichever of the two resume
// events arrives first resumes it and clears the flag, and the second one is
// then a no-op instead of double-resuming.
let autoPausedPending = false;

export function currentEmployeeId(): string | null {
  const tokens = loadTokens();
  if (!tokens?.accessToken) return null;
  return decodeJwt(tokens.accessToken)?.sub ?? null;
}

function currentDurationSeconds(): number {
  if (!running || segmentStartMs === null) return baseDurationSeconds;
  return baseDurationSeconds + Math.floor((Date.now() - segmentStartMs) / 1000);
}

function persistCurrentDuration(): void {
  if (!activeLocalId) return;
  updateTimeEntry(activeLocalId, {
    durationSeconds: currentDurationSeconds(),
    lastHeartbeat: new Date().toISOString(),
  });
}

function notifyTick(): void {
  const snapshot = getSnapshot();
  for (const listener of tickListeners) listener(snapshot);
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    persistCurrentDuration();
    notifyTick();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function onTimerTick(cb: TickListener): () => void {
  tickListeners.add(cb);
  return () => tickListeners.delete(cb);
}

/** Fires once, on wake/unlock, only when the timer running before was paused by suspend/lock-screen — never for a manual pause. */
export function onTimerResumed(cb: TimerResumedListener): () => void {
  timerResumedListeners.add(cb);
  return () => timerResumedListeners.delete(cb);
}

export function getSnapshot(): TimerSnapshot {
  if (!activeLocalId) return { entry: null, running: false };
  const entry = getTimeEntry(activeLocalId);
  if (!entry) return { entry: null, running: false };
  return { entry: { ...entry, durationSeconds: currentDurationSeconds() }, running };
}

export function startTimer(taskId: string): TimeEntryRecord {
  if (activeLocalId) {
    throw new Error('timer-service: a timer is already active; stop it before starting a new one');
  }
  const employeeId = currentEmployeeId();
  if (!employeeId) throw new Error('timer-service: no authenticated employee');

  const localId = randomUUID();
  const nowIso = new Date().toISOString();
  const entry: TimeEntryRecord = {
    localId,
    taskId,
    employeeId,
    startTime: nowIso,
    endTime: null,
    durationSeconds: 0,
    syncStatus: 'pending',
    lastHeartbeat: nowIso,
  };
  insertTimeEntry(entry); // synchronous, crash-safe write

  activeLocalId = localId;
  running = true;
  segmentStartMs = Date.now();
  baseDurationSeconds = 0;
  startHeartbeat();
  notifyTick();
  return entry;
}

export function pauseTimer(): TimeEntryRecord | null {
  if (!activeLocalId || !running) return activeLocalId ? getTimeEntry(activeLocalId) : null;
  baseDurationSeconds = currentDurationSeconds();
  running = false;
  segmentStartMs = null;
  persistCurrentDuration();
  stopHeartbeat();
  notifyTick();
  return getTimeEntry(activeLocalId);
}

export function resumeTimer(): TimeEntryRecord | null {
  if (!activeLocalId || running) return activeLocalId ? getTimeEntry(activeLocalId) : null;
  running = true;
  segmentStartMs = Date.now();
  persistCurrentDuration();
  startHeartbeat();
  notifyTick();
  return getTimeEntry(activeLocalId);
}

export function stopTimer(): TimeEntryRecord | null {
  if (!activeLocalId) return null;
  updateTimeEntry(activeLocalId, {
    durationSeconds: currentDurationSeconds(),
    endTime: new Date().toISOString(),
    // Force one more sync after stopping — while it was running this entry
    // may already have been marked 'synced' by an earlier cycle (it's kept
    // re-syncing via end_time IS NULL, not sync_status), so without this the
    // final duration/endTime update would never get picked up again.
    syncStatus: 'pending',
  });
  stopHeartbeat();
  const finalEntry = getTimeEntry(activeLocalId);
  activeLocalId = null;
  running = false;
  segmentStartMs = null;
  baseDurationSeconds = 0;
  notifyTick();
  return finalEntry;
}

// ---------------------------------------------------------------------------
// Crash recovery: an "open" entry (end_time null) with no in-memory
// activeLocalId means the app crashed (or was force-quit) while a timer was
// running/paused. We never silently discard it — surface it to the renderer
// as "resume or stop?".
// ---------------------------------------------------------------------------

export function findUnresolvedTimer(): UnresolvedTimerInfo | null {
  if (activeLocalId) return null;
  const open = getOpenTimeEntry();
  if (!open) return null;
  const task = getCachedTasks().find((t) => t.id === open.taskId) ?? null;
  return { entry: open, task };
}

/** Adopts a crash-recovered open entry as the active timer, in "paused" state, without touching duration. */
export function adoptUnresolvedAsActive(entry: TimeEntryRecord): void {
  activeLocalId = entry.localId;
  running = false;
  segmentStartMs = null;
  baseDurationSeconds = entry.durationSeconds;
}

export function resolveUnresolvedTimer(action: 'resume' | 'stop'): void {
  const open = getOpenTimeEntry();
  if (!open) return;
  if (action === 'stop') {
    updateTimeEntry(open.localId, { endTime: new Date().toISOString() });
    notifyTick();
    return;
  }
  adoptUnresolvedAsActive(open);
  startHeartbeat();
  notifyTick();
}

export function hasActiveTimer(): boolean {
  return activeLocalId !== null;
}

/**
 * Runs on real wake (lid-open) or unlock. No-op unless a suspend or
 * lock-screen actually auto-paused the timer (autoPausedPending) — e.g. a
 * wake/unlock with nothing running, or the second of a suspend+lock-screen
 * pair that fired together on lid-close (the first already resumed it and
 * cleared the flag — see wireSystemSleepHandling's comment).
 */
function handleAutoPauseEnd(): void {
  if (!autoPausedPending) {
    notifyTick();
    return;
  }
  autoPausedPending = false;
  const entry = resumeTimer(); // resumeTimer() already calls notifyTick()
  const taskId = entry?.taskId ?? null;
  for (const cb of timerResumedListeners) cb(taskId);
}

/**
 * Real sleep (suspend/lid-close) and Windows+L (lock-screen) both pause the
 * running timer immediately, and both resume it immediately — on lid-open
 * and on unlock respectively — with a "timer resumed" confirmation. Windows
 * commonly fires lock-screen right alongside suspend on lid-close (and
 * unlock-screen alongside resume on lid-open); autoPausedPending is a single
 * flag rather than one per trigger so whichever resume event arrives first
 * does the actual resuming and the other is a no-op, instead of double-
 * resuming or firing the notification twice.
 */
export function wireSystemSleepHandling(): void {
  powerMonitor.on('suspend', () => {
    if (activeLocalId && running) {
      pauseTimer();
      autoPausedPending = true;
    }
  });

  powerMonitor.on('resume', handleAutoPauseEnd);

  powerMonitor.on('lock-screen', () => {
    if (activeLocalId && running) {
      pauseTimer();
      autoPausedPending = true;
    }
  });

  powerMonitor.on('unlock-screen', handleAutoPauseEnd);
}
