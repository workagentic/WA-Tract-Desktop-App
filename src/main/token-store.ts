import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

function tokenFilePath(): string {
  return join(app.getPath('userData'), 'auth.enc');
}

export function saveTokens(tokens: StoredTokens): void {
  const plain = JSON.stringify(tokens);
  const encrypted = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(plain)
    : Buffer.from(plain, 'utf8');
  writeFileSync(tokenFilePath(), encrypted);
}

export function loadTokens(): StoredTokens | null {
  const path = tokenFilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path);
    const plain = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
    return JSON.parse(plain) as StoredTokens;
  } catch {
    return null;
  }
}

export function clearTokens(): void {
  const path = tokenFilePath();
  if (existsSync(path)) unlinkSync(path);
}
