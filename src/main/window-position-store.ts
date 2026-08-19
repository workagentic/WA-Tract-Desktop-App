import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// The timer bar and task picker are the same conceptual floating panel —
// opening one replaces the other (see main.ts's showTaskPicker/showTimerBar)
// — so they share a single remembered anchor rather than each tracking its
// own position. Stored as a center-x/bottom-y reference point (not a raw
// top-left corner) because the two windows are different sizes: this is
// exactly what anchorNearTray() already does for the un-dragged case
// (center horizontally, sit with a fixed bottom edge), so a dragged
// position composes with it the same way regardless of which of the two
// windows is currently showing.
export interface FlyoutAnchor {
  centerX: number;
  bottomY: number;
}

function storeFilePath(): string {
  return join(app.getPath('userData'), 'flyout-position.json');
}

export function loadFlyoutAnchor(): FlyoutAnchor | null {
  try {
    if (!existsSync(storeFilePath())) return null;
    return JSON.parse(readFileSync(storeFilePath(), 'utf8')) as FlyoutAnchor;
  } catch {
    return null;
  }
}

export function saveFlyoutAnchor(anchor: FlyoutAnchor): void {
  try {
    writeFileSync(storeFilePath(), JSON.stringify(anchor));
  } catch {
    // Best-effort — losing a remembered flyout position isn't worth crashing over.
  }
}
