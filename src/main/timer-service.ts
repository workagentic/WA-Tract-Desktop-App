import { randomUUID } from 'crypto';
import { powerMonitor } from 'electron';
import { AUTO_RESUME_ON_WAKE_DELAY_MS, HEARTBEAT_INTERVAL_MS } from '../shared/config';
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

// Fires when a sleep-triggered auto-pause is about to auto-resume after
// AUTO_RESUME_ON_WAKE_DELAY_MS — lets main.ts show a "resuming shortly, click
// to resume now" notification for that specific case.
type AutoPauseResumeListener = (taskId: string | null) => void;
const autoPauseResumeListeners = new Set<AutoPauseResumeListener>();

// Fires when a lock-triggered auto-pause has just resumed immediately on
// unlock — lets main.ts show a "timer resumed" confirmation notification.
type TimerResumedListener = (taskId: string | null) => void;
const timerResumedListeners = new Set<TimerResumedListener>();

let activeLocalId: string | null = null;
let running = false;
let segmentStartMs: number | null = null;
let baseDurationSeconds = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;
// Set only when suspend or lock-screen itself pauses a running timer —
// distinguishes "auto-paused, waiting to come back" from a manual pause, and
// which trigger caused it, so wake/unlock applies the right resume behavior
// (sleep: delayed + notified: lock: immediate + notified) instead of a
// generic one. Null means no auto-pause is currently pending resumption.
let autoPauseKind: 'sleep' | 'lock' | null = null;
// Scheduled on real wake after a sleep-triggered auto-pause; fires
// resumeTimer() after AUTO_RESUME_ON_WAKE_DELAY_MS unless something cancels
// it first (a manual pause/resume/stop, or another sleep cycle starting
// before it fires). Lock-triggered auto-pauses resume immediately on unlock
// instead and never use this.
let pendingAutoResumeTimeout: NodeJS.Timeout | null = null;

function cancelPendingAutoResume(): void {
  if (pendingAutoResumeTimeout) {
    clearTimeout(pendingAutoResumeTimeout);
    pendingAutoResumeTimeout = null;
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

/** Fires once, on real wake, only when the timer running before was paused by suspend — never for a manual pause or a lock-triggered pause. */
export function onTimerAutoPausedOnWake(cb: AutoPauseResumeListener): () => void {
  autoPauseResumeListeners.add(cb);
  return () => autoPauseResumeListeners.delete(cb);
}

/** Fires once, on unlock, only when the timer running before was paused by that lock — never for a manual pause or a sleep-triggered pause. */
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
  cancelPendingAutoResume();
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
 * Runs on real wake from sleep. No-op unless a suspend actually auto-paused
 * the timer (autoPauseKind === 'sleep') — e.g. a wake with nothing running,
 * or one that arrives after a lock-triggered pause already resumed via
 * unlock-screen, does nothing here.
 */
function handleSleepWake(): void {
  notifyTick();
  if (autoPauseKind !== 'sleep') return;
  autoPauseKind = null;
  const taskId = activeLocalId ? getTimeEntry(activeLocalId)?.taskId ?? null : null;
  for (const cb of autoPauseResumeListeners) cb(taskId);

  cancelPendingAutoResume();
  pendingAutoResumeTimeout = setTimeout(() => {
    pendingAutoResumeTimeout = null;
    resumeTimer();
  }, AUTO_RESUME_ON_WAKE_DELAY_MS);
}

/**
 * Runs on unlock. No-op unless a lock-screen actually auto-paused the timer
 * (autoPauseKind === 'lock') — e.g. an unlock with nothing running, or one
 * that arrives after a suspend already claimed the pause as 'sleep' (see the
 * suspend handler below), does nothing here.
 */
function handleUnlock(): void {
  if (autoPauseKind !== 'lock') {
    notifyTick();
    return;
  }
  autoPauseKind = null;
  const entry = resumeTimer(); // resumeTimer() already calls notifyTick()
  const taskId = entry?.taskId ?? null;
  for (const cb of timerResumedListeners) cb(taskId);
}

/**
 * Real sleep (suspend/lid-close) and Windows+L (lock-screen) both pause the
 * running timer immediately — there's no grace period for either. They
 * differ on the resume side: waking from real sleep auto-resumes after
 * AUTO_RESUME_ON_WAKE_DELAY_MS with a "resuming shortly" notification (see
 * handleSleepWake), while unlocking resumes immediately with a "timer
 * resumed" confirmation (see handleUnlock). autoPauseKind records which one
 * is pending so the right resume path runs even if both fire (Windows
 * commonly emits lock-screen right before/with suspend on lid-close): once
 * lock-screen has claimed the pause as 'lock', a subsequent suspend leaves it
 * alone (running is already false, so its own pause is a no-op) and a
 * subsequent resume is a no-op too — unlock-screen is what actually resumes
 * it either way.
 */
export function wireSystemSleepHandling(): void {
  powerMonitor.on('suspend', () => {
    cancelPendingAutoResume();
    if (activeLocalId && running) {
      pauseTimer();
      autoPauseKind = 'sleep';
    }
  });

  powerMonitor.on('resume', handleSleepWake);

  powerMonitor.on('lock-screen', () => {
    if (activeLocalId && running) {
      pauseTimer();
      autoPauseKind = 'lock';
    }
  });

  powerMonitor.on('unlock-screen', handleUnlock);
}
