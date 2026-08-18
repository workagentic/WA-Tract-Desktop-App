/**
 * Central config constants shared by main + renderer. No Node globals here
 * (this file is included in the renderer's tsconfig too) — reading the
 * API_BASE_URL env var happens in main/env.ts, main-process-only.
 */

/** Heartbeat cadence while a timer is running (ms). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Debounced sync-worker cadence (ms) — spec calls for ~15-20s. */
export const SYNC_INTERVAL_MS = 18_000;

/** Auto-pause the running timer after this much system idle time (seconds). */
export const IDLE_AUTOPAUSE_SECONDS = 5 * 60;

/** Refresh the access token this many ms before it actually expires. */
export const TOKEN_REFRESH_SKEW_MS = 60_000;
