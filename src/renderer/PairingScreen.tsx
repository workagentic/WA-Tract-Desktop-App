import { useEffect, useState } from 'react';
import type { PairingStatus } from '../shared/types';

function formatUserCode(code: string): string {
  // Backend already formats as XXXX-XXXX, but defend against a plain
  // 8-character code so the on-screen display is always readable.
  const clean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean.length !== 8) return code;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

export function PairingScreen() {
  const [status, setStatus] = useState<PairingStatus>({ state: 'idle' });

  useEffect(() => {
    let unsub: (() => void) | undefined;

    (async () => {
      const initial = await window.api.pairing.getStatus();
      setStatus(initial);
      if (initial.state === 'idle') {
        const started = await window.api.pairing.start();
        setStatus(started);
      }
    })();

    unsub = window.api.pairing.onStatusChange(setStatus);
    return () => unsub?.();
  }, []);

  return (
    <div className="screen">
      <h1>Pair this device</h1>

      {status.state === 'awaiting_confirmation' && (
        <>
          <div className="code">{formatUserCode(status.userCode)}</div>
          <p className="muted">
            Go to your WA Track web portal and enter this code on the <strong>/pair</strong> page.
          </p>
          <p className="muted">Waiting for confirmation&hellip;</p>
        </>
      )}

      {status.state === 'idle' && <p className="muted">Requesting a pairing code&hellip;</p>}

      {status.state === 'paired' && <p className="muted">Paired! Loading your tasks&hellip;</p>}

      {status.state === 'error' && (
        <>
          <p className="error">Couldn&rsquo;t reach the WA Track server: {status.message}</p>
          <button
            onClick={async () => {
              const started = await window.api.pairing.start();
              setStatus(started);
            }}
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}
