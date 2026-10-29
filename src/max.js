'use strict';
// Уведомления в мессенджер Max (бот агентства).
// Привязка: сотрудник нажимает в CRM «Подключить Max» → открывает бота по ссылке с кодом (или отправляет код боту).
// Дальше раз в минуту бот присылает: новые задачи, новые заявки, новые номера в «Звонках»; в 9:00 по будням — сводку.
const https = require('node:https');
const http = require('node:http');
const tls = require('node:tls');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { getMeta, setMeta } = require('./db');
const { def, ApiError, audit, str, J, P } = require('./api');
const PREFS = require('./prefs');

const S = db => Object.assign({ enabled: false, token: '', base: process.env.MAX_API || 'https://platform-api2.max.ru', botName: '', botId: null, lastError: '', lastOk: 0, since: 0, marker: null, lastDigest: '', crmUrl: 'https://crm.fedset.ru' }, P(getMeta(db, 'max') || 'null') || {});
const saveS = (db, s) => setMeta(db, 'max', J(s));

// Max требует доверять сертификату Минцифры: install.sh кладёт его в /etc/dg/ru_ca.pem
let CA = null;
function ca() {
  if (CA) return CA;
  const f = process.env.MAX_CA || '/etc/dg/ru_ca.pem';
  CA = [...tls.rootCertificates];
  try { if (fs.existsSync(f)) CA.push(fs.readFileSync(f, 'utf8')); } catch (_) {}
  return CA;
}

