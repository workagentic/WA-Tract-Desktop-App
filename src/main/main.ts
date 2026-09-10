import { app, BrowserWindow, Tray, Menu, ipcMain, screen, Notification } from 'electron';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { initDb, getCachedTasks } from './local-db';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc-handlers';
import { loadTokens } from './token-store';
import { ensureFreshAccessToken, onSessionExpired } from './api-client';
import { onPairingStatusChange, resetPairingState } from './pairing';
import {
  onTimerTick,
  findUnresolvedTimer,
  wireSystemSleepHandling,
  onTimerResumed,
  getSnapshot,
  stopTimer,
} from './timer-service';
import { startSyncWorker, stopSyncWorker, runSyncCycle } from './sync-worker';
import { createTrayIcon } from './tray-icon';
import { loadFlyoutAnchor, saveFlyoutAnchor } from './window-position-store';
import { wireAutoUpdater, checkForUpdatesNow } from './updater';

const isDev = !app.isPackaged;

// Required for Windows to reliably show (and correctly attribute) native
// Notification toasts from a packaged app — without a matching
// AppUserModelID, Windows can silently drop the sleep-resume "timer
// paused" notification with no error anywhere. Must match package.json's
// build.appId (what the NSIS installer registers on the Start Menu
// shortcut) and be set before app.whenReady().
app.setAppUserModelId('com.workagentic.watrack');

/**
 * Main-process console output isn't reliably visible in every launch context
 * (packaged app, detached terminal, etc.), and an uncaught rejection here
 * previously meant the app could end up with zero windows and zero visible
 * error. Every crash/rejection gets appended here so it's always inspectable
 * from disk, and the process is kept alive rather than silently stuck.
 */
function logCrash(label: string, err: unknown) {
  try {
    const line = `[${new Date().toISOString()}] ${label}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
    appendFileSync(join(app.getPath('userData'), 'crash.log'), line);
  } catch {
    // Nothing more we can do if even the crash log can't be written.
  }
}

process.on('unhandledRejection', (err) => logCrash('unhandledRejection', err));
process.on('uncaughtException', (err) => logCrash('uncaughtException', err));

// Only one WA Track instance may run at a time. requestSingleInstanceLock()
// atomically claims (or fails to claim) a lock file OS-wide — the first
// launch wins it and keeps running; every subsequent launch fails to acquire
// it here and must quit immediately rather than proceeding to create its own
// tray icon/windows/sync worker alongside the already-running one. The
// winning instance is notified via 'second-instance' (registered below) so
// it can surface itself instead of the failed relaunch silently vanishing.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let pairingWindow: BrowserWindow | null = null;
let taskPickerWindow: BrowserWindow | null = null;
let timerBarWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const RENDERER_DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'];

function loadRoute(win: BrowserWindow, hash: string) {
  if (RENDERER_DEV_SERVER_URL) {
    win.loadURL(`${RENDERER_DEV_SERVER_URL}#${hash}`);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash });
  }
}

