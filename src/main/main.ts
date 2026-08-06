import { app, BrowserWindow, Tray, Menu, ipcMain, screen } from 'electron';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { initDb } from './local-db';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc-handlers';
import { loadTokens } from './token-store';
import { ensureFreshAccessToken, onSessionExpired } from './api-client';
import { onPairingStatusChange } from './pairing';
import { onTimerTick, findUnresolvedTimer, wireSystemSleepHandling } from './timer-service';
import { startSyncWorker, stopSyncWorker, runSyncCycle } from './sync-worker';
import { createTrayIcon } from './tray-icon';

const isDev = !app.isPackaged;

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
const BAR_WIDTH = 300;
const BAR_HEIGHT = 48;
// The bar grows past BAR_WIDTH to fit a long task title in full rather than
// truncating it (see TimerWidget.tsx's resize-on-measure effect) — capped
// here so an absurdly long title can't push the flyout off-screen.
const BAR_MAX_WIDTH = 640;
const PICKER_WIDTH = 320;
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

function ensureTimerBarWindow(): BrowserWindow {
  if (timerBarWindow && !timerBarWindow.isDestroyed()) return timerBarWindow;
  const win = new BrowserWindow(flyoutWindowOptions(BAR_WIDTH, BAR_HEIGHT));
  loadRoute(win, '/timer');
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
  win.on('closed', () => {
    taskPickerWindow = null;
  });
  taskPickerWindow = win;
  return win;
}

function showTimerBar() {
  const win = ensureTimerBarWindow();
  const { x, y } = anchorNearTray(BAR_WIDTH, BAR_HEIGHT);
  win.setPosition(x, y);
  win.show();
}

function hideTimerBar() {
  if (timerBarWindow && !timerBarWindow.isDestroyed()) {
    timerBarWindow.hide();
  }
}

function resizeTimerBar(width: number) {
  if (!timerBarWindow || timerBarWindow.isDestroyed()) return;
  const clamped = Math.round(Math.min(Math.max(width, BAR_WIDTH), BAR_MAX_WIDTH));
  timerBarWindow.setSize(clamped, BAR_HEIGHT);
  const { x, y } = anchorNearTray(clamped, BAR_HEIGHT);
  timerBarWindow.setPosition(x, y);
}

// Opening the picker replaces the bar rather than stacking on top of it —
// both anchor to the same spot above the tray, and only one is ever the
// thing the user's actively looking at (picking a task vs. watching the
// timer run). Closing the picker hands back to the bar.
function showTaskPicker() {
  hideTimerBar();
  const win = ensureTaskPickerWindow();
  const { x, y } = anchorNearTray(PICKER_WIDTH, PICKER_HEIGHT);
  win.setPosition(x, y);
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

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('WA Track');
  const menu = Menu.buildFromTemplate([
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
      label: 'Log out',
      click: () => handleLogout(),
    },
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

/** Tears down the authenticated session's windows/workers and returns to the pairing screen. */
function handleLogout() {
  stopSyncWorker();
  teardownAuthenticatedWindows();
  bootstrapWindows().catch((err) => logCrash('bootstrapWindows (after logout)', err));
}

app.whenReady().then(() => {
  initDb();
  registerIpcHandlers({
    closeTimerWidget: hideTimerBar,
    resizeTimerWidget: resizeTimerBar,
    openTaskPicker: showTaskPicker,
    closeTaskPicker: hideTaskPicker,
    onLogout: handleLogout,
  });
  wirePairingBroadcast();
  wireTimerBroadcast();
  wireSystemSleepHandling();
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
