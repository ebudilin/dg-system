'use strict';
// Функции, которые вызывает страница. Повторяют поведение прежней версии на Google Apps Script:
// каждая запись возвращает полный набор данных (loadAll).
const { getMeta, setMeta, tx } = require('./db');
const auth = require('./auth');

// Права: null — любой вошедший; crm_w — правка CRM; fin_r / fin_w — просмотр / правка финансов; owner — только учредитель.
const PERMS = {
  crm_w: u => u.role === 'owner' || u.role === 'staff',
  fin_r: u => u.finance === 'view' || u.finance === 'edit',
  fin_w: u => u.finance === 'edit',
  owner: u => u.role === 'owner'
};
const can = (u, perm) => !perm || (PERMS[perm] ? PERMS[perm](u) : false);
const CP_TYPES = ['owner', 'buyer', 'tenant', 'agent', 'partner', 'founder', 'employee', 'investor'];

class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status || 400; } }

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const numOrBlank = v => (v === '' || v === null || v === undefined) ? '' : Number(v);
const str = (v, max = 2000) => String(v == null ? '' : v).slice(0, max);
const J = v => JSON.stringify(v);
const P = s => { try { return JSON.parse(s); } catch (_) { return null; } };

function bump(db) { setMeta(db, 'version', Number(getMeta(db, 'version') || 0) + 1); }

function audit(db, user, action, entity, id, before, after) {
  db.prepare('INSERT INTO audit(at,user_id,user_name,action,entity,entity_id,before,after) VALUES(?,?,?,?,?,?,?,?)')
    .run(Date.now(), user ? user.id : null, user ? user.name : 'система', action, entity || null, id == null ? null : String(id),
      before == null ? null : J(before), after == null ? null : J(after));
}

/* ---------- нормализация входных данных ---------- */
function cleanOp(o) {
  if (!o || !o.id || !isDate(o.date) || !(Number(o.amount) > 0)) throw new ApiError('Неполные данные операции.');
  const type = ['in', 'out', 'tr'].includes(o.type) ? o.type : 'in';
  const r = { id: str(o.id, 64), date: o.date, type, amount: Number(o.amount), acc: str(o.acc, 64), comment: str(o.comment), createdAt: Number(o.createdAt) || Date.now() };
  if (type === 'tr') r.toAcc = str(o.toAcc, 64);
  else {
    r.cat = str(o.cat, 64); r.party = str(o.party, 300);
    if (o.dealId) r.dealId = str(o.dealId, 64);
    if (o.agentId) r.agentId = str(o.agentId, 64);
    if (o.pnlMonth && /^\d{4}-\d{2}$/.test(o.pnlMonth)) r.pnlMonth = o.pnlMonth;
    if (o.cpId) r.cpId = str(o.cpId, 64);
  }
  return r;
}

function cleanDeal(d) {
  if (!d || !d.id || !String(d.client || '').trim()) throw new ApiError('Неполные данные сделки.');
  return {
    id: str(d.id, 64), date: isDate(d.date) ? d.date : '', client: str(d.client, 300).trim(), object: str(d.object, 500), kind: str(d.kind, 100),
    status: str(d.status || 'work', 32), commission: Number(d.commission) || 0, share: numOrBlank(d.share), fixedPay: numOrBlank(d.fixedPay),
    expected: isDate(d.expected) ? d.expected : '', note: str(d.note), agentId: str(d.agentId, 64), clientId: str(d.clientId, 64),
    objectId: str(d.objectId, 64),
    extra: (Array.isArray(d.extra) ? d.extra : []).filter(x => x && x.agentId).slice(0, 2)
      .map(x => ({ agentId: str(x.agentId, 64), share: numOrBlank(x.share), fixedPay: numOrBlank(x.fixedPay) }))
  };
}

function cleanClient(c) {
  if (!c || !c.id || !String(c.name || '').trim()) throw new ApiError('Укажите ФИО или название контрагента.');
  return {
    id: str(c.id, 64), name: str(c.name, 300).trim(), types: (Array.isArray(c.types) ? c.types : []).filter(t => CP_TYPES.includes(t)),
    birth: isDate(c.birth) ? c.birth : '', phone: str(c.phone, 200), email: str(c.email, 200), other: str(c.other), note: str(c.note),
    agentShare: numOrBlank(c.agentShare), createdAt: Number(c.createdAt) || Date.now()
  };
}