function createPairingWindow(): BrowserWindow {
  if (pairingWindow && !pairingWindow.isDestroyed()) {
    pairingWindow.focus();
    return pairingWindow;
  }
  const win = new BrowserWindow({
    width: 480,
    height: 420,
    resizable: true,
    title: 'WA Track — Pair this device',
    // Packaged builds already show build/icon.ico via the compiled exe's own
    // resources; this only matters in dev, where Electron has no exe icon to
    // fall back to and would otherwise show the generic Electron icon in the
    // title bar/taskbar while the pairing screen itself shows the real logo.
    icon: join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.maximize();
  loadRoute(win, '/pairing');
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => {
    pairingWindow = null;
  });
  pairingWindow = win;
  return win;
}

// Both the bar and the task-picker flyout anchor themselves just above the
// tray icon (like the Windows volume/network flyouts), rather than sitting
// at a fixed spot on the desktop. `tray.getBounds()` can return an
// all-zero rect on some Windows configs (icon not yet laid out) — in that
// case fall back to the work area's bottom-right corner.
// Used only as the initial window size, before any content has been
// measured — avoids a jarring 0-width flash on first paint.
const BAR_WIDTH = 300;
const BAR_HEIGHT = 48;
// The ongoing resize floor (not BAR_WIDTH) — just enough for the icon, a
// short name, the timer, and pause/stop to fit without crowding. Using
// BAR_WIDTH here instead used to force every bar to stay 300px wide even for
// a short title like "Test task": .bar-task-name's flex: 1 would then
// stretch into that forced leftover space, visibly shoving the timer away
// from the name. The bar should flex down to fit short titles just as
// readily as it grows for long ones.
const BAR_MIN_WIDTH = 150;
// The bar grows past BAR_MIN_WIDTH to fit a long task title in full, on one
// line, never truncated (see TimerWidget.tsx's resize-on-measure effect) —
// there's deliberately no fixed upper cap here anymore (a task name should
// never get cut off with an ellipsis regardless of length); resizeTimerBar
// clamps against the actual screen's work area width instead, so it still
// can't push the flyout off-screen.
// Widened from 320 for the subtask tree — deep nesting eats into the title's
// available width via the expand-arrow column + compounding indentation, so
// a bit more room keeps titles readable instead of ellipsizing aggressively.
const PICKER_WIDTH = 360;
const PICKER_HEIGHT = 460;
const ANCHOR_MARGIN_PX = 8;

function anchorNearTray(width: number, height: number): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay();
  const trayBounds = tray?.getBounds();

  if (trayBounds && trayBounds.width > 0) {
    const x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    const y = trayBounds.y - height - ANCHOR_MARGIN_PX;
    return {
      x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width),
      y: Math.max(y, workArea.y),
    };
  }

  const x = workArea.x + workArea.width - width - 24;
  const y = workArea.y + workArea.height - height - 24;
  return { x: Math.max(workArea.x, x), y: Math.max(workArea.y, y) };
}

function flyoutWindowOptions(width: number, height: number) {
  return {
    width,
    height,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    // Electron defaults these to true even when resizable: false — off for
    // basic hardening on a small utility flyout that should never actually
    // maximize/minimize/fullscreen (verified via isolated testing that this
    // was NOT the cause of the drag-resize bug fixed in stepTimerBarDrag -
    // see its comment for the real cause and fix).
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  } as const;
}

// Both flyouts are draggable (via -webkit-app-region: drag on their header/
// bar in styles.css). They're the same conceptual panel switching content —
// dragging either one moves "the panel", so both read/write ONE shared
// anchor rather than each remembering its own spot: dragging the bar to a
// monitor and then opening the picker should open it right there, not
// wherever the picker happened to be left last.
//
// `moved` fires for our own programmatic setPosition() calls too, not just
// real drags — but ONLY when the position actually changes. show*()/resize*()
// call positionFlyout() constantly (e.g. resizeTimerBar runs on every task-
// title change) and frequently re-apply the exact position the window is
// already at, which never fires 'moved' at all. A boolean "ignore the next
// event" flag would get stuck true forever waiting for an event that was
// never coming, silently swallowing the NEXT *real* drag instead of saving
// it. Comparing the reported position against the exact coordinates we last
// set ourselves sidesteps that entirely — no flag, no event-ordering
// assumptions, just "did this position come from us or not".
let timerBarLastSetPosition: { x: number; y: number } | null = null;
let taskPickerLastSetPosition: { x: number; y: number } | null = null;

function positionFlyout(
  win: BrowserWindow,
  width: number,
  height: number,
  recordLastSet: (pos: { x: number; y: number }) => void,
) {
  const anchor = loadFlyoutAnchor();
  const { workArea } = screen.getPrimaryDisplay();
  let x: number;
  let y: number;
  if (anchor) {
    x = Math.round(Math.min(Math.max(anchor.centerX - width / 2, workArea.x), workArea.x + workArea.width - width));
    y = Math.round(Math.min(Math.max(anchor.bottomY - height, workArea.y), workArea.y + workArea.height - height));
  } else {
    ({ x, y } = anchorNearTray(width, height));
  }
  win.setPosition(x, y);
  recordLastSet({ x, y });
}

