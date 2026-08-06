import { config } from 'dotenv';
import { DEFAULT_API_BASE_URL } from '../shared/config';

// Dev-only override — a packaged/installed app has no .env file sitting next
// to it (electron-builder doesn't ship one), so this only ever affects
// running from source. `override: false` (the default) means a real OS env
// var set at launch (e.g. `API_BASE_URL=... npm run dev`) still wins over
// whatever's in .env.
config();

/**
 * Main-process-only: reads API_BASE_URL from the environment once at
 * startup. Hardcoded default per spec, overridable via env var or .env.
 */
export function resolveApiBaseUrl(): string {
  return process.env.API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
}
