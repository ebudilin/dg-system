'use strict';
// Пароли (scrypt), сессии в базе, защита от подбора пароля.
const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const ROLES = {
  owner: 'Учредитель',
  staff: 'Сотрудник',
  viewer: 'Только просмотр'
};
// Доступ к разделу «Финансы» выдаёт учредитель каждому отдельно. У учредителя — всегда полный.
const FINANCE = { none: 'Нет доступа', view: 'Просмотр', edit: 'Ввод и правка' };
const finLevel = u => u.role === 'owner' ? 'edit' : (FINANCE[u.finance] ? u.finance : 'none');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}

function checkPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const ref = Buffer.from(keyHex, 'hex');
  return ref.length === key.length && crypto.timingSafeEqual(ref, key);
}

function validatePassword(pw) {
  pw = String(pw || '');
  if (pw.length < 10) return 'Пароль должен быть не короче 10 символов.';
  if (!/[A-Za-zА-Яа-яЁё]/.test(pw) || !/\d/.test(pw)) return 'В пароле должны быть буквы и цифры.';
  return null;
}

function createSession(db, userId, ip) {
  try { db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), userId); } catch (_) { }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400e3;
  db.prepare('INSERT INTO sessions(token,user_id,expires,ip) VALUES(?,?,?,?)').run(token, userId, expires, ip || '');
  return { token, expires };
}

function userBySession(db, token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const r = db.prepare(`SELECT u.id,u.login,u.name,u.role,u.finance,u.active,u.must_change,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(token);
  if (!r || !r.active || r.expires < Date.now()) return null;
  const u = { id: r.id, login: r.login, name: r.name, role: r.role, mustChange: !!r.must_change };
  u.finance = finLevel({ role: r.role, finance: r.finance });
  // Отметка «был в системе» — не чаще раза в 5 минут, чтобы не писать при каждом запросе.
  try {
    const seen = Date.now();
    db.prepare('UPDATE users SET last_seen=? WHERE id=? AND last_seen<?').run(seen, r.id, seen - 5 * 60e3);
  } catch (_) { }
  return u;
}

function dropSession(db, token) { db.prepare('DELETE FROM sessions WHERE token=?').run(String(token || '')); }
function dropUserSessions(db, userId, exceptToken) {
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(userId, String(exceptToken || ''));
}
function purgeSessions(db) { db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()); }

// Ограничение попыток входа: 8 неудач за 15 минут с одного IP или на один логин → пауза.
const fails = new Map();
const WINDOW = 15 * 60e3, LIMIT = 8;
function tooMany(key) {
  const now = Date.now();
  const arr = (fails.get(key) || []).filter(t => now - t < WINDOW);
  fails.set(key, arr);
  return arr.length >= LIMIT;
}
function noteFail(key) { const arr = fails.get(key) || []; arr.push(Date.now()); fails.set(key, arr); }
function clearFails(key) { fails.delete(key); }

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

module.exports = {
  ROLES, FINANCE, finLevel, hashPassword, checkPassword, validatePassword, createSession, userBySession,
  dropSession, dropUserSessions, purgeSessions, tooMany, noteFail, clearFails, parseCookies, SESSION_DAYS
};