function persistFlyoutAnchor(win: BrowserWindow): void {
  const bounds = win.getBounds();
  saveFlyoutAnchor({ centerX: bounds.x + bounds.width / 2, bottomY: bounds.y + bounds.height });
}

function ensureTimerBarWindow(): BrowserWindow {
  if (timerBarWindow && !timerBarWindow.isDestroyed()) return timerBarWindow;
  const win = new BrowserWindow(flyoutWindowOptions(BAR_WIDTH, BAR_HEIGHT));
  loadRoute(win, '/timer');
  win.on('moved', () => {
    const [x, y] = win.getPosition();
    if (timerBarLastSetPosition && x === timerBarLastSetPosition.x && y === timerBarLastSetPosition.y) return;
    persistFlyoutAnchor(win);
  });
  win.on('closed', () => {
    timerBarWindow = null;
  });
  timerBarWindow = win;
  return win;
}

function ensureTaskPickerWindow(): BrowserWindow {
  if (taskPickerWindow && !taskPickerWindow.isDestroyed()) return taskPickerWindow;
  const win = new BrowserWindow(flyoutWindowOptions(PICKER_WIDTH, PICKER_HEIGHT));
  loadRoute(win, '/tasks');
  win.on('moved', () => {
    const [x, y] = win.getPosition();
    if (taskPickerLastSetPosition && x === taskPickerLastSetPosition.x && y === taskPickerLastSetPosition.y) return;
    persistFlyoutAnchor(win);
  });
  win.on('closed', () => {
    taskPickerWindow = null;
  });
  taskPickerWindow = win;
  return win;
}

function showTimerBar() {
  const win = ensureTimerBarWindow();
  // Use the window's OWN current size, not the BAR_WIDTH/BAR_HEIGHT
  // defaults — a long task title (see resizeTimerBar) can leave the real
  // window wider than the defaults. Re-anchoring with the wrong, narrower
  // width here mis-positions the window relative to its actual bounds,
  // showing up as blank space around the visible content the next time the
  // bar is shown (e.g. after closing the picker).
  const [width, height] = win.getSize();
  positionFlyout(win, width, height, (pos) => (timerBarLastSetPosition = pos));
  win.show();
}

function hideTimerBar() {
  if (timerBarWindow && !timerBarWindow.isDestroyed()) {
    timerBarWindow.hide();
  }
}

function resizeTimerBar(width: number, height: number = BAR_HEIGHT) {
  if (!timerBarWindow || timerBarWindow.isDestroyed()) return;
  // No fixed upper cap — a long task name must never be truncated. Clamped
  // against the current display's actual work area instead (with a small
  // margin) purely so the flyout can't extend past the visible screen.
  const { workArea } = screen.getDisplayNearestPoint(timerBarWindow.getBounds());
  const maxWidth = workArea.width - 40;
  const clamped = Math.round(Math.min(Math.max(width, BAR_MIN_WIDTH), maxWidth));
  const clampedHeight = Math.round(height || BAR_HEIGHT);
  // On Windows, a `resizable: false` window (see flyoutWindowOptions) can
  // have its OS-level min/max size silently pinned to whatever size it was
  // created at — every later setSize() then gets clamped right back to that
  // original size, no matter what's requested. Flipping resizable true for
  // the moment of the actual call sidesteps that; false again immediately
  // after so the user still can't drag-resize this frameless flyout.
  timerBarWindow.setResizable(true);
  timerBarWindow.setSize(clamped, clampedHeight);
  timerBarWindow.setResizable(false);
  positionFlyout(timerBarWindow, clamped, clampedHeight, (pos) => (timerBarLastSetPosition = pos));
}

// ---------------------------------------------------------------------------
// Manual drag for the timer bar. This is NOT -webkit-app-region: drag — on
// Windows, an app-region:drag element is hit-tested by the OS as a title bar
// (HTCAPTION), which makes Windows render its own cursor there and ignore
// the element's CSS `cursor` entirely. Since the whole point of the "+"
// indicator (Desktop_APP_CHANGES.md #4/#9) is a visible cursor change on
// hover, the drag has to be driven from here instead: renderer reports
// mousedown/mousemove/mouseup, main tracks the delta itself via
// screen.getCursorScreenPoint() (works regardless of which window has
// focus) and moves the window every step.
// ---------------------------------------------------------------------------
let timerBarDragAnchor: {
  winX: number;
  winY: number;
  cursorX: number;
  cursorY: number;
  width: number;
  height: number;
} | null = null;

