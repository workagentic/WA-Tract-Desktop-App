/**
 * Central config constants shared by main + renderer. No Node globals here
 * (this file is included in the renderer's tsconfig too) — reading the
 * API_BASE_URL env var happens in main/env.ts, main-process-only.
 */

/** Heartbeat cadence while a timer is running (ms). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Debounced sync-worker cadence (ms) — spec calls for ~15-20s. */
export const SYNC_INTERVAL_MS = 18_000;

/** Refresh the access token this many ms before it actually expires. */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

/** Windows+L / laptop sleep only pauses the timer if the session is still locked/asleep after this many ms - not immediately. */
export const AUTO_PAUSE_DELAY_MS = 30_000;

/** After an auto-pause actually fires, unlocking/waking only resumes the timer after this many ms - not immediately. */
export const AUTO_RESUME_DELAY_MS = 30_000;

/** Timer bar flyout height (see TimerWidget.tsx) — what the renderer requests when resizing for a long task title; main.ts clamps to its own bounds regardless. */
export const TIMER_BAR_HEIGHT = 48;
