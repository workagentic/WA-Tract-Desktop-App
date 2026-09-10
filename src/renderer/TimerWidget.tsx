import { useEffect, useRef, useState } from 'react';
import type { TimerSnapshot } from '../shared/types';
import { TIMER_BAR_HEIGHT } from '../shared/config';
import waLogo from './assets/wa-logo.png';

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

const EMPTY_SNAPSHOT: TimerSnapshot = { entry: null, running: false, taskTitle: null };

/** Every real control (button) stops the mousedown here so a click never also starts a drag on the bar underneath it. */
function stopMouseDown(e: React.MouseEvent) {
  e.stopPropagation();
}

// Real SVG glyphs instead of the Unicode symbols (⏸ ▶ ⏹) previously used here
// — those depend on the system font having those specific glyphs, which
// isn't guaranteed on Windows and can silently render as nothing instead of
// erroring. currentColor means these pick up .bar-icon-btn's own text color
// (including its hover/stop-hover states) automatically.
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden>
      <polygon points="6,4 20,12 6,20" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden>
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  );
}

export function TimerWidget() {
  const [snapshot, setSnapshot] = useState<TimerSnapshot>(EMPTY_SNAPSHOT);
  const [displaySeconds, setDisplaySeconds] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const nameMeasureRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const lastRequestedWidthRef = useRef<number | null>(null);
  const dragRafRef = useRef<number | null>(null);

  useEffect(() => {
    window.api.timer.getActive().then(setSnapshot);
    const unsub = window.api.timer.onTick(setSnapshot);
    return () => unsub();
  }, []);

  // taskTitle comes straight off the snapshot — resolved in main (see
  // timer-service.ts) from the picker's own click or the local task cache,
  // never from a tasks:list() round trip. That's what makes the name appear
  // the instant a task is picked instead of ~5s later.
  const displayName = snapshot.taskTitle || 'No Task';

  // The bar's window has a fixed pixel size — a long task title would
  // otherwise get clipped/truncated by the .bar-task-name ellipsis. Instead,
  // measure how wide the full, untruncated title actually needs to be (via
  // the offscreen .bar-task-name-measure span) and grow (or shrink) the
  // window to fit exactly, so the complete name is always visible without
  // ever leaving unused space.
  //
  // Deliberately NOT `bar.clientWidth - nameSlot.clientWidth` for "everything
  // else" — clientWidth reports the window's current (possibly still-stale,
  // e.g. still the old wider size) rendered width, not the actual space its
  // children need, so that subtraction silently re-derives roughly the old
  // width every time instead of shrinking. Summing each sibling's own
  // intrinsic width plus the bar's real gap/padding (read from computed
  // style, not hardcoded) is the only way to get the width the content
  // *actually* needs regardless of the window's current size.
  //
  // Exposed as a function (not just inline in the effect) so it can also be
  // re-run, forcibly, right after a drag ends — see handleBarMouseDown.
  // Dragging across monitors with different display scaling can leave
  // Windows having resized the window on its own; re-asserting the correct
  // size once the drag is over snaps it back regardless of the cause.
  function reassertSize(force: boolean) {
    const bar = barRef.current;
    const icon = iconRef.current;
    const measure = nameMeasureRef.current;
    const time = timeRef.current;
    if (!bar || !icon || !measure || !time) return;

    const barStyle = window.getComputedStyle(bar);
    const gap = parseFloat(barStyle.columnGap || '0') || 0;
    const paddingX = (parseFloat(barStyle.paddingLeft) || 0) + (parseFloat(barStyle.paddingRight) || 0);
    const borderX = (parseFloat(barStyle.borderLeftWidth) || 0) + (parseFloat(barStyle.borderRightWidth) || 0);

    const controlsWidth = controlsRef.current?.offsetWidth ?? 0;
    const itemCount = 3 + (controlsRef.current ? 1 : 0); // icon, name, time, [controls]
    const contentWidth = icon.offsetWidth + measure.offsetWidth + time.offsetWidth + controlsWidth;

    const desiredWidth = Math.ceil(contentWidth + gap * (itemCount - 1) + paddingX + borderX);

    if (force || lastRequestedWidthRef.current !== desiredWidth) {
      lastRequestedWidthRef.current = desiredWidth;
      window.api.timer.resizeWidget(desiredWidth, TIMER_BAR_HEIGHT);
    }
  }

  useEffect(() => {
    reassertSize(false);
  }, [displayName, !!snapshot.entry]);

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
    setSnapshot((prev) => ({ ...prev, entry: next, running: !prev.running && !!next }));
  }

  // Stop only ever changes tracking state now — it used to also call
  // closeWidget() here, which hid the flyout entirely and was the actual
  // cause of "the widget disappears on Stop".
  async function handleStop() {
    await window.api.timer.stop();
  }

  function handleOpenPicker() {
    window.api.tasks.openPicker();
  }

  // Deliberately not -webkit-app-region: drag. On Windows that's hit-tested
  // by the OS as a title bar, which makes Windows draw its own cursor there
  // and ignore CSS `cursor` entirely — a custom drag cursor would never
  // actually show. Driving the drag manually (mousedown here,
  // mousemove/mouseup on window so it keeps tracking outside the bar's own
  // bounds) keeps this a normal DOM element, so cursor: crosshair (see
  // styles.css) genuinely renders. rAF-throttles the IPC calls to once per
  // frame instead of once per raw mousemove event.
  function handleBarMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    window.api.timer.dragStart();

    const onMouseMove = () => {
      if (dragRafRef.current !== null) return;
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
        window.api.timer.dragStep();
      });
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      window.api.timer.dragEnd();
      // Force, not the usual "only if it changed" check — this is
      // specifically to correct any size drift the OS introduced during the
      // drag itself (see reassertSize's comment above), which our own
      // lastRequestedWidthRef has no way of knowing happened.
      reassertSize(true);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  return (
    <div className="widget">
      {/*
        The entire bar is draggable from anywhere on it (see handleBarMouseDown),
        including the icon and the empty space around the name/time — only the
        task-name button (opens the picker) and the pause/stop buttons are real
        click targets, and each stops its own mousedown from reaching this
        handler so clicking them never also drags the window.
      */}
      <div className="timer-bar" ref={barRef} onMouseDown={handleBarMouseDown}>
        <span className="bar-icon" ref={iconRef} aria-hidden>
          <img src={waLogo} alt="" draggable={false} />
        </span>

        <button
          className="bar-task-name"
          onMouseDown={stopMouseDown}
          onClick={handleOpenPicker}
          title="Pick a task"
        >
          {displayName}
        </button>
        <span className="bar-task-name-measure" ref={nameMeasureRef} aria-hidden>
          {displayName}
        </span>

        <span className="bar-time" ref={timeRef}>
          {formatDuration(displaySeconds)}
        </span>

        {snapshot.entry && (
          <div className="bar-controls" ref={controlsRef}>
            <button
              className="bar-icon-btn"
              onMouseDown={stopMouseDown}
              onClick={handlePauseResume}
              title={snapshot.running ? 'Pause' : 'Resume'}
            >
              {snapshot.running ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="bar-icon-btn bar-stop" onMouseDown={stopMouseDown} onClick={handleStop} title="Stop">
              <StopIcon />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