function startTimerBarDrag(): void {
  if (!timerBarWindow || timerBarWindow.isDestroyed()) return;
  const [winX, winY] = timerBarWindow.getPosition();
  const [width, height] = timerBarWindow.getSize();
  const { x: cursorX, y: cursorY } = screen.getCursorScreenPoint();
  timerBarDragAnchor = { winX, winY, cursorX, cursorY, width, height };
}

// Confirmed via an isolated repro (see scratchpad/repro-*.js from the debug
// session that found this): calling win.setPosition(x, y) in a tight loop -
// exactly what a mousemove-driven drag does - makes a resizable:false,
// transparent BrowserWindow's width creep by ~1px on EVERY call on Windows,
// with no setSize() involved at all (300 -> 400 over 100 calls in testing).
// This is what "the widget grows when I drag it" actually was - not
// anything about screen edges or the resizable toggle in resizeTimerBar
// (both tested clean in isolation). win.setBounds({x, y, width, height}),
// re-asserting the SAME width/height captured once at drag start on every
// single call, does not accumulate this drift (confirmed: ends at exactly
// the original size instead of drifting), because it never leaves size
// implicit for Electron/Chromium to (mis)round on its own.
function stepTimerBarDrag(): void {
  if (!timerBarDragAnchor || !timerBarWindow || timerBarWindow.isDestroyed()) return;
  const { width, height } = timerBarDragAnchor;
  const { x: cursorX, y: cursorY } = screen.getCursorScreenPoint();
  const rawX = timerBarDragAnchor.winX + (cursorX - timerBarDragAnchor.cursorX);
  const rawY = timerBarDragAnchor.winY + (cursorY - timerBarDragAnchor.cursorY);

  // Also keep the drag from pushing the window off the visible work area -
  // separate, smaller issue from the width-creep bug above, but still worth
  // guarding against.
  const { workArea } = screen.getDisplayNearestPoint({ x: cursorX, y: cursorY });
  const x = Math.min(Math.max(rawX, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(rawY, workArea.y), workArea.y + workArea.height - height);

  timerBarWindow.setBounds({ x, y, width, height });
  timerBarLastSetPosition = { x, y };
}

function endTimerBarDrag(): void {
  if (timerBarDragAnchor && timerBarWindow && !timerBarWindow.isDestroyed()) {
    persistFlyoutAnchor(timerBarWindow);
  }
  timerBarDragAnchor = null;
}

// Opening the picker replaces the bar rather than stacking on top of it —
// both anchor to the same spot (see positionFlyout's shared anchor above),
// and only one is ever the thing the user's actively looking at (picking a
// task vs. watching the timer run). Closing the picker hands back to the bar.
function showTaskPicker() {
  hideTimerBar();
  const win = ensureTaskPickerWindow();
  positionFlyout(win, PICKER_WIDTH, PICKER_HEIGHT, (pos) => (taskPickerLastSetPosition = pos));
  win.show();
  win.focus();
}

function hideTaskPicker() {
  if (taskPickerWindow && !taskPickerWindow.isDestroyed()) {
    taskPickerWindow.hide();
  }
  showTimerBar();
}

/** Full teardown on logout — unlike hide/show above, these windows hold state (task list, session) tied to the outgoing session, so they're destroyed and recreated fresh on next login rather than reused. */
function teardownAuthenticatedWindows() {
  timerBarWindow?.close();
  timerBarWindow = null;
  taskPickerWindow?.close();
  taskPickerWindow = null;
}

/** Called when a second launch attempt is caught by requestSingleInstanceLock — brings the already-running instance to the user's attention instead of leaving the relaunch's click looking like a no-op. */
function focusExistingApp() {
  if (pairingWindow && !pairingWindow.isDestroyed()) {
    pairingWindow.show();
    pairingWindow.focus();
    return;
  }
  showTimerBar();
  timerBarWindow?.focus();
}

function createTray() {
  tray = new Tray(createTrayIcon());
  // Shows the actually-running version on hover — the simplest possible way
  // to confirm at a glance whether an update really landed, rather than
  // having to infer it from subtler UI changes.
  tray.setToolTip(`WA Track v${app.getVersion()}`);
  const menu = Menu.buildFromTemplate([
    {
      label: `WA Track v${app.getVersion()}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Pick a task',
      click: () => {
        if (pairingWindow && !pairingWindow.isDestroyed()) {
          pairingWindow.show();
          pairingWindow.focus();
          return;
        }
        showTaskPicker();
      },
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => checkForUpdatesNow(true),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (pairingWindow && !pairingWindow.isDestroyed()) {
      pairingWindow.show();
      pairingWindow.focus();
      return;
    }
    if (timerBarWindow && !timerBarWindow.isDestroyed() && timerBarWindow.isVisible()) {
      hideTimerBar();
    } else {
      showTimerBar();
    }
  });
}

/** Forwards pairing status pushes to whichever window is currently showing the pairing screen. */
function wirePairingBroadcast() {
  onPairingStatusChange((status) => {
    pairingWindow?.webContents.send('pairing:status-changed', status);
    if (status.state === 'paired') {
      pairingWindow?.close();
      bootstrapAfterAuth().catch((err) => logCrash('bootstrapAfterAuth (post-pairing)', err));
    }
  });
}

function wireTimerBroadcast() {
  onTimerTick((snapshot) => {
    timerBarWindow?.webContents.send('timer:tick', snapshot);
    taskPickerWindow?.webContents.send('timer:tick', snapshot);
  });
}

/**
 * The bar already reflects a paused timer (⏸ becomes ▶) once an auto-pause
 * actually fires — 30s after real sleep or a lock-screen, if the session is
 * still interrupted that long (see timer-service.ts's
 * wireSystemSleepHandling) — but that's easy to miss, especially if the bar
 * was hidden. Lid-open/unlock likewise auto-resume it 30s after the session
 * is restored, not instantly; this surfaces a native OS notification once
 * that resume actually happens, so the employee notices.
 */
function wireTimerResumedNotification() {
  onTimerResumed((taskId) => {
    try {
      if (!Notification.isSupported()) {
        logCrash('wireTimerResumedNotification', new Error('Notification.isSupported() returned false'));
        return;
      }
      const title = taskId ? getCachedTasks().find((t) => t.id === taskId)?.title : null;

      const notification = new Notification({
        title: 'WA Track — Timer resumed',
        body: title
          ? `Your timer for "${title}" has resumed successfully.`
          : 'Your timer has resumed successfully.',
      });
      notification.show();
    } catch (err) {
      // Previously any exception here (e.g. reading the cached task list)
      // would die silently — an uncaught error inside an event listener
      // callback, with no visible symptom beyond "no notification ever
      // appears." Logging it means a real bug is diagnosable instead of
      // indistinguishable from Windows' own dev-mode notification quirks.
      logCrash('wireTimerResumedNotification', err);
    }
  });
}

/** Runs once we have (or just obtained) a paired session: reconcile local DB, then show the tray bar (or the picker directly, if a crashed timer needs resolving first). */
async function bootstrapAfterAuth() {
  // Push any pending/queued rows immediately rather than waiting for the
  // first debounced tick — this is the "reconcile before showing the task
  // picker" step from the spec. An unresolved (crashed) open timer is left
  // in place; TaskPicker asks the user resume-or-stop via timer:getUnresolved.
  //
  // A failure here (e.g. a transient sync error) must never prevent the
  // task-picker window from appearing — the sync worker keeps retrying in
  // the background regardless, so this is deliberately non-fatal to the UI.
  try {
    await runSyncCycle();
  } catch (err) {
    logCrash('bootstrapAfterAuth: runSyncCycle failed, continuing anyway', err);
  }
  startSyncWorker();
  if (findUnresolvedTimer()) {
    showTaskPicker();
  } else {
    showTimerBar();
  }
}

/**
 * A device that's already paired must never be asked to re-pair just
 * because its short-lived (15min) access token expired between app
 * launches — that would defeat the whole point of pairing once. So this
 * explicitly verifies/refreshes the stored session via the (7-day) refresh
 * token *before* deciding pairing vs. task-picker, rather than leaving that
 * to whatever the first API call inside bootstrapAfterAuth happens to do.
 * Only a session with no token at all, or one whose refresh token is also
 * dead (expired/revoked), falls back to showing a pairing code.
 */
async function bootstrapWindows() {
  const tokens = loadTokens();
  if (!tokens?.accessToken) {
    // PairingScreen.tsx itself calls pairing.start() once it observes an
    // idle status — starting it here too would race it: two concurrent
    // startPairing() calls generate two device codes, and whichever one the
    // user enters first goes stale the instant the second supersedes it.
    createPairingWindow();
    return;
  }

  const stillValid = await ensureFreshAccessToken();
  if (!stillValid) {
    createPairingWindow();
    return;
  }

  await bootstrapAfterAuth();
}

/**
 * Tears down the authenticated session's windows/workers and returns to the
 * pairing screen. Also reached from the session-expired path (device
 * revoked, refresh token dead) — tokens are already cleared by the time
 * that happens, so unlike the auth:logout IPC handler this can't sync the
 * outgoing entry, but it must still stop it: timer-service's activeLocalId
 * is process-wide, not per-employee, so leaving it set would make the next
 * employee's startTimer() throw immediately instead of starting their task.
 */
function handleLogout() {
  if (getSnapshot().entry) {
    stopTimer();
  }
  stopSyncWorker();
  // Without this, pairing.ts's module-level status stays stuck at whatever
  // it was left at after the original successful pairing ('paired') —
  // reopening the pairing window would then read that stale status via
  // getStatus() and show "Paired! Loading your tasks…" forever instead of
  // ever requesting a fresh device code, since startPairing() is only
  // triggered when the status is 'idle'.
  resetPairingState();
  teardownAuthenticatedWindows();
  bootstrapWindows().catch((err) => logCrash('bootstrapWindows (after logout)', err));
}

// Everything below only ever runs in the instance that actually won the
// lock above — a losing instance already called app.quit() and must not
// touch the DB, IPC, tray, or sync worker even transiently, or it would
// briefly create exactly the duplicate state this feature exists to prevent.
if (gotSingleInstanceLock) {
  // Fires in the winning instance whenever a subsequent launch attempt is
  // caught by the lock above — there is no "second instance" to actually
  // stop, since it already quit itself before getting this far.
  app.on('second-instance', () => {
    focusExistingApp();
  });

  app.whenReady().then(() => {
    initDb();
    registerIpcHandlers({
      closeTimerWidget: hideTimerBar,
      resizeTimerWidget: resizeTimerBar,
      openTaskPicker: showTaskPicker,
      closeTaskPicker: hideTaskPicker,
      onLogout: handleLogout,
      dragTimerBarStart: startTimerBarDrag,
      dragTimerBarStep: stepTimerBarDrag,
      dragTimerBarEnd: endTimerBarDrag,
    });
    wirePairingBroadcast();
    wireTimerBroadcast();
    wireSystemSleepHandling();
    wireTimerResumedNotification();
    wireAutoUpdater();
    // Any authenticated call anywhere in the app (sync, tasks:list, etc.) that
    // determines the session is truly dead — not just its short-lived access
    // token expired, but the refresh token too — routes back here, same as
    // a manual logout, instead of silently degrading to stale cached data.
    onSessionExpired(() => handleLogout());
    createTray();
    bootstrapWindows().catch((err) => logCrash('bootstrapWindows (initial launch)', err));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        bootstrapWindows().catch((err) => logCrash('bootstrapWindows (activate)', err));
      }
    });
  });

  app.on('window-all-closed', () => {
    // Keep the app (and any running timer / sync worker) alive in the tray
    // even with no windows open, same as most tray-resident apps — closing
    // the picker/widget window shouldn't kill a running timer's sync loop.
    if (process.platform === 'darwin') return;
  });

  app.on('before-quit', () => {
    stopSyncWorker();
    unregisterIpcHandlers();
    ipcMain.removeAllListeners();
  });
}