function archName(beforeDate) {
  const [y, m, d] = beforeDate.split('-');
  return `Архив до ${d}.${m}.${y}`;
}

/* ---------- чтение ---------- */
const meOf = user => ({ id: user.id, login: user.login, name: user.name, role: user.role, roleName: auth.ROLES[user.role] || user.role,
  finance: user.finance, financeName: auth.FINANCE[user.finance] || '', mustChange: user.mustChange });

function loadAll(db, user) {
  const ops = [], archOps = [];
  for (const r of db.prepare('SELECT data, archive, include FROM ops ORDER BY date, created_at').all()) {
    const o = P(r.data); if (!o) continue;
    if (r.archive) { o.include = !!r.include; o.sheet = r.archive; archOps.push(o); } else ops.push(o);
  }
  const plans = {};
  for (const r of db.prepare('SELECT month, lines FROM plans').all()) plans[r.month] = { lines: P(r.lines) || {} };
  return {
    version: Number(getMeta(db, 'version') || 0),
    cfg: P(getMeta(db, 'cfg') || 'null'),
    ops, archOps,
    deals: db.prepare('SELECT data FROM deals').all().map(r => P(r.data)).filter(Boolean),
    clients: db.prepare('SELECT data FROM counterparties').all().map(r => P(r.data)).filter(Boolean),
    plans,
    me: meOf(user)
  };
}

/* ---------- функции API ---------- */
const F = {};
const def = (name, roles, fn) => { F[name] = { roles, fn }; };

def('getVersion', null, (db) => Number(getMeta(db, 'version') || 0));
def('loadAll', 'fin_r', (db, u) => loadAll(db, u));

def('saveOp', 'fin_w', (db, u, o) => {
  const op = cleanOp(o);
  tx(db, () => {
    const prev = db.prepare('SELECT data, archive FROM ops WHERE id=?').get(op.id);
    if (prev && prev.archive) throw new ApiError('Эта операция в архиве — откройте её из архивного месяца.');
    db.prepare(`INSERT INTO ops(id,date,archive,include,created_at,data) VALUES(?,?,NULL,1,?,?)
      ON CONFLICT(id) DO UPDATE SET date=excluded.date, data=excluded.data`).run(op.id, op.date, op.createdAt, J(op));
    audit(db, u, prev ? 'изменение' : 'создание', 'операция', op.id, prev ? P(prev.data) : null, op);
    bump(db);
  });
  return loadAll(db, u);
});

def('deleteOp', 'fin_w', (db, u, id) => {
  tx(db, () => {
    const prev = db.prepare('SELECT data FROM ops WHERE id=? AND archive IS NULL').get(str(id, 64));
    if (!prev) return;
    db.prepare('DELETE FROM ops WHERE id=? AND archive IS NULL').run(str(id, 64));
    audit(db, u, 'удаление', 'операция', id, P(prev.data), null);
    bump(db);
  });
  return loadAll(db, u);
});

def('saveArchOp', 'fin_w', (db, u, o, _names, sheet, include) => {
  const op = cleanOp(o);
  sheet = str(sheet, 100);
  if (sheet.indexOf('Архив до ') !== 0) throw new ApiError('Неверный архив.');
  tx(db, () => {
    const prev = db.prepare('SELECT data, archive FROM ops WHERE id=?').get(op.id);
    if (prev && !prev.archive) throw new ApiError('Эта операция не в архиве.');
    db.prepare(`INSERT INTO ops(id,date,archive,include,created_at,data) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET date=excluded.date, data=excluded.data, include=excluded.include`)
      .run(op.id, op.date, sheet, include === false ? 0 : 1, op.createdAt, J(op));
    audit(db, u, prev ? 'изменение (архив)' : 'создание (архив)', 'операция', op.id, prev ? P(prev.data) : null, op);
    bump(db);
  });
  return loadAll(db, u);
});

