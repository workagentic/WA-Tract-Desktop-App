import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import type { TaskRecord, TimeEntryRecord } from '../shared/types';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(join(app.getPath('userData'), 'wa-track-local.db'));
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export function initDb(): void {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS time_entries (
      local_id TEXT PRIMARY KEY,
      task_id TEXT,
      employee_id TEXT,
      start_time TEXT,
      end_time TEXT,
      duration_seconds INTEGER,
      sync_status TEXT,
      last_heartbeat TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks_cache (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      status TEXT,
      due_date TEXT
    );
  `);

  migrateTasksCacheSchema(database);
}

// tasks_cache predates the Client entity — CREATE TABLE IF NOT EXISTS above is
// a no-op for anyone who already has a local DB from before this column
// existed, so it's added explicitly here, guarded by PRAGMA table_info since
// SQLite has no "ADD COLUMN IF NOT EXISTS".
function migrateTasksCacheSchema(database: Database.Database): void {
  const columns = database.prepare(`PRAGMA table_info(tasks_cache)`).all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));
  const wantedColumns: Array<[string, string]> = [
    ['client_id', 'TEXT'],
    ['client_name', 'TEXT'],
    ['client_description', 'TEXT'],
  ];
  for (const [name, type] of wantedColumns) {
    if (!existing.has(name)) {
      database.exec(`ALTER TABLE tasks_cache ADD COLUMN ${name} ${type}`);
    }
  }
}

function rowToEntry(row: any): TimeEntryRecord {
  return {
    localId: row.local_id,
    taskId: row.task_id,
    employeeId: row.employee_id,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_seconds,
    syncStatus: row.sync_status,
    lastHeartbeat: row.last_heartbeat,
  };
}

export function insertTimeEntry(entry: TimeEntryRecord): void {
  getDb()
    .prepare(
      `INSERT INTO time_entries (local_id, task_id, employee_id, start_time, end_time, duration_seconds, sync_status, last_heartbeat)
       VALUES (@localId, @taskId, @employeeId, @startTime, @endTime, @durationSeconds, @syncStatus, @lastHeartbeat)`,
    )
    .run(entry);
}

export function updateTimeEntry(localId: string, patch: Partial<TimeEntryRecord>): void {
  const current = getTimeEntry(localId);
  if (!current) return;
  const merged = { ...current, ...patch };
  getDb()
    .prepare(
      `UPDATE time_entries SET
         task_id = @taskId,
         employee_id = @employeeId,
         start_time = @startTime,
         end_time = @endTime,
         duration_seconds = @durationSeconds,
         sync_status = @syncStatus,
         last_heartbeat = @lastHeartbeat
       WHERE local_id = @localId`,
    )
    .run(merged);
}

export function getTimeEntry(localId: string): TimeEntryRecord | null {
  const row = getDb().prepare(`SELECT * FROM time_entries WHERE local_id = ?`).get(localId);
  return row ? rowToEntry(row) : null;
}

/** The most recently started entry that has no end_time yet (running or paused-but-not-stopped). */
export function getOpenTimeEntry(): TimeEntryRecord | null {
  const row = getDb()
    .prepare(`SELECT * FROM time_entries WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1`)
    .get();
  return row ? rowToEntry(row) : null;
}

// Entries never synced (sync_status='pending'), PLUS the currently-open one
// (end_time IS NULL) even if it was already marked 'synced' by an earlier
// cycle — a running timer's duration keeps growing via heartbeat, so it
// needs to keep re-syncing every cycle until it's actually stopped, not
// just once.
export function getPendingTimeEntries(): TimeEntryRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM time_entries WHERE sync_status = 'pending' OR end_time IS NULL`)
    .all();
  return rows.map(rowToEntry);
}

export function markTimeEntrySynced(localId: string): void {
  getDb().prepare(`UPDATE time_entries SET sync_status = 'synced' WHERE local_id = ?`).run(localId);
}

function rowToTask(row: any): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status ?? undefined,
    dueDate: row.due_date ?? undefined,
    client: row.client_id
      ? { id: row.client_id, name: row.client_name, description: row.client_description }
      : null,
  };
}

export function getCachedTasks(): TaskRecord[] {
  const rows = getDb().prepare(`SELECT * FROM tasks_cache`).all();
  return rows.map(rowToTask);
}

export function replaceTasksCache(tasks: TaskRecord[]): void {
  const database = getDb();
  const tx = database.transaction((list: TaskRecord[]) => {
    database.prepare(`DELETE FROM tasks_cache`).run();
    const insert = database.prepare(
      `INSERT INTO tasks_cache (id, title, description, status, due_date, client_id, client_name, client_description)
       VALUES (@id, @title, @description, @status, @dueDate, @clientId, @clientName, @clientDescription)`,
    );
    for (const task of list) {
      insert.run({
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status ?? null,
        dueDate: task.dueDate ?? null,
        clientId: task.client?.id ?? null,
        clientName: task.client?.name ?? null,
        clientDescription: task.client?.description ?? null,
      });
    }
  });
  tx(tasks);
}
