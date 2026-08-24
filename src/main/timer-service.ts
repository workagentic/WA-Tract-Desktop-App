import { randomUUID } from 'crypto';
import { powerMonitor } from 'electron';
import { AUTO_RESUME_ON_WAKE_DELAY_MS, HEARTBEAT_INTERVAL_MS, LOCK_SCREEN_GRACE_PERIOD_MS } from '../shared/config';
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

type AutoPauseResumeListener = (taskId: string | null) => void;
const autoPauseResumeListeners = new Set<AutoPauseResumeListener>();

let activeLocalId: string | null = null;
let running = false;
let segmentStartMs: number | null = null;
let baseDurationSeconds = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;
// Set only when suspend or a lock-screen grace-period timeout itself pauses a
// running timer — distinguishes "auto-paused, waiting to come back" from a
// manual pause, so the wake/unlock notification+auto-resume only fires for
// the case it's meant for.
let autoPausedAwaitingResume = false;
// Scheduled on wake/unlock after an auto-pause; fires resumeTimer() after
// AUTO_RESUME_ON_WAKE_DELAY_MS unless something cancels it first (a manual
// pause/resume/stop, or another sleep/lock cycle starting before it fires).
let pendingAutoResumeTimeout: NodeJS.Timeout | null = null;
// Scheduled on lock-screen; fires the actual auto-pause after
// LOCK_SCREEN_GRACE_PERIOD_MS unless the session unlocks first. Windows+L
// alone never reaches pauseTimer() at all while this is still pending — see
// wireSystemSleepHandling().
let pendingLockGraceTimeout: NodeJS.Timeout | null = null;

function cancelPendingAutoResume(): void {
  if (pendingAutoResumeTimeout) {
    clearTimeout(pendingAutoResumeTimeout);
    pendingAutoResumeTimeout = null;
  }
}

function cancelPendingLockGrace(): void {
  if (pendingLockGraceTimeout) {
    clearTimeout(pendingLockGraceTimeout);
    pendingLockGraceTimeout = null;
  }
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

/** Fires once, on wake/unlock, only when the timer running before was paused by that sleep/lock-timeout — never for a manual pause. */
export function onTimerAutoPausedOnWake(cb: AutoPauseResumeListener): () => void {
  autoPauseResumeListeners.add(cb);
  return () => autoPauseResumeListeners.delete(cb);
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
  cancelPendingAutoResume();
  cancelPendingLockGrace();
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
  cancelPendingAutoResume();
  cancelPendingLockGrace();
  if (!activeLocalId || running) return activeLocalId ? getTimeEntry(activeLocalId) : null;
  running = true;
  segmentStartMs = Date.now();
  persistCurrentDuration();
  startHeartbeat();
  notifyTick();
  return getTimeEntry(activeLocalId);
}

export function stopTimer(): TimeEntryRecord | null {
  cancelPendingAutoResume();
  cancelPendingLockGrace();
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
 * Runs after any event that ends an auto-pause (real wake-from-sleep, or an
 * unlock that arrived after the lock-screen grace period already fired and
 * paused the timer). No-op if the timer isn't actually in that
 * auto-paused-awaiting-resume state — e.g. an unlock that arrives WHILE the
 * grace period is still pending never reaches here at all, since nothing was
 * ever paused for it to "resume" (see the unlock-screen handler below).
 */
function handleAutoPauseEnded(): void {
  notifyTick();
  if (!autoPausedAwaitingResume) return;
  autoPausedAwaitingResume = false;
  const taskId = activeLocalId ? getTimeEntry(activeLocalId)?.taskId ?? null : null;
  for (const cb of autoPauseResumeListeners) cb(taskId);

  cancelPendingAutoResume();
  pendingAutoResumeTimeout = setTimeout(() => {
    pendingAutoResumeTimeout = null;
    resumeTimer();
  }, AUTO_RESUME_ON_WAKE_DELAY_MS);
}

/**
 * Real sleep (suspend/lid-close) pauses the running timer immediately — the
 * machine's clock stops, so there's nothing to "wait and see" for. Windows+L
 * (lock-screen) is different: the machine keeps running, so instead of
 * pausing immediately it starts a LOCK_SCREEN_GRACE_PERIOD_MS countdown;
 * only if the session is still locked when that elapses does it actually
 * pause. Unlocking before then cancels the countdown with no pause/resume
 * cycle at all — the timer never stopped ticking in the first place. Either
 * way, once an auto-pause actually happens, waking/unlocking afterward goes
 * through the same handleAutoPauseEnded() notification + auto-resume path.
 */
export function wireSystemSleepHandling(): void {
  powerMonitor.on('suspend', () => {
    // A real sleep supersedes any lock grace period already counting down
    // (e.g. the machine locked, then actually slept before 15 minutes
    // passed) — it's about to pause immediately below regardless.
    cancelPendingLockGrace();
    cancelPendingAutoResume();
    if (activeLocalId && running) {
      pauseTimer();
      autoPausedAwaitingResume = true;
    }
  });

  powerMonitor.on('resume', handleAutoPauseEnded);

  powerMonitor.on('lock-screen', () => {
    // Defensive, same reasoning as pauseTimer()'s own cancelPendingAutoResume
    // call: a second lock-screen shouldn't leave an earlier grace period
    // running underneath a new one.
    cancelPendingLockGrace();
    if (!activeLocalId || !running) return;
    pendingLockGraceTimeout = setTimeout(() => {
      pendingLockGraceTimeout = null;
      pauseTimer();
      autoPausedAwaitingResume = true;
    }, LOCK_SCREEN_GRACE_PERIOD_MS);
  });

  powerMonitor.on('unlock-screen', () => {
    if (pendingLockGraceTimeout) {
      // Unlocked inside the grace window — nothing was ever paused, so
      // there's nothing to resume or notify about, just stop the countdown.
      cancelPendingLockGrace();
      return;
    }
    handleAutoPauseEnded();
  });
}
