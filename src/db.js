'use strict';
// База данных: один файл SQLite (встроен в Node.js 22, внешних зависимостей нет).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 1;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const cur = Number(getMeta(db, 'schema') || 0);
  if (cur < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ops (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        archive TEXT,                 -- NULL = текущий период; иначе название архива («Архив до 01.10.2026»)
        include INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ops_date ON ops(date);
      CREATE INDEX IF NOT EXISTS ops_archive ON ops(archive);
      CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counterparties (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (month TEXT PRIMARY KEY, lines TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,           -- owner | accountant | viewer
        pass_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        must_change INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires INTEGER NOT NULL,
        ip TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        user_id INTEGER,
        user_name TEXT,
        action TEXT NOT NULL,
        entity TEXT,
        entity_id TEXT,
        before TEXT,
        after TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
    `);
    if (getMeta(db, 'version') == null) setMeta(db, 'version', '1');
    setMeta(db, 'schema', '1');
  }
}

function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return r ? r.value : null;
}
function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

module.exports = { open, getMeta, setMeta, tx, SCHEMA };
