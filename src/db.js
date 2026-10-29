'use strict';
// База данных: один файл SQLite (встроен в Node.js 22, внешних зависимостей нет).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 6;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.file = file;
  migrate(db);
  return db;
}

// Перед изменением структуры базы — полная копия рядом с базой (папка backups).
function safetyCopy(db, tag) {
  if (!db.file || db.file === ':memory:') return;
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ops'").get();
  if (!has) return; // пустая база — копировать нечего
  const dir = path.join(path.dirname(db.file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `before-${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
  console.log('Копия базы перед обновлением структуры:', f);
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
  if (cur < 2) {
    // CRM: заявки, задачи, объекты, история; доступ к финансам — отдельным правом.
    safetyCopy(db, 'schema-2');
    tx(db, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, stage TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, due TEXT, done INTEGER NOT NULL DEFAULT 0, assignee INTEGER, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS tasks_open ON tasks(done, due);
        CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS activities (
          id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id INTEGER,
          client_id TEXT, lead_id TEXT, deal_id TEXT, object_id TEXT, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS act_client ON activities(client_id, at);
        CREATE INDEX IF NOT EXISTS act_lead ON activities(lead_id, at);
        CREATE INDEX IF NOT EXISTS act_deal ON activities(deal_id, at);
        CREATE INDEX IF NOT EXISTS act_object ON activities(object_id, at);
      `);
      const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
      if (!cols.includes('finance')) db.exec("ALTER TABLE users ADD COLUMN finance TEXT NOT NULL DEFAULT 'none'");
      // прежние роли: бухгалтер → сотрудник с правом вносить финансы; просмотр → просмотр финансов
      db.exec("UPDATE users SET finance='edit' WHERE role='owner'");
      db.exec("UPDATE users SET role='staff', finance='edit' WHERE role='accountant'");
      db.exec("UPDATE users SET finance='view' WHERE role='viewer' AND finance='none'");
      setMeta(db, 'schema', '2');
    });
  }
  if (Number(getMeta(db, 'schema') || 0) < 3) {
    // Карточка объекта: новые статусы, обращения по объекту.
    safetyCopy(db, 'schema-3');
    tx(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS inquiries (id TEXT PRIMARY KEY, object_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS inq_object ON inquiries(object_id, at);`);
      const map = { active: 'active', reserved: 'deposit', closed: 'sold', off: 'paused' };
      for (const r of db.prepare('SELECT id, data FROM objects').all()) {
        let o; try { o = JSON.parse(r.data); } catch (_) { continue; }
        if (!o) continue;
        const st = map[o.status] || (['draft', 'active', 'paused', 'deposit', 'failed', 'sold'].includes(o.status) ? o.status : 'active');
        if (st !== o.status) { o.status = st; db.prepare('UPDATE objects SET data=? WHERE id=?').run(JSON.stringify(o), r.id); }
        if (o.ownerId && !Array.isArray(o.owners)) { o.owners = [o.ownerId]; db.prepare('UPDATE objects SET data=? WHERE id=?').run(JSON.stringify(o), r.id); }
      }
      setMeta(db, 'schema', '3');
    });
  }
  if (Number(getMeta(db, 'schema') || 0) < 4) {
    // Файлы объектов, звонки из телефонии
    safetyCopy(db, 'schema-4');
    tx(db, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY, object_id TEXT NOT NULL, kind TEXT NOT NULL, doc_type TEXT, name TEXT NOT NULL,
          mime TEXT, size INTEGER, pub_key TEXT NOT NULL, has_thumb INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER, created_name TEXT, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS files_object ON files(object_id, kind, sort);
        CREATE UNIQUE INDEX IF NOT EXISTS files_key ON files(pub_key);
        CREATE TABLE IF NOT EXISTS calls (
          id TEXT PRIMARY KEY, at INTEGER NOT NULL, direction TEXT, is_lost INTEGER NOT NULL DEFAULT 0,
          phone TEXT, vnumber TEXT, client_id TEXT, status TEXT NOT NULL DEFAULT 'new', data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS calls_at ON calls(at);
        CREATE INDEX IF NOT EXISTS calls_status ON calls(status);
      `);
      setMeta(db, 'schema', '4');
    });
  }
  if (Number(getMeta(db, 'schema') || 0) < 5) {
    // Справочник (цены, инструкции, шаблоны документов); у обращений появляются этапы
    safetyCopy(db, 'schema-5');
    tx(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS kb (id TEXT PRIMARY KEY, kind TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS kb_kind ON kb(kind, sort);`);
      for (const r of db.prepare('SELECT id, data FROM inquiries').all()) {
        let q; try { q = JSON.parse(r.data); } catch (_) { continue; }
        if (!q || q.stage) continue;
        q.stage = q.leadId ? 'thinking' : 'new';
        db.prepare('UPDATE inquiries SET data=? WHERE id=?').run(JSON.stringify(q), r.id);
      }
      setMeta(db, 'schema', '5');
    });
  }
  if (Number(getMeta(db, 'schema') || 0) < 6) {
    // Настройки пользователя: сотрудник в телефонии, агент в финансах, Max
    safetyCopy(db, 'schema-6');
    tx(db, () => {
      const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
      if (!cols.includes('prefs')) db.exec("ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}'");
      setMeta(db, 'schema', '6');
    });
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

module.exports = { open, getMeta, setMeta, tx, safetyCopy, SCHEMA };
