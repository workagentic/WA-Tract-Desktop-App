import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import { appendFileSync } from 'fs';
import { join } from 'path';

/**
 * Auto-update, wired against the publish feed that's already configured in
 * package.json's build.publish (GitHub releases on workagentic/
 * WA-Tract-Desktop-App) and already produced by .github/workflows/
 * release.yml on every version tag push — that plumbing only ever needed a
 * client to actually call it, which is everything below.
 */

function logUpdate(line: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'update.log'), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // best-effort logging only, same as pairing.log/sync.log/crash.log
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

// Long-lived tray app (can stay running for days) — no need for anything
// tighter than a few checks a day beyond the one at launch.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let wired = false;
// Kept at module scope deliberately — a Notification created as a local
// variable with no other reference is eligible for garbage collection the
// moment its creating function returns, and once GC'd its 'click' listener
// stops firing. Windows toasts routinely sit in the Action Center for
// minutes before someone clicks them, so this reliably breaks in practice:
// confirmed via update.log from a real test run — "update downloaded"
// logged repeatedly (once per re-check, since the cached download reports
// as already complete every time), but the "user clicked" log line this
// module also writes never once appeared, meaning the click event was
// never actually reaching this handler.
let updateReadyNotification: Notification | null = null;

/** Call once from app.whenReady(). No-op in dev — electron-updater throws against an unpackaged app (no installed feed to compare against). */
export function wireAutoUpdater(): void {
  if (wired) return;
  wired = true;

  if (!app.isPackaged) {
    logUpdate('skipped: app is not packaged (dev mode)');
    return;
  }

  autoUpdater.autoDownload = true;
  // Installs on the next natural quit even if the user never clicks the
  // "restart to install" notification below.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => logUpdate('checking for update'));
  autoUpdater.on('update-available', (info) => logUpdate(`update available: ${info.version}`));
  autoUpdater.on('update-not-available', (info) => logUpdate(`up to date: ${info.version}`));
  autoUpdater.on('error', (err) => logUpdate(`error: ${describe(err)}`));
  autoUpdater.on('download-progress', (progress) => logUpdate(`downloading update: ${Math.round(progress.percent)}%`));

  autoUpdater.on('update-downloaded', (info) => {
    logUpdate(`update downloaded: ${info.version} - prompting restart`);
    // Same native-Notification pattern as wireTimerResumedNotification() in
    // main.ts, rather than electron-updater's own generic
    // checkForUpdatesAndNotify() wording — keeps every user-facing
    // notification in this app consistently branded.
    if (!Notification.isSupported()) {
      logUpdate('update-downloaded: Notification.isSupported() returned false, skipping prompt');
      return;
    }
    updateReadyNotification = new Notification({
      title: 'WA Track — Update ready',
      body: `Version ${info.version} has been downloaded. Click to restart and install now.`,
    });
    updateReadyNotification.on('click', () => {
      logUpdate('user clicked update-ready notification - installing now');
      autoUpdater.quitAndInstall();
    });
    updateReadyNotification.show();
  });

  checkForUpdatesNow();
  setInterval(checkForUpdatesNow, CHECK_INTERVAL_MS);
}

/** Manual trigger (e.g. the tray menu's "Check for Updates") as well as the periodic background check above — both go through the same path. */
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().catch((err) => {
    logUpdate(`checkForUpdates() rejected: ${describe(err)}`);
  });
}
