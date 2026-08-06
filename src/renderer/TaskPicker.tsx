import { useEffect, useMemo, useState } from 'react';
import type { TaskRecord, TimerSnapshot, UnresolvedTimerInfo } from '../shared/types';

export function TaskPicker() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [unresolved, setUnresolved] = useState<UnresolvedTimerInfo | null>(null);
  const [activeSnapshot, setActiveSnapshot] = useState<TimerSnapshot>({ entry: null, running: false });
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pendingTask, setPendingTask] = useState<TaskRecord | null>(null);

  useEffect(() => {
    (async () => {
      const [taskList, unresolvedTimer, snapshot] = await Promise.all([
        window.api.tasks.list(),
        window.api.timer.getUnresolved(),
        window.api.timer.getActive(),
      ]);
      setTasks(taskList);
      setUnresolved(unresolvedTimer);
      setActiveSnapshot(snapshot);
      setLoading(false);
    })();
  }, []);

  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return tasks;
    return tasks.filter((t) => t.title.toLowerCase().includes(query));
  }, [tasks, search]);

  const activeTaskTitle = useMemo(() => {
    const taskId = activeSnapshot.entry?.taskId;
    if (!taskId) return null;
    return tasks.find((t) => t.id === taskId)?.title ?? taskId;
  }, [tasks, activeSnapshot.entry?.taskId]);

  async function handleResolve(action: 'resume' | 'stop') {
    if (!unresolved) return;
    await window.api.timer.resolveUnresolved(action);
    setUnresolved(null);
    if (action === 'resume') {
      await window.api.tasks.closePicker();
    }
  }

  // Stops whatever's currently active (a no-op if nothing is), pushes that
  // finalized entry to the backend right away rather than waiting for the
  // next debounced sync tick, then starts the newly picked task.
  async function switchToTask(task: TaskRecord) {
    setBusyTaskId(task.id);
    try {
      await window.api.timer.stop();
      try {
        await window.api.sync.syncNow();
      } catch {
        // Non-fatal — the background sync worker keeps retrying regardless.
      }
      await window.api.timer.start(task.id);
      await window.api.tasks.closePicker();
    } finally {
      setBusyTaskId(null);
    }
  }

  function handlePick(task: TaskRecord) {
    if (activeSnapshot.entry) {
      setPendingTask(task);
      return;
    }
    switchToTask(task);
  }

  async function confirmSwitch() {
    if (!pendingTask) return;
    const task = pendingTask;
    setPendingTask(null);
    await switchToTask(task);
  }

  function cancelSwitch() {
    setPendingTask(null);
  }

  function handleClose() {
    window.api.tasks.closePicker();
  }

  return (
    <div className="widget">
      <div className="task-panel">
        <div className="task-panel-header">
          <span className="bar-icon" aria-hidden>
            ↻
          </span>
          <span className="task-panel-title">Start a Task</span>
          <button className="task-panel-close" onClick={handleClose} title="Close">
            ×
          </button>
        </div>

        <input
          className="task-search"
          type="text"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {unresolved && (
          <div className="banner">
            <span>
              A timer for &ldquo;{unresolved.task?.title ?? unresolved.entry.taskId}&rdquo; was left running when
              WA Track last closed.
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => handleResolve('resume')}>Resume</button>
              <button onClick={() => handleResolve('stop')}>Stop</button>
            </div>
          </div>
        )}

        <div className="task-tree">
          {loading && <p className="muted">Loading tasks&hellip;</p>}

          {!loading && filteredTasks.length === 0 && <p className="muted">No tasks found.</p>}

          {!loading &&
            filteredTasks.map((task) => (
              <button
                key={task.id}
                className="task-row"
                disabled={busyTaskId === task.id || !!unresolved}
                onClick={() => handlePick(task)}
              >
                {task.title}
                {busyTaskId === task.id ? ' — starting…' : ''}
              </button>
            ))}
        </div>

        {pendingTask && (
          <div className="confirm-overlay">
            <div className="confirm-box">
              <p>
                A timer for &ldquo;{activeTaskTitle}&rdquo; is currently running. Stop it, save the
                time, and start &ldquo;{pendingTask.title}&rdquo; instead?
              </p>
              <div className="confirm-actions">
                <button className="btn-primary" onClick={confirmSwitch} disabled={busyTaskId === pendingTask.id}>
                  {busyTaskId === pendingTask.id ? 'Switching…' : 'Yes, switch'}
                </button>
                <button onClick={cancelSwitch} disabled={busyTaskId === pendingTask.id}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
