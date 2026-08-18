import { app } from 'electron';
import { config } from 'dotenv';
import { join } from 'path';

// A packaged/installed app is launched by double-clicking a shortcut — there
// is no NODE_ENV and no guarantee what process.cwd() will be, so NODE_ENV
// can't pick the file and a plain relative path can't find it. app.isPackaged
// and app.getAppPath() are reliable in both cases (source checkout root when
// running via electron-vite, the bundled resource dir once packaged).
// Only .env.production actually ships inside the installer (see
// package.json's build.files) — .env.development stays dev-machine-only, so
// a packaged build always resolves to .env.production regardless of NODE_ENV.
const envFile = app.isPackaged ? '.env.production' : `.env.${process.env.NODE_ENV ?? 'development'}`;

// `override: false` (the default) means a real OS env var set at launch
// (e.g. `API_BASE_URL=... npm run dev`) still wins over whatever's in the file.
config({ path: join(app.getAppPath(), envFile) });

/**
 * Main-process-only: reads API_BASE_URL from the environment once at
 * startup. No hardcoded fallback — if the env file failed to load or ship,
 * this returns '' and logs it rather than throwing, so every request just
 * fails like any other network error (already handled by the try/catch in
 * pairing.ts and the callers of api-client.ts) instead of crashing the app.
 */
export function resolveApiBaseUrl(): string {
  const url = process.env.API_BASE_URL?.trim();
  if (!url) {
    console.error(`[env] API_BASE_URL is not set (expected it from ${envFile}) — requests will fail.`);
  }
  return url ?? '';
}
