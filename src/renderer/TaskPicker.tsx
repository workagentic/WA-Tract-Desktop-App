import { useEffect, useMemo, useState } from 'react';
import type { TaskRecord, TimerSnapshot, UnresolvedTimerInfo } from '../shared/types';
import waLogo from './assets/wa-logo.png';

export function TaskPicker() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [unresolved, setUnresolved] = useState<UnresolvedTimerInfo | null>(null);
  const [activeSnapshot, setActiveSnapshot] = useState<TimerSnapshot>({ entry: null, running: false });
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pendingTask, setPendingTask] = useState<TaskRecord | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Manually opened/closed client folders — ignored while searching (see
  // visibleClientGroups below), so it just remembers what the user had open
  // once they clear the search box.
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set());

  function toggleClient(clientName: string) {
    setExpandedClients((prev) => {
      const next = new Set(prev);
      if (next.has(clientName)) next.delete(clientName);
      else next.add(clientName);
      return next;
    });
  }

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

    // This window is a hidden/shown singleton, not recreated per open (see
    // ensureTaskPickerWindow() in main.ts), so the fetch above only ever
    // runs once per app lifetime. Without this subscription, activeSnapshot
    // would stay frozen at whatever it was on first mount — stale for every
    // later open, making "pick the already-running task" and "switch tasks"
    // both misbehave because they'd think nothing is active.
    const unsub = window.api.timer.onTick(setActiveSnapshot);
    return () => unsub();
  }, []);

  // tasks:list always re-fetches from the API (falling back to the local
  // cache only on failure — see ipc-handlers.ts), so refreshing just means
  // calling it again and swapping in whatever it returns.
  async function handleRefresh() {
    setRefreshing(true);
    try {
      const taskList = await window.api.tasks.list();
      setTasks(taskList);
    } finally {
      setRefreshing(false);
    }
  }

  // The main process owns the actual teardown (clears the stored session,
  // closes this window along with the timer bar, and reopens pairing) — this
  // window doesn't navigate anywhere itself, it just triggers that flow.
  async function handleLogout() {
    await window.api.auth.logout();
  }

  // Department -> Client -> Task: the backend already scopes /tasks to the
  // employee's own department and its clients, so grouping by client here is
  // purely a display concern, not an authorization one. Grouped from the
  // full unfiltered task list so the set of folders stays stable regardless
  // of what's typed into search — only which folders start open, and which
  // tasks show inside them, changes below.
  const clientGroups = useMemo(() => {
    const groups = new Map<string, TaskRecord[]>();
    for (const task of tasks) {
      const key = task.client?.name ?? 'No client';
      const list = groups.get(key);
      if (list) list.push(task);
      else groups.set(key, [task]);
    }
    return Array.from(groups.entries());
  }, [tasks]);

  const query = search.trim().toLowerCase();

  // Search matches either a task's title or its client's folder name — a
  // client-name match reveals all of that client's tasks (not just the ones
  // whose own title happens to match too).
  const visibleClientGroups = useMemo(() => {
    return clientGroups.map(([clientName, tasksForClient]) => {
      if (!query) return { clientName, tasks: tasksForClient, matched: false };
      const clientMatches = clientName.toLowerCase().includes(query);
      const visibleTasks = clientMatches
        ? tasksForClient
        : tasksForClient.filter((t) => t.title.toLowerCase().includes(query));
      return { clientName, tasks: visibleTasks, matched: clientMatches || visibleTasks.length > 0 };
    });
  }, [clientGroups, query]);

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
      // Already tracking this exact task — nothing to switch, so don't stop
      // and restart it (that would end the current time entry and start a
      // brand new one for the same task instead of just continuing it).
      if (activeSnapshot.entry.taskId === task.id) {
        window.api.tasks.closePicker();
        return;
      }
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
            <img src={waLogo} alt="" />
          </span>
          <span className="task-panel-title">Start a Task</span>
          <div className="task-panel-actions">
            <button
              className="task-panel-icon-btn"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh tasks"
            >
              ↻
            </button>
            <button className="task-panel-icon-btn task-panel-close" onClick={handleClose} title="Minimize">
              −
            </button>
          </div>
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

          {!loading && clientGroups.length === 0 && <p className="muted">No tasks found.</p>}

          {!loading &&
            visibleClientGroups.map(({ clientName, tasks: tasksForClient, matched }) => {
              const isOpen = query ? matched : expandedClients.has(clientName);
              return (
                <div key={clientName} className="task-group">
                  <button
                    type="button"
                    className="task-group-header"
                    onClick={() => toggleClient(clientName)}
                    aria-expanded={isOpen}
                  >
                    <span className="task-group-icon" aria-hidden>
                      {isOpen ? '📂' : '📁'}
                    </span>
                    <span className="task-group-name">{clientName}</span>
                  </button>

                  {isOpen && (
                    <div className="task-group-tasks">
                      {tasksForClient.length === 0 ? (
                        <p className="muted task-group-empty">No tasks available for this client.</p>
                      ) : (
                        tasksForClient.map((task) => {
                          const isActive = activeSnapshot.entry?.taskId === task.id;
                          return (
                            <button
                              key={task.id}
                              className={isActive ? 'task-row task-row-active' : 'task-row'}
                              disabled={(busyTaskId === task.id || !!unresolved) && !isActive}
                              onClick={() => handlePick(task)}
                            >
                              {task.title}
                              {isActive ? ' — running' : ''}
                              {busyTaskId === task.id ? ' — starting…' : ''}
                            </button>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>

        <button className="task-panel-logout" onClick={handleLogout}>
          Log out
        </button>

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
