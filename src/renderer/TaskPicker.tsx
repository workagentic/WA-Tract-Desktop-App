import { useEffect, useMemo, useState } from 'react';
import type { TaskRecord, TimerSnapshot, UnresolvedTimerInfo } from '../shared/types';
import waLogo from './assets/wa-logo.png';

/** Chevron-right that rotates 90° open — an actual vector icon instead of the previous ▸/▾ text glyphs, so it stays crisp at a larger size. */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? 'task-expand-icon task-expand-icon-open' : 'task-expand-icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

interface TaskTreeNode {
  task: TaskRecord;
  children: TaskTreeNode[];
}

interface ClientGroup {
  clientId: string;
  clientName: string;
  roots: TaskTreeNode[];
}

/** Does this node's own title, or any descendant's, contain the query? */
function subtreeMatches(node: TaskTreeNode, query: string): boolean {
  if (node.task.title.toLowerCase().includes(query)) return true;
  return node.children.some((child) => subtreeMatches(child, query));
}

export function TaskPicker() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [unresolved, setUnresolved] = useState<UnresolvedTimerInfo | null>(null);
  const [activeSnapshot, setActiveSnapshot] = useState<TimerSnapshot>({
    entry: null,
    running: false,
    taskTitle: null,
  });
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pendingTask, setPendingTask] = useState<TaskRecord | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Manually opened/closed folders, keyed by id (a client id, or a task's own
  // id at any depth — subtasks toggle the same way their parent client does)
  // — ignored while searching (every branch with a match force-opens instead,
  // see renderTaskNode/the client-group render below), so it just remembers
  // what the user had open once they clear the search box.
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set());
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  function toggleClient(clientId: string) {
    setExpandedClients((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }

  function toggleTask(taskId: string) {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
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

  // Client -> Task -> Subtask (any depth): the backend already scopes
  // /tasks to the employee's own department and its clients, so grouping by
  // client here is purely a display concern, not an authorization one.
  // Built from the full unfiltered task list so the set of folders/branches
  // stays stable regardless of what's typed into search — only which ones
  // are open, and which are visible, changes at render time below.
  const clientGroups = useMemo<ClientGroup[]>(() => {
    const childrenByParentId = new Map<string, TaskRecord[]>();
    const rootsByClientId = new Map<string, TaskRecord[]>();
    const clientNameById = new Map<string, string>();

    for (const task of tasks) {
      if (task.parentId) {
        const list = childrenByParentId.get(task.parentId) ?? [];
        list.push(task);
        childrenByParentId.set(task.parentId, list);
      } else {
        const key = task.client?.id ?? 'none';
        const list = rootsByClientId.get(key) ?? [];
        list.push(task);
        rootsByClientId.set(key, list);
        if (!clientNameById.has(key)) clientNameById.set(key, task.client?.name ?? 'No client');
      }
    }

    function buildNode(task: TaskRecord): TaskTreeNode {
      const children = (childrenByParentId.get(task.id) ?? []).map(buildNode);
      return { task, children };
    }

    return Array.from(rootsByClientId.entries()).map(([clientId, rootTasks]) => ({
      clientId,
      clientName: clientNameById.get(clientId) ?? 'No client',
      roots: rootTasks.map(buildNode),
    }));
  }, [tasks]);

  const query = search.trim().toLowerCase();

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
  // next debounced sync tick, then starts the newly picked task. Works the
  // same whether `task` is top-level or nested at any depth — the timer
  // itself has no concept of hierarchy, it just tracks a task id.
  async function switchToTask(task: TaskRecord) {
    setBusyTaskId(task.id);
    try {
      await window.api.timer.stop();
      try {
        await window.api.sync.syncNow();
      } catch {
        // Non-fatal — the background sync worker keeps retrying regardless.
      }
      await window.api.timer.start(task.id, task.title);
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

  function renderTaskRow(task: TaskRecord) {
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
  }

  // A node (and its subtree) is hidden entirely while searching unless it or
  // one of its descendants matches, or an ancestor already matched (which
  // reveals its whole branch unfiltered — showForced) - the same idea as the
  // original client-name-match behavior, generalized to any depth.
  function renderTaskNode(node: TaskTreeNode, showForced: boolean): JSX.Element | null {
    const { task, children } = node;
    const ownMatch = query ? task.title.toLowerCase().includes(query) : false;
    const visible = !query || showForced || subtreeMatches(node, query);
    if (!visible) return null;

    const hasChildren = children.length > 0;
    const isOpen = query ? hasChildren : expandedTasks.has(task.id);
    const revealChildren = showForced || ownMatch;

    return (
      <div key={task.id} className="task-node">
        <div className="task-node-row">
          {hasChildren ? (
            <button
              type="button"
              className="task-expand-btn"
              onClick={() => toggleTask(task.id)}
              aria-expanded={isOpen}
              aria-label={isOpen ? 'Collapse' : 'Expand'}
            >
              <ChevronIcon open={isOpen} />
            </button>
          ) : (
            <span className="task-expand-spacer" aria-hidden />
          )}
          {renderTaskRow(task)}
        </div>
        {isOpen && hasChildren && (
          <div className="task-group-tasks">
            {children.map((child) => renderTaskNode(child, revealChildren))}
          </div>
        )}
      </div>
    );
  }

  const visibleClientGroups = useMemo(() => {
    return clientGroups.map((group) => {
      const clientMatches = query ? group.clientName.toLowerCase().includes(query) : false;
      const hasMatch = query ? clientMatches || group.roots.some((r) => subtreeMatches(r, query)) : true;
      return { ...group, matched: hasMatch, clientNameMatched: clientMatches };
    });
  }, [clientGroups, query]);

  return (
    <div className="widget">
      <div className="task-panel">
        <div className="task-panel-header">
          <span className="bar-icon" aria-hidden>
            <img src={waLogo} alt="" draggable={false} />
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
            visibleClientGroups
              .filter((group) => group.matched)
              .map((group) => {
                const isOpen = query ? true : expandedClients.has(group.clientId);
                return (
                  <div key={group.clientId} className="task-group">
                    <button
                      type="button"
                      className="task-group-header"
                      onClick={() => toggleClient(group.clientId)}
                      aria-expanded={isOpen}
                    >
                      <ChevronIcon open={isOpen} />
                      <span className="task-group-name">{group.clientName}</span>
                    </button>

                    {isOpen && (
                      <div className="task-group-tasks">
                        {group.roots.length === 0 ? (
                          <p className="muted task-group-empty">No tasks available for this client.</p>
                        ) : (
                          group.roots.map((node) => renderTaskNode(node, group.clientNameMatched))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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
