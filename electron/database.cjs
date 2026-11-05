'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');

const HISTORY_LIMIT = 500;
const HISTORY_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function openDatabase(userData) {
  const directory = path.join(userData, 'data');
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'droplist.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');

  const migrations = [
    { version: 1, up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, source_url TEXT NOT NULL,
          title TEXT NOT NULL, status TEXT NOT NULL, task_json TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, entry_json TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_backups (id INTEGER PRIMARY KEY CHECK(id=1), payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      `);
    } },
    { version: 2, up() {
      const columns = new Set(db.prepare('PRAGMA table_info(history)').all().map((column) => column.name));
      if (!columns.has('task_id')) db.exec('ALTER TABLE history ADD COLUMN task_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC); CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id, id DESC);');
    } },
    { version: 3, up() {
      db.exec(`CREATE TABLE IF NOT EXISTS media_library (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_url TEXT NOT NULL, provider_id TEXT NOT NULL,
        extractor TEXT NOT NULL, original_title TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE,
        extension TEXT NOT NULL, media_type TEXT NOT NULL, duration REAL, file_size INTEGER NOT NULL,
        thumbnail_path TEXT, completed_at TEXT NOT NULL, playlist_id TEXT, metadata_json TEXT NOT NULL
      ); CREATE INDEX IF NOT EXISTS idx_media_library_completed ON media_library(completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_media_library_playlist ON media_library(playlist_id);`);
    } }
  ];

  for (const migration of migrations) {
    const applied = db.prepare('SELECT 1 AS done FROM schema_migrations WHERE version=?').get(migration.version);
    if (applied) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up();
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(migration.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }

  const transaction = (callback) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const listTasks = () => db.prepare('SELECT task_json FROM tasks ORDER BY created_at, rowid').all().map((row) => JSON.parse(row.task_json));
  const writeTask = db.prepare(`INSERT INTO tasks(id, provider_id, source_url, title, status, task_json, created_at, updated_at)
    VALUES(@id, @providerId, @url, @title, @status, @json, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, source_url=excluded.source_url, title=excluded.title,
      status=excluded.status, task_json=excluded.task_json, updated_at=excluded.updated_at`);
  const upsertTask = (task) => {
    const now = new Date().toISOString();
    writeTask.run({ id: task.id, providerId: task.providerId || 'yt-dlp', url: task.url, title: task.title || 'Untitled download',
      status: task.status || 'waiting', json: JSON.stringify(task), createdAt: task.createdAt || now, updatedAt: now });
  };
  const trimHistory = () => {
    const cutoff = new Date(Date.now() - HISTORY_AGE_MS).toISOString();
    db.prepare('DELETE FROM history WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY created_at DESC LIMIT ?)').run(HISTORY_LIMIT);
  };

  return {
    listTasks,
    upsertTask,
    saveTasks(tasks) {
      const removeMissing = db.prepare(`DELETE FROM tasks WHERE id NOT IN (${tasks.length ? tasks.map(() => '?').join(',') : 'SELECT id FROM tasks WHERE 0'})`);
      transaction(() => { removeMissing.run(...tasks.map((task) => task.id)); tasks.forEach(upsertTask); });
    },
    updateTask(id, patch) {
      const row = db.prepare('SELECT task_json FROM tasks WHERE id=?').get(id);
      if (!row) return null;
      const task = { ...JSON.parse(row.task_json), ...patch, updatedAt: new Date().toISOString() };
      upsertTask(task);
      return task;
    },
    recordTransition(task, eventType, payload = {}) {
      transaction(() => {
        upsertTask(task);
        db.prepare('INSERT INTO task_events(task_id, event_type, payload_json, created_at) VALUES(?, ?, ?, ?)').run(task.id, eventType, JSON.stringify(payload), new Date().toISOString());
        db.prepare('DELETE FROM task_events WHERE task_id=? AND id NOT IN (SELECT id FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 500)').run(task.id, task.id);
      });
    },
    appendTaskEvent(taskId, eventType, payload) {
      db.prepare('INSERT INTO task_events(task_id, event_type, payload_json, created_at) VALUES(?, ?, ?, ?)').run(taskId, eventType, JSON.stringify(payload), new Date().toISOString());
      db.prepare('DELETE FROM task_events WHERE task_id=? AND id NOT IN (SELECT id FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 500)').run(taskId, taskId);
    },
    readTaskEvents(taskId, limit = 100) {
      return db.prepare('SELECT event_type AS type, payload_json, created_at FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT ?').all(taskId, Math.min(500, Math.max(1, limit))).map((row) => ({ type: row.type, ...JSON.parse(row.payload_json), createdAt: row.created_at }));
    },
    recordMediaItems(task, files) {
      const insert = db.prepare(`INSERT INTO media_library(id, task_id, source_url, provider_id, extractor, original_title,
        file_path, extension, media_type, duration, file_size, thumbnail_path, completed_at, playlist_id, metadata_json)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET task_id=excluded.task_id, source_url=excluded.source_url, provider_id=excluded.provider_id,
        extractor=excluded.extractor, original_title=excluded.original_title, extension=excluded.extension, media_type=excluded.media_type,
        duration=excluded.duration, file_size=excluded.file_size, thumbnail_path=excluded.thumbnail_path, completed_at=excluded.completed_at,
        playlist_id=excluded.playlist_id, metadata_json=excluded.metadata_json`);
      const info = task.mediaInfo || {};
      const completedAt = new Date().toISOString();
      transaction(() => files.forEach((file) => insert.run(randomUUID(), task.id, task.url, task.providerId, info.extractor || task.providerId,
        file.originalTitle || info.originalTitle || task.title, file.path, file.extension || path.extname(file.path).slice(1).toLowerCase(),
        file.mediaType || info.mediaType || task.kind || 'video', file.duration ?? info.duration ?? null, file.size, file.thumbnailPath || null,
        completedAt, info.playlistId || null, JSON.stringify({ ...(info.metadata || {}), sourceWebsite: info.sourceWebsite || '' }))));
      return files.length;
    },
    readMediaItems(limit = 1000) {
      return db.prepare('SELECT * FROM media_library ORDER BY completed_at DESC LIMIT ?').all(Math.min(5000, Math.max(1, limit))).map((row) => ({
        id: row.id, taskId: row.task_id, sourceUrl: row.source_url, providerId: row.provider_id, extractor: row.extractor,
        originalTitle: row.original_title, filePath: row.file_path, extension: row.extension, mediaType: row.media_type,
        duration: row.duration, fileSize: row.file_size, thumbnailPath: row.thumbnail_path, completedAt: row.completed_at,
        playlistId: row.playlist_id, metadata: JSON.parse(row.metadata_json)
      }));
    },
    removeTask(id) { db.prepare('DELETE FROM tasks WHERE id=?').run(id); },
    recoverInterruptedTasks() {
      const tasks = listTasks();
      let recovered = 0;
      transaction(() => tasks.forEach((task) => {
        if (task.status === 'running' || task.status === 'preparing' || task.status === 'processing' || task.status === 'verifying') {
          const updated = { ...task, status: 'interrupted', note: 'The app closed before this task finished. Retry it to continue.' };
          upsertTask(updated);
          db.prepare('INSERT INTO task_events(task_id, event_type, payload_json, created_at) VALUES(?, ?, ?, ?)').run(task.id, 'task-recovered', JSON.stringify({ from: task.status, to: 'interrupted' }), new Date().toISOString());
          recovered++;
        }
      }));
      return recovered;
    },
    saveHistory(entries) {
      const insert = db.prepare('INSERT OR IGNORE INTO history(id, entry_json, created_at, task_id) VALUES(?, ?, ?, ?)');
      transaction(() => {
        entries.forEach((entry, index) => insert.run(entry.id || `${entry.date || ''}-${index}`, JSON.stringify(entry), entry.date || new Date().toISOString(), entry.taskId || null));
        trimHistory();
      });
    },
    migrateLegacy({ settings = {}, history = [] } = {}) {
      const existing = db.prepare('SELECT payload_json FROM legacy_backups WHERE id=1').get();
      if (!existing) {
        const payload = JSON.stringify({ settings, history });
        const backupDir = path.join(directory, 'migration-backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, `legacy-localstorage-${Date.now()}-${randomUUID()}.json`);
        fs.writeFileSync(backupPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        transaction(() => {
          db.prepare('INSERT OR IGNORE INTO legacy_backups(id, payload_json, created_at) VALUES(1, ?, ?)').run(payload, new Date().toISOString());
          const settingInsert = db.prepare('INSERT OR IGNORE INTO settings(key, value_json, updated_at) VALUES(?, ?, ?)');
          for (const [key, value] of Object.entries(settings)) settingInsert.run(key, JSON.stringify(value), new Date().toISOString());
          const historyInsert = db.prepare('INSERT OR IGNORE INTO history(id, entry_json, created_at, task_id) VALUES(?, ?, ?, ?)');
          history.slice(0, 100).forEach((entry, index) => historyInsert.run(entry.id || `${entry.date || ''}-${index}`, JSON.stringify(entry), entry.date || new Date().toISOString(), entry.taskId || null));
          trimHistory();
        });
      }
      return { settings: this.readSettings(), history: this.readHistory(), tasks: listTasks() };
    },
    readHistory() { return db.prepare('SELECT entry_json FROM history ORDER BY created_at DESC LIMIT 100').all().map((row) => JSON.parse(row.entry_json)); },
    setSetting(key, value) { db.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at').run(key, JSON.stringify(value), new Date().toISOString()); },
    readSettings() { return Object.fromEntries(db.prepare('SELECT key, value_json FROM settings').all().map((row) => [row.key, JSON.parse(row.value_json)])); },
    migrationVersions() { return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version); },
    close() { db.close(); }
  };
}

module.exports = { openDatabase, HISTORY_LIMIT, HISTORY_AGE_MS };
