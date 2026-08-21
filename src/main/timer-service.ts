import { randomUUID } from 'crypto';
import { powerMonitor } from 'electron';
import { AUTO_RESUME_ON_WAKE_DELAY_MS, HEARTBEAT_INTERVAL_MS, IDLE_AUTOPAUSE_SECONDS } from '../shared/config';
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
let idleCheckTimer: NodeJS.Timeout | null = null;
// Set only when suspend/lock-screen itself pauses a running timer — distinguishes
// "paused because the machine slept" from a manual pause or one already paused
// before sleep, so the wake notification only fires for the case it's meant for.
let autoPausedBySleep = false;
// Scheduled on wake after an auto-pause-by-sleep; fires resumeTimer() after
// AUTO_RESUME_ON_WAKE_DELAY_MS unless something cancels it first (a manual
// pause/resume/stop, or another sleep cycle starting before it fires).
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

function startIdleWatch(): void {
  stopIdleWatch();
  idleCheckTimer = setInterval(() => {
    if (!running) return;
    const idleSeconds = powerMonitor.getSystemIdleTime();
    if (idleSeconds >= IDLE_AUTOPAUSE_SECONDS) {
      pauseTimer();
      notifyTick();
    }
  }, 15_000);
}

function stopIdleWatch(): void {
  if (idleCheckTimer) {
    clearInterval(idleCheckTimer);
    idleCheckTimer = null;
  }
}

export function onTimerTick(cb: TickListener): () => void {
  tickListeners.add(cb);
  return () => tickListeners.delete(cb);
}

/** Fires once, on wake, only when the timer running before sleep was paused by that sleep — never for a manual pause or an idle-autopause. */
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
  startIdleWatch();
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
  stopIdleWatch();
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
  startIdleWatch();
  notifyTick();
}

export function hasActiveTimer(): boolean {
  return activeLocalId !== null;
}

/**
 * Pauses the running timer on sleep/lid-close/lock so the tracked duration
 * stops at the moment the user actually stepped away, instead of continuing
 * to accrue through the entire time the machine was asleep. On wake, if that
 * auto-pause is what stopped it: onTimerAutoPausedOnWake listeners fire once
 * (so the employee gets an explicit notification rather than having to
 * notice the bar's paused state on their own), and the timer auto-resumes on
 * its own after AUTO_RESUME_ON_WAKE_DELAY_MS — a deliberate choice to favor
 * "just keep tracking" over requiring an explicit click every single wake.
 * That auto-resume is cancelled by any manual pause/resume/stop in the
 * meantime, or by another sleep cycle starting before it fires (each via
 * cancelPendingAutoResume()).
 */
export function wireSystemSleepHandling(): void {
  const autoPauseOnSleep = () => {
    // Unconditional: if the lid closes/screen locks again while a pending
    // auto-resume is still counting down from an earlier wake, it must not
    // survive to fire later while the machine is asleep/locked again. Doing
    // this outside the running-only branch below matters specifically
    // because the timer is ALREADY paused during that countdown, so the
    // "if running" guard alone would silently skip cancelling it.
    cancelPendingAutoResume();
    if (activeLocalId && running) {
      pauseTimer();
      autoPausedBySleep = true;
    }
  };
  powerMonitor.on('suspend', autoPauseOnSleep);
  powerMonitor.on('lock-screen', autoPauseOnSleep);
  powerMonitor.on('resume', () => {
    notifyTick();
    if (!autoPausedBySleep) return;
    autoPausedBySleep = false;
    const taskId = activeLocalId ? getTimeEntry(activeLocalId)?.taskId ?? null : null;
    for (const cb of autoPauseResumeListeners) cb(taskId);

    cancelPendingAutoResume();
    pendingAutoResumeTimeout = setTimeout(() => {
      pendingAutoResumeTimeout = null;
      resumeTimer();
    }, AUTO_RESUME_ON_WAKE_DELAY_MS);
  });
}
