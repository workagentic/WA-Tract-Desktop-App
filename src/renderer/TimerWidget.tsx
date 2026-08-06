import { useEffect, useRef, useState } from 'react';
import type { TimerSnapshot } from '../shared/types';

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function TimerWidget() {
  const [snapshot, setSnapshot] = useState<TimerSnapshot>({ entry: null, running: false });
  const [displaySeconds, setDisplaySeconds] = useState(0);
  const [taskTitle, setTaskTitle] = useState('');
  const barRef = useRef<HTMLDivElement>(null);
  const nameSlotRef = useRef<HTMLButtonElement>(null);
  const nameMeasureRef = useRef<HTMLSpanElement>(null);
  const lastRequestedWidthRef = useRef<number | null>(null);

  useEffect(() => {
    window.api.timer.getActive().then(setSnapshot);
    const unsub = window.api.timer.onTick(setSnapshot);
    return () => unsub();
  }, []);

  // The bar's window has a fixed pixel size — a long task title would
  // otherwise get clipped/truncated by the .bar-task-name ellipsis. Instead,
  // measure how wide the full, untruncated title actually needs to be (via
  // the offscreen .bar-task-name-measure span) and grow the window to fit,
  // so the complete name is always visible rather than cut short.
  useEffect(() => {
    const bar = barRef.current;
    const nameSlot = nameSlotRef.current;
    const measure = nameMeasureRef.current;
    if (!bar || !nameSlot || !measure) return;

    const nonNameWidth = bar.clientWidth - nameSlot.clientWidth;
    const desiredWidth = Math.ceil(nonNameWidth + measure.offsetWidth + 12);

    if (lastRequestedWidthRef.current !== desiredWidth) {
      lastRequestedWidthRef.current = desiredWidth;
      window.api.timer.resizeWidget(desiredWidth);
    }
  }, [taskTitle, !!snapshot.entry, snapshot.running]);

  // The active entry only carries a taskId — look up its title from the
  // cached task list so the bar can show a name instead of a raw id.
  useEffect(() => {
    if (!snapshot.entry) {
      setTaskTitle('');
      return;
    }
    window.api.tasks.list().then((tasks) => {
      const match = tasks.find((t) => t.id === snapshot.entry?.taskId);
      if (match) setTaskTitle(match.title);
    });
  }, [snapshot.entry?.taskId]);

  // Every state transition is written synchronously to SQLite in main
  // already (see timer-service.ts); this local 1s ticker is purely cosmetic
  // — it never itself performs a write, it just interpolates between the
  // heartbeat-driven snapshots pushed over IPC.
  useEffect(() => {
    if (!snapshot.entry) {
      setDisplaySeconds(0);
      return;
    }
    setDisplaySeconds(snapshot.entry.durationSeconds);
    if (!snapshot.running) return;

    const start = Date.now();
    const base = snapshot.entry.durationSeconds;
    const interval = setInterval(() => {
      setDisplaySeconds(base + Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [snapshot]);

  async function handlePauseResume() {
    const next = snapshot.running ? await window.api.timer.pause() : await window.api.timer.resume();
    setSnapshot({ entry: next, running: !snapshot.running && !!next });
  }

  async function handleStop() {
    await window.api.timer.stop();
    await window.api.timer.closeWidget();
  }

  function handleOpenPicker() {
    window.api.tasks.openPicker();
  }

  const displayName = taskTitle || 'No Task';

  return (
    <div className="widget">
      <div className="timer-bar" ref={barRef}>
        <span className="bar-icon" aria-hidden>
          ↻
        </span>

        <button className="bar-task-name" ref={nameSlotRef} onClick={handleOpenPicker} title="Pick a task">
          {displayName}
        </button>
        <span className="bar-task-name-measure" ref={nameMeasureRef} aria-hidden>
          {displayName}
        </span>

        {snapshot.entry && <span className="bar-time">{formatDuration(displaySeconds)}</span>}

        {snapshot.entry && (
          <div className="bar-controls">
            <button
              className="bar-icon-btn"
              onClick={handlePauseResume}
              title={snapshot.running ? 'Pause' : 'Resume'}
            >
              {snapshot.running ? '⏸' : '▶'}
            </button>
            <button className="bar-icon-btn bar-stop" onClick={handleStop} title="Stop">
              ⏹
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