def('setArchInclude', 'fin_w', (db, u, sheet, ids, include) => {
  sheet = str(sheet, 100);
  ids = (Array.isArray(ids) ? ids : []).map(i => str(i, 64));
  tx(db, () => {
    const st = db.prepare('UPDATE ops SET include=? WHERE id=? AND archive=?');
    ids.forEach(id => st.run(include ? 1 : 0, id, sheet));
    audit(db, u, include ? 'учитывать (архив)' : 'не учитывать (архив)', 'операции', ids.length + ' шт.', null, ids);
    bump(db);
  });
  return loadAll(db, u);
});

def('saveDeal', 'fin_w', (db, u, d) => {
  const deal = cleanDeal(d);
  tx(db, () => {
    const prev = db.prepare('SELECT data FROM deals WHERE id=?').get(deal.id);
    // поля, которые ведутся в CRM (объект), раздел «Финансы» не передаёт — сохраняем прежние
    if (prev && (d.objectId === undefined)) deal.objectId = (P(prev.data) || {}).objectId || '';
    db.prepare('INSERT INTO deals(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(deal.id, J(deal));
    audit(db, u, prev ? 'изменение' : 'создание', 'сделка', deal.id, prev ? P(prev.data) : null, deal);
    bump(db);
  });
  return loadAll(db, u);
});

def('deleteDeal', 'fin_w', (db, u, id) => {
  tx(db, () => {
    const prev = db.prepare('SELECT data FROM deals WHERE id=?').get(str(id, 64));
    if (!prev) return;
    db.prepare('DELETE FROM deals WHERE id=?').run(str(id, 64));
    audit(db, u, 'удаление', 'сделка', id, P(prev.data), null);
    bump(db);
  });
  return loadAll(db, u);
});

function saveClientTx(db, u, c) {
  const cp = cleanClient(c);
  tx(db, () => {
    const prev = db.prepare('SELECT data FROM counterparties WHERE id=?').get(cp.id);
    db.prepare('INSERT INTO counterparties(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(cp.id, J(cp));
    // имя клиента хранится и в сделке (для поиска) — обновляем
    for (const r of db.prepare('SELECT id, data FROM deals').all()) {
      const d = P(r.data);
      if (d && d.clientId === cp.id && d.client !== cp.name) { d.client = cp.name; db.prepare('UPDATE deals SET data=? WHERE id=?').run(J(d), r.id); }
    }
    audit(db, u, prev ? 'изменение' : 'создание', 'контрагент', cp.id, prev ? P(prev.data) : null, cp);
    bump(db);
  });
  return cp;
}
def('saveClient', 'fin_w', (db, u, c) => { saveClientTx(db, u, c); return loadAll(db, u); });

function clientInUse(db, id) {
  const needle = '"' + id + '"';
  const q = (t) => db.prepare(`SELECT 1 FROM ${t} WHERE instr(data, ?) > 0 LIMIT 1`).get(needle);
  return q('deals') || q('ops') || q('leads') || q('objects') || q('tasks')
    || db.prepare('SELECT 1 FROM activities WHERE client_id=? LIMIT 1').get(id);
}
function deleteClientTx(db, u, id) {
  id = str(id, 64);
  if (clientInUse(db, id)) throw new ApiError('Контрагент используется в сделках, операциях, заявках или объектах — удалить нельзя.');
  tx(db, () => {
    const prev = db.prepare('SELECT data FROM counterparties WHERE id=?').get(str(id, 64));
    if (!prev) return;
    db.prepare('DELETE FROM counterparties WHERE id=?').run(str(id, 64));
    audit(db, u, 'удаление', 'контрагент', id, P(prev.data), null);
    bump(db);
  });
}
def('deleteClient', 'fin_w', (db, u, id) => { deleteClientTx(db, u, id); return loadAll(db, u); });

def('savePlan', 'fin_w', (db, u, month, lines) => {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new ApiError('Неверный месяц плана.');
  tx(db, () => {
    db.prepare('INSERT INTO plans(month,lines) VALUES(?,?) ON CONFLICT(month) DO UPDATE SET lines=excluded.lines').run(month, J(lines || {}));
    audit(db, u, 'изменение', 'план', month, null, lines || {});
    bump(db);
  });
  return loadAll(db, u);
});

def('saveConfig', 'owner', (db, u, cfg) => {
  if (!cfg || !Array.isArray(cfg.accounts) || !Array.isArray(cfg.categories)) throw new ApiError('Неполные настройки.');
  tx(db, () => {
    const prev = P(getMeta(db, 'cfg') || 'null');
    setMeta(db, 'cfg', J(cfg));
    audit(db, u, 'изменение', 'настройки', null, prev, cfg);
    bump(db);
  });
  return loadAll(db, u);
});

def('closePeriod', 'owner', (db, u, beforeDate, cfg) => {
  if (!isDate(beforeDate)) throw new ApiError('Неверная дата закрытия периода.');
  if (!cfg || !Array.isArray(cfg.accounts) || !Array.isArray(cfg.categories)) throw new ApiError('Неполные настройки.');
  tx(db, () => {
    const name = archName(beforeDate);
    const n = db.prepare('UPDATE ops SET archive=?, include=1 WHERE archive IS NULL AND date<?').run(name, beforeDate).changes;
    setMeta(db, 'cfg', J(cfg));
    audit(db, u, 'закрытие периода', 'операции', name, null, { moved: n });
    bump(db);
  });
  return loadAll(db, u);
});

/* ---------- пользователи ---------- */
def('changeOwnPassword', null, (db, u, oldPw, newPw) => {
  const row = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(u.id);
  if (!row || !auth.checkPassword(oldPw, row.pass_hash)) throw new ApiError('Текущий пароль указан неверно.');
  const bad = auth.validatePassword(newPw); if (bad) throw new ApiError(bad);
  db.prepare('UPDATE users SET pass_hash=?, must_change=0 WHERE id=?').run(auth.hashPassword(newPw), u.id);
  auth.dropUserSessions(db, u.id, u.token);
  audit(db, u, 'смена пароля', 'пользователь', u.id, null, null);
  return { ok: true };
});

const userRow = r => ({ id: r.id, login: r.login, name: r.name, role: r.role, roleName: auth.ROLES[r.role] || r.role, finance: auth.finLevel(r), active: !!r.active, mustChange: !!r.must_change, createdAt: r.created_at });

def('listUsers', 'owner', (db) => ({
  roles: auth.ROLES, finance: auth.FINANCE,
  users: db.prepare('SELECT * FROM users ORDER BY active DESC, name').all().map(userRow)
}));

def('saveUser', 'owner', (db, u, x) => {
  if (!x || !String(x.name || '').trim()) throw new ApiError('Укажите имя пользователя.');
  if (!auth.ROLES[x.role]) throw new ApiError('Неизвестная роль.');
  const name = str(x.name, 100).trim();
  const fin = x.role === 'owner' ? 'edit' : (auth.FINANCE[x.finance] ? x.finance : 'none');
  if (x.id) {
    const prev = db.prepare('SELECT * FROM users WHERE id=?').get(Number(x.id));
    if (!prev) throw new ApiError('Пользователь не найден.');
    if (prev.id === u.id && (x.role !== 'owner' || x.active === false)) throw new ApiError('Нельзя снять с себя права учредителя или отключить себя.');
    db.prepare('UPDATE users SET name=?, role=?, finance=?, active=? WHERE id=?').run(name, x.role, fin, x.active === false ? 0 : 1, prev.id);
    if (x.active === false) auth.dropUserSessions(db, prev.id, '');
    audit(db, u, 'изменение', 'пользователь', prev.id, userRow(prev), { name, role: x.role, finance: fin, active: x.active !== false });
  } else {
    const login = str(x.login, 64).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(login)) throw new ApiError('Логин: от 3 символов, латинские буквы, цифры, точка, дефис.');
    if (db.prepare('SELECT 1 FROM users WHERE login=?').get(login)) throw new ApiError('Такой логин уже есть.');
    const bad = auth.validatePassword(x.password); if (bad) throw new ApiError(bad);
    const r = db.prepare('INSERT INTO users(login,name,role,finance,pass_hash,active,must_change,created_at) VALUES(?,?,?,?,?,1,1,?)')
      .run(login, name, x.role, fin, auth.hashPassword(x.password), Date.now());
    audit(db, u, 'создание', 'пользователь', r.lastInsertRowid, null, { login, name, role: x.role, finance: fin });
  }
  return F.listUsers.fn(db, u);
});

def('resetUserPassword', 'owner', (db, u, id, pw) => {
  const prev = db.prepare('SELECT * FROM users WHERE id=?').get(Number(id));
  if (!prev) throw new ApiError('Пользователь не найден.');
  const bad = auth.validatePassword(pw); if (bad) throw new ApiError(bad);
  db.prepare('UPDATE users SET pass_hash=?, must_change=1 WHERE id=?').run(auth.hashPassword(pw), prev.id);
  auth.dropUserSessions(db, prev.id, '');
  audit(db, u, 'сброс пароля', 'пользователь', prev.id, null, null);
  return F.listUsers.fn(db, u);
});

def('listAudit', 'owner', (db, u, limit) => db.prepare('SELECT id,at,user_name,action,entity,entity_id FROM audit ORDER BY id DESC LIMIT ?')
  .all(Math.min(500, Math.max(1, Number(limit) || 200))));

/* ---------- импорт / экспорт ---------- */
const CRM_TABLES = ['leads', 'tasks', 'objects', 'activities', 'inquiries'];
function exportCrm(db) {
  const out = {};
  CRM_TABLES.forEach(t => { out[t] = db.prepare(`SELECT data FROM ${t}`).all().map(r => P(r.data)).filter(Boolean); });
  return out;
}

def('exportData', 'owner', (db, u) => {
  const d = loadAll(db, u); delete d.me;
  d.crm = exportCrm(db);
  d.exportedAt = new Date().toISOString(); return d;
});

def('importData', 'owner', (db, u, data, confirm) => {
  if (confirm !== 'ЗАМЕНИТЬ') throw new ApiError('Для восстановления нужно подтверждение.');
  if (!data || !Array.isArray(data.ops) || !Array.isArray(data.deals) || !Array.isArray(data.clients)) throw new ApiError('Файл не похож на выгрузку системы.');
  require('./db').safetyCopy(db, 'import');
  const counts = {};
  tx(db, () => {
    db.exec('DELETE FROM ops; DELETE FROM deals; DELETE FROM counterparties; DELETE FROM plans;');
    const ins = db.prepare('INSERT INTO ops(id,date,archive,include,created_at,data) VALUES(?,?,?,?,?,?)');
    let n = 0, a = 0;
    for (const o of data.ops) { const op = cleanOp(o); ins.run(op.id, op.date, null, 1, op.createdAt, J(op)); n++; }
    for (const o of (data.archOps || [])) {
      const op = cleanOp(o); const sheet = str(o.sheet || 'Архив', 100);
      ins.run(op.id, op.date, sheet.indexOf('Архив до ') === 0 ? sheet : 'Архив до 01.01.2000', o.include === false ? 0 : 1, op.createdAt, J(op)); a++;
    }
    const insD = db.prepare('INSERT INTO deals(id,data) VALUES(?,?)');
    data.deals.forEach(d => { const x = cleanDeal(d); insD.run(x.id, J(x)); });
    const insC = db.prepare('INSERT INTO counterparties(id,data) VALUES(?,?)');
    data.clients.forEach(c => { const x = cleanClient(c); insC.run(x.id, J(x)); });
    const insP = db.prepare('INSERT INTO plans(month,lines) VALUES(?,?)');
    Object.entries(data.plans || {}).forEach(([m, p]) => { if (/^\d{4}-\d{2}$/.test(m)) insP.run(m, J((p && p.lines) || {})); });
    if (data.cfg) setMeta(db, 'cfg', J(data.cfg));
    Object.assign(counts, { ops: n, archOps: a, deals: data.deals.length, clients: data.clients.length, plans: Object.keys(data.plans || {}).length });
    // CRM восстанавливается, только если он есть в файле; иначе заявки, задачи, объекты и история не трогаются
    if (data.crm && typeof data.crm === 'object') {
      const crm = require('./crm');
      crm.restore(db, data.crm);
      CRM_TABLES.forEach(t => { counts[t] = (data.crm[t] || []).length; });
    }
    audit(db, u, 'восстановление из файла', 'система', null, null, counts);
    bump(db);
  });
  return counts;
});

module.exports = { F, def, can, ApiError, loadAll, meOf, audit, bump, tx, str, isDate, numOrBlank, J, P, cleanDeal, saveClientTx, deleteClientTx };
