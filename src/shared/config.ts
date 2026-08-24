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

/** After a sleep- or lock-triggered auto-pause, how long to wait on wake/unlock before auto-resuming the timer (ms). */
export const AUTO_RESUME_ON_WAKE_DELAY_MS = 30_000;

/** Windows+L locks the session without sleeping - grace period before a lock turns into an actual auto-pause (ms). */
export const LOCK_SCREEN_GRACE_PERIOD_MS = 15 * 60 * 1000;
