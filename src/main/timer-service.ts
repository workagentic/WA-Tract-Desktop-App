import { randomUUID } from 'crypto';
import { powerMonitor } from 'electron';
import { AUTO_PAUSE_DELAY_MS, AUTO_RESUME_DELAY_MS, HEARTBEAT_INTERVAL_MS } from '../shared/config';
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
// Scheduled on suspend/lock-screen; fires the actual auto-pause after
// AUTO_PAUSE_DELAY_MS unless the session is restored first. Windows commonly
// fires both suspend+lock-screen together on lid-close — a single timeout
// (not one per trigger) means the second of the pair is a no-op (see
// wireSystemSleepHandling).
let pendingPauseTimeout: NodeJS.Timeout | null = null;
// Scheduled on resume/unlock-screen once an auto-pause has actually fired;
// fires the actual auto-resume after AUTO_RESUME_DELAY_MS. Same
// single-timeout reasoning as pendingPauseTimeout above, for the
// resume+unlock-screen pair on lid-open.
let pendingResumeTimeout: NodeJS.Timeout | null = null;
// True once the pause delay has actually elapsed and paused the timer —
// distinguishes "auto-paused, waiting to be resumed" from a manual pause, so
// the resume delay/notification only fires for the case it's meant for.
let autoPausedPending = false;

function cancelAutoPauseResumeCycle(): void {
  if (pendingPauseTimeout) {
    clearTimeout(pendingPauseTimeout);
    pendingPauseTimeout = null;
  }
  if (pendingResumeTimeout) {
    clearTimeout(pendingResumeTimeout);
    pendingResumeTimeout = null;
  }
  autoPausedPending = false;
}

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
  cancelAutoPauseResumeCycle();
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
  cancelAutoPauseResumeCycle();
  if (!activeLocalId || running) return activeLocalId ? getTimeEntry(activeLocalId) : null;
  running = true;
  segmentStartMs = Date.now();
  persistCurrentDuration();
  startHeartbeat();
  notifyTick();
  return getTimeEntry(activeLocalId);
}

export function stopTimer(): TimeEntryRecord | null {
  cancelAutoPauseResumeCycle();
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
 * Runs on suspend or lock-screen. If a pause delay is already counting down
 * (the other half of a suspend+lock-screen pair firing together on
 * lid-close) this is a no-op — one shared timeout covers both.
 */
function handleSessionInterrupted(): void {
  if (pendingPauseTimeout || !activeLocalId || !running) return;
  pendingPauseTimeout = setTimeout(() => {
    pendingPauseTimeout = null;
    pauseTimer(); // resets autoPausedPending via cancelAutoPauseResumeCycle - set true right after
    autoPausedPending = true;
  }, AUTO_PAUSE_DELAY_MS);
}

/**
 * Runs on resume or unlock-screen. Three cases:
 *  1. The pause delay is still counting down — the session was restored
 *     before AUTO_PAUSE_DELAY_MS elapsed, so nothing was ever paused; cancel
 *     it and continue tracking normally, no pause/resume cycle at all.
 *  2. An auto-pause already fired and nothing's resuming yet — start the
 *     resume delay.
 *  3. The resume delay is already counting down (the other half of a
 *     resume+unlock-screen pair) — no-op, one shared timeout covers both.
 */
function handleSessionRestored(): void {
  if (pendingPauseTimeout) {
    clearTimeout(pendingPauseTimeout);
    pendingPauseTimeout = null;
    return;
  }
  if (!autoPausedPending || pendingResumeTimeout) {
    notifyTick();
    return;
  }
  pendingResumeTimeout = setTimeout(() => {
    pendingResumeTimeout = null;
    const entry = resumeTimer(); // resets autoPausedPending via cancelAutoPauseResumeCycle; already calls notifyTick()
    const taskId = entry?.taskId ?? null;
    for (const cb of timerResumedListeners) cb(taskId);
  }, AUTO_RESUME_DELAY_MS);
}

/**
 * Real sleep (suspend/lid-close) and Windows+L (lock-screen) don't pause the
 * running timer immediately — each starts an AUTO_PAUSE_DELAY_MS countdown,
 * and only pauses if the session is still interrupted when it elapses.
 * Waking/unlocking before then cancels it with no pause/resume cycle at all.
 * Once an auto-pause has actually fired, waking/unlocking starts its own
 * AUTO_RESUME_DELAY_MS countdown before actually resuming + notifying —
 * note that during a REAL suspend, JS execution itself is halted, so this
 * countdown can't tick down wall-clock time while asleep; in practice it
 * fires effectively immediately alongside 'resume' once the process wakes,
 * same as the pause countdown effectively already having "used up" its
 * delay during a sleep that outlasted it.
 */
export function wireSystemSleepHandling(): void {
  powerMonitor.on('suspend', handleSessionInterrupted);
  powerMonitor.on('lock-screen', handleSessionInterrupted);
  powerMonitor.on('resume', handleSessionRestored);
  powerMonitor.on('unlock-screen', handleSessionRestored);
}