function req(s, method, path, query, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(s.base.replace(/\/$/, '') + path);
    Object.entries(query || {}).forEach(([k, v]) => { if (v != null && v !== '') u.searchParams.set(k, String(v)); });
    const data = body ? Buffer.from(J(body)) : null;
    const lib = u.protocol === 'http:' ? http : https;
    const r = lib.request(u, { method, ca: u.protocol === 'https:' ? ca() : undefined, timeout: 40000,
      headers: Object.assign({ Authorization: s.token, Accept: 'application/json' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c);
      res.on('end', () => {
        let d = null; try { d = JSON.parse(b); } catch (_) {}
        if (res.statusCode === 401) return reject(new Error('Max: неверный токен бота'));
        if (res.statusCode === 429) return reject(new Error('Max: слишком много запросов, повторим позже'));
        if (res.statusCode >= 400) return reject(new Error('Max: ошибка ' + res.statusCode + (d && d.message ? ' — ' + d.message : '')));
        resolve(d || {});
      });
    });
    r.on('timeout', () => r.destroy(new Error('Max: нет ответа')));
    r.on('error', e => reject(/certificate|CERT|self.signed|issuer/i.test(e.message) ? new Error('Max: сервер не доверяет сертификату Минцифры. Запустите на сервере: bash /opt/dg/deploy/install.sh') : e));
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- отправка (очередь: не чаще 2 сообщений в секунду в один диалог) ---------- */
const queue = [];
let sending = false;
function send(db, maxUserId, text, link) {
  if (!maxUserId) return;
  queue.push({ maxUserId, text: String(text).slice(0, 3900), link });
  if (!sending) pump(db);
}
async function pump(db) {
  sending = true;
  while (queue.length) {
    const m = queue.shift(), s = S(db);
    if (!s.token) break;
    const body = { text: m.text, format: 'markdown' };
    if (m.link) body.attachments = [{ type: 'inline_keyboard', payload: { buttons: [[{ type: 'link', text: m.link.text || 'Открыть в CRM', url: m.link.url }]] } }];
    try { await req(s, 'POST', '/messages', { user_id: m.maxUserId }, body); }
    catch (e) { const t = S(db); t.lastError = e.message; saveS(db, t); }
    await new Promise(r => setTimeout(r, 600));
  }
  sending = false;
}

/* ---------- привязка сотрудников ---------- */
function newCode(db, userId) {
  const all = P(getMeta(db, 'maxCodes') || '{}') || {};
  const now = Date.now();
  Object.keys(all).forEach(k => { if (all[k].exp < now) delete all[k]; });
  const code = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  all[code] = { userId, exp: now + 30 * 60e3 };
  setMeta(db, 'maxCodes', J(all));
  return code;
}
function useCode(db, code) {
  const all = P(getMeta(db, 'maxCodes') || '{}') || {};
  const x = all[String(code || '').toUpperCase()];
  if (!x || x.exp < Date.now()) return null;
  delete all[String(code).toUpperCase()];
  setMeta(db, 'maxCodes', J(all));
  return x.userId;
}
function userByMax(db, maxUserId) { return PREFS.all(db).find(u => u.active && String(u.prefs.maxUserId) === String(maxUserId)); }

function onUpdate(db, s, up) {
  let maxUser = null, text = '', name = '';
  if (up.update_type === 'bot_started') { maxUser = up.user && up.user.user_id; text = up.payload || ''; name = up.user && (up.user.name || up.user.first_name) || ''; }
  else if (up.update_type === 'message_created' && up.message) { maxUser = up.message.sender && up.message.sender.user_id; text = (up.message.body && up.message.body.text) || ''; name = up.message.sender && (up.message.sender.name || up.message.sender.first_name) || ''; }
  else return;
  if (!maxUser) return;
  const m = String(text).toUpperCase().match(/\b([0-9A-F]{6})\b/);
  const uid = m && useCode(db, m[1]);
  if (uid) {
    PREFS.all(db).forEach(o => { if (o.id !== uid && String(o.prefs.maxUserId) === String(maxUser)) PREFS.set(db, o.id, { maxUserId: null }); });
    PREFS.set(db, uid, { maxUserId: maxUser, maxName: name });
    const u = db.prepare('SELECT name FROM users WHERE id=?').get(uid);
    audit(db, { id: uid, name: u && u.name }, 'подключил Max', 'пользователь', uid, null, null);
    send(db, maxUser, `Готово, ${u ? u.name : ''}! Сюда будут приходить задачи, заявки и звонки из CRM «Дорогой Город».\n\nНапишите **задачи** — пришлю список на сегодня.`);
    return;
  }
  const me = userByMax(db, maxUser);
  if (!me) { send(db, maxUser, 'Это бот CRM «Дорогой Город». Чтобы получать уведомления, откройте CRM → «Профиль» → «Подключить Max».', { text: 'Открыть CRM', url: s.crmUrl }); return; }
  if (/задач|task|сегодня|план/i.test(text)) { send(db, maxUser, digestText(db, me.id, true) || 'На сегодня задач нет.', { text: 'Открыть CRM', url: s.crmUrl }); return; }
  send(db, maxUser, 'Я умею присылать уведомления из CRM. Напишите **задачи** — пришлю список на сегодня.');
}

let polling = false;
async function pollLoop(db) {
  if (polling) return;
  polling = true;
  while (true) {
    const s = S(db);
    if (!s.enabled || !s.token) { polling = false; return; }
    try {
      const r = await req(s, 'GET', '/updates', { timeout: 25, limit: 100, marker: s.marker, types: 'bot_started,message_created' });
      const t = S(db);
      if (r.marker != null) t.marker = r.marker;
      t.lastOk = Date.now(); t.lastError = '';
      saveS(db, t);
      (r.updates || []).forEach(up => { try { onUpdate(db, t, up); } catch (e) { console.error('max update', e); } });
    } catch (e) {
      const t = S(db); t.lastError = e.message; saveS(db, t);
      await new Promise(r => setTimeout(r, 15000));
    }
  }
}

/* ---------- что отправлять ---------- */
const pad = n => String(n).padStart(2, '0');
const msk = (ms = Date.now()) => { const d = new Date(ms + 3 * 3600e3); return { date: d.toISOString().slice(0, 10), h: d.getUTCHours(), m: d.getUTCMinutes(), wd: d.getUTCDay() }; };
const dLbl = (t) => { if (!t.due) return 'без срока'; const today = msk().date; const s = t.due === today ? 'сегодня' : t.due.split('-').reverse().slice(0, 2).join('.'); return s + (t.time ? ' ' + t.time : ''); };
const esc = s => String(s || '').replace(/([*_`\[\]])/g, '\\$1');
function linked(db) { const out = {}; PREFS.all(db).forEach(u => { if (u.active && u.prefs.maxUserId) out[u.id] = u; }); return out; }
function about(db, t) {
  const g = (tb, id) => id && P((db.prepare(`SELECT data FROM ${tb} WHERE id=?`).get(id) || {}).data || 'null');
  const parts = [];
  const c = g('counterparties', t.clientId); if (c) parts.push('Клиент: ' + esc(c.name) + (c.phone ? ', ' + esc(c.phone) : ''));
  const o = g('objects', t.objectId); if (o) parts.push('Объект: ' + esc(o.title || o.address));
  const l = g('leads', t.leadId); if (l) parts.push('Заявка: ' + esc(l.title));
  return parts.join('\n');
}
function digestText(db, userId, force) {
  const today = msk().date;
  const mine = db.prepare('SELECT data FROM tasks WHERE done=0').all().map(r => P(r.data)).filter(t => t && (t.assigneeId === userId || (t.coIds || []).map(Number).includes(userId)));
  const late = mine.filter(t => t.due && t.due < today), now = mine.filter(t => t.due === today).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  if (!late.length && !now.length && !force) return '';
  let txt = `**План на сегодня**\n`;
  if (now.length) txt += now.slice(0, 15).map(t => `• ${t.time ? t.time + ' — ' : ''}${esc(t.title)}`).join('\n') + '\n';
  else txt += 'На сегодня задач нет.\n';
  if (late.length) txt += `\n**Просрочено: ${late.length}**\n` + late.slice(0, 10).map(t => `• ${esc(t.title)} (${dLbl(t)})`).join('\n');
  return txt.trim();
}

function scan(db) {
  const s = S(db);
  if (!s.enabled || !s.token) return;
  const L = linked(db);
  if (!Object.keys(L).length) return;
  const since = s.since || Date.now();
  const link = { text: 'Открыть в CRM', url: s.crmUrl };
  // задачи: исполнителю и соисполнителям, один раз каждому
  for (const r of db.prepare('SELECT id, data FROM tasks WHERE done=0 AND updated_at>=?').all(since)) {
    const t = P(r.data); if (!t) continue;
    const to = [t.assigneeId, ...(t.coIds || []).map(Number)].filter(Boolean), sent = t.mxSent || [];
    const fresh = to.filter(id => !sent.includes(id));
    if (!fresh.length) continue;
    fresh.forEach(id => {
      const u = L[id]; if (!u || !u.prefs.notify.tasks || id === t.createdBy) return;
      const co = id !== t.assigneeId ? ' (вы соисполнитель)' : '';
      send(db, u.prefs.maxUserId, `**Новая задача${co}:** ${esc(t.title)}\nСрок: ${dLbl(t)}${about(db, t) ? '\n' + about(db, t) : ''}${t.note ? '\n' + esc(t.note).slice(0, 500) : ''}`, link);
    });
    t.mxSent = [...new Set([...sent, ...to])];
    db.prepare('UPDATE tasks SET data=? WHERE id=?').run(J(t), r.id);
  }
  // заявки: ответственному
  for (const r of db.prepare("SELECT id, data FROM leads WHERE updated_at>=? AND stage IN ('new','work','show','talks')").all(since)) {
    const l = P(r.data); if (!l || !l.ownerId || (l.mxSent || []).includes(l.ownerId)) continue;
    const u = L[l.ownerId];
    if (u && u.prefs.notify.leads && l.ownerId !== l.createdBy) {
      const c = l.clientId && P((db.prepare('SELECT data FROM counterparties WHERE id=?').get(l.clientId) || {}).data || 'null');
      send(db, u.prefs.maxUserId, `**Новая заявка:** ${esc(l.title)}${c && c.phone ? '\nТелефон: ' + esc(c.phone) : ''}${l.source ? '\nИсточник: ' + esc(l.source) : ''}${l.note ? '\n' + esc(l.note).slice(0, 500) : ''}`, link);
    }
    l.mxSent = [...(l.mxSent || []), l.ownerId];
    db.prepare('UPDATE leads SET data=? WHERE id=?').run(J(l), r.id);
  }
  // новые номера, которые нужно разобрать (пропущенные приходят задачей «Перезвонить»)
  for (const r of db.prepare("SELECT id, data FROM calls WHERE status='new' AND at>=?").all(since - 2 * 3600e3)) {
    const c = P(r.data); if (!c || c.mxSent || c.lost) continue;
    const u = c.userId && L[c.userId];
    if (u && u.prefs.notify.calls) send(db, u.prefs.maxUserId, `**Новый номер:** ${esc(require('./novofon').fmtPhone(c.phone))}, разговор ${Math.floor((c.talk || 0) / 60)}:${pad((c.talk || 0) % 60)}\nРазберите во вкладке «Звонки»: по объекту, заявка, клиент или не клиент.`, { text: 'Открыть звонки', url: s.crmUrl + '/#calls' });
    c.mxSent = true;
    db.prepare('UPDATE calls SET data=? WHERE id=?').run(J(c), r.id);
  }
  // утренняя сводка
  const now = msk();
  if (now.h >= 9 && now.wd >= 1 && now.wd <= 5 && s.lastDigest !== now.date) {
    const t = S(db); t.lastDigest = now.date; saveS(db, t);
    Object.values(L).forEach(u => { if (!u.prefs.notify.digest) return; const txt = digestText(db, u.id, false); if (txt) send(db, u.prefs.maxUserId, `Доброе утро, ${u.name.split(' ')[0]}!\n\n` + txt, link); });
  }
}

function start(db) {
  setInterval(() => { try { scan(db); } catch (e) { console.error('max scan', e); } }, 60e3).unref();
  setTimeout(() => { if (S(db).enabled) pollLoop(db).catch(() => {}); }, 5000).unref();
}

/* ---------- API ---------- */
const pub = s => ({ enabled: s.enabled, hasToken: !!s.token, base: s.base, botName: s.botName, lastError: s.lastError, lastOk: s.lastOk, linked: 0 });
def('maxSettings', 'owner', (db) => Object.assign(pub(S(db)), { linked: Object.keys(linked(db)).length }));
def('saveMaxSettings', 'owner', async (db, u, x) => {
  const s = S(db);
  if (x.token != null && String(x.token).trim()) s.token = str(x.token, 300).trim();
  if (x.base && /^https?:\/\/[\w.-]+(:\d+)?$/.test(String(x.base).trim())) s.base = String(x.base).trim();
  if (!s.token) throw new ApiError('Вставьте токен бота.');
  let me;
  try { me = await req(s, 'GET', '/me'); } catch (e) { s.lastError = e.message; saveS(db, s); throw new ApiError(e.message); }
  s.botName = me.username || me.name || ''; s.botId = me.user_id || null;
  const wasOn = s.enabled;
  s.enabled = x.enabled !== false;
  if (s.enabled && !wasOn) s.since = Date.now();
  s.lastError = ''; s.lastOk = Date.now();
  saveS(db, s);
  audit(db, u, 'настройки Max', 'интеграции', null, null, { enabled: s.enabled, bot: s.botName });
  if (s.enabled) pollLoop(db).catch(() => {});
  return Object.assign(pub(s), { linked: Object.keys(linked(db)).length });
});

def('maxLinkCode', null, (db, u) => {
  const s = S(db);
  if (!s.enabled || !s.token) throw new ApiError('Бот Max ещё не подключён. Попросите учредителя: «Доступ → Интеграции → Max».');
  const code = newCode(db, u.id);
  return { code, link: s.botName ? `https://max.ru/${s.botName}?start=${code}` : '', botName: s.botName };
});
def('maxTest', null, (db, u) => {
  const p = PREFS.get(db, u.id);
  if (!p.maxUserId) throw new ApiError('Max ещё не подключён.');
  send(db, p.maxUserId, `Проверка связи. ${u.name}, уведомления из CRM приходят сюда.\n\n` + (digestText(db, u.id, true) || ''), { text: 'Открыть CRM', url: S(db).crmUrl });
  return { ok: true };
});

module.exports = { start, send, scan, S };
