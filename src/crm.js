'use strict';
// CRM: заявки (воронка), задачи, объекты, история работы с клиентом.
// Финансовые поля сделок видны и меняются только при доступе к финансам.
const { getMeta } = require('./db');
const auth = require('./auth');
const { def, can, ApiError, meOf, audit, bump, tx, str, isDate, numOrBlank, J, P, cleanDeal, saveClientTx, deleteClientTx } = require('./api');

const STAGES = { new: 'Новая', work: 'В работе', show: 'Показы', talks: 'Переговоры', won: 'Договор', lost: 'Отказ' };
const LEAD_KINDS = { buy: 'Покупка', sell: 'Продажа', rent: 'Снять в аренду', lease: 'Сдать в аренду', commercial: 'Коммерция', legal: 'Юр. сопровождение', other: 'Другое' };
const OBJ = require('./objects');
const OBJ_KINDS = OBJ.D.kinds, OBJ_STATUS = OBJ.D.status;
const DEAL_ST = { work: 'В работе', deal: 'Договор подписан', closed: 'Закрыта', lost: 'Сорвалась' };
const ACT_TYPES = { call: 'Звонок', meeting: 'Встреча', show: 'Показ', message: 'Сообщение', note: 'Заметка', event: 'Событие' };
const DEAL_KIND_BY_LEAD = { buy: 'Вторичка', sell: 'Вторичка', rent: 'Аренда', lease: 'Аренда', commercial: 'Коммерция', legal: 'Юр. сопровождение', other: 'Вторичка' };
const CP_TYPE_BY_LEAD = { buy: 'buyer', sell: 'owner', rent: 'tenant', lease: 'owner', commercial: 'buyer', legal: 'buyer', other: '' };

const uid = p => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => Date.now();
const userExists = (db, id) => !!db.prepare('SELECT 1 FROM users WHERE id=?').get(Number(id));
const optUser = (db, id) => (id && userExists(db, id)) ? Number(id) : null;
const optRef = (db, table, id) => { id = str(id, 64); return id && db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id) ? id : ''; };

/* ---------- чтение ---------- */
function stripDeal(d, fin) {
  if (fin) return d;
  const x = Object.assign({}, d);
  delete x.commission; delete x.share; delete x.fixedPay;
  x.extra = (x.extra || []).map(e => ({ agentId: e.agentId }));
  return x;
}

function crmLoad(db, u) {
  const fin = can(u, 'fin_r');
  const rows = (t, order) => db.prepare(`SELECT data FROM ${t}${order ? ' ORDER BY ' + order : ''}`).all().map(r => P(r.data)).filter(Boolean);
  const monthAgo = now() - 45 * 86400e3;
  return {
    version: Number(getMeta(db, 'version') || 0),
    me: meOf(u),
    users: db.prepare('SELECT id, name, active FROM users ORDER BY name').all().map(r => ({ id: r.id, name: r.name, active: !!r.active })),
    clients: rows('counterparties'),
    deals: rows('deals').map(d => stripDeal(d, fin)),
    leads: rows('leads', 'updated_at DESC'),
    tasks: db.prepare('SELECT data FROM tasks WHERE done=0 OR updated_at>? ORDER BY due').all(monthAgo).map(r => P(r.data)).filter(Boolean),
    objects: rows('objects', 'updated_at DESC'),
    inq: OBJ.inquiryCounts(db),
    dict: { stages: STAGES, leadKinds: LEAD_KINDS, objKinds: OBJ_KINDS, objStatus: OBJ_STATUS, actTypes: ACT_TYPES, obj: OBJ.D }
  };
}

def('crmLoad', null, (db, u) => crmLoad(db, u));

/* ---------- история ---------- */
function addActivity(db, u, a) {
  const id = a.id || uid('act');
  const x = {
    id, type: ACT_TYPES[a.type] ? a.type : 'note', text: str(a.text, 5000), at: Number(a.at) || now(),
    userId: a.userId != null ? a.userId : (u ? u.id : null), userName: a.userName || (u ? u.name : ''),
    clientId: str(a.clientId, 64), leadId: str(a.leadId, 64), dealId: str(a.dealId, 64), objectId: str(a.objectId, 64)
  };
  db.prepare(`INSERT INTO activities(id,at,user_id,client_id,lead_id,deal_id,object_id,data) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET at=excluded.at, client_id=excluded.client_id, lead_id=excluded.lead_id, deal_id=excluded.deal_id, object_id=excluded.object_id, data=excluded.data`)
    .run(id, x.at, x.userId, x.clientId || null, x.leadId || null, x.dealId || null, x.objectId || null, J(x));
  return x;
}

def('listActivities', null, (db, u, f) => {
  f = f || {};
  const cond = [], args = [];
  if (f.clientId) { cond.push('client_id=?'); args.push(str(f.clientId, 64)); }
  if (f.leadId) { cond.push('lead_id=?'); args.push(str(f.leadId, 64)); }
  if (f.dealId) { cond.push('deal_id=?'); args.push(str(f.dealId, 64)); }
  if (f.objectId) { cond.push('object_id=?'); args.push(str(f.objectId, 64)); }
  if (!cond.length) return [];
  return db.prepare(`SELECT data FROM activities WHERE ${cond.join(' OR ')} ORDER BY at DESC LIMIT 300`).all(...args).map(r => P(r.data)).filter(Boolean);
});

def('saveActivity', 'crm_w', (db, u, a) => {
  if (!a || !String(a.text || '').trim()) throw new ApiError('Напишите, что произошло.');
  if (!a.clientId && !a.leadId && !a.dealId && !a.objectId) throw new ApiError('Запись должна относиться к клиенту, заявке, сделке или объекту.');
  let x;
  tx(db, () => {
    if (a.id) {
      const prev = db.prepare('SELECT data FROM activities WHERE id=?').get(str(a.id, 64));
      if (!prev) throw new ApiError('Запись не найдена.');
      const p = P(prev.data);
      if (p.userId !== u.id && u.role !== 'owner') throw new ApiError('Изменять запись может только её автор или учредитель.');
      x = addActivity(db, u, Object.assign({}, a, { userId: p.userId, userName: p.userName }));
    } else x = addActivity(db, u, a);
    bump(db);
  });
  return x;
});

def('deleteActivity', 'crm_w', (db, u, id) => {
  tx(db, () => {
    const prev = db.prepare('SELECT data FROM activities WHERE id=?').get(str(id, 64));
    if (!prev) return;
    const p = P(prev.data);
    if (p.userId !== u.id && u.role !== 'owner') throw new ApiError('Удалить запись может только её автор или учредитель.');
    db.prepare('DELETE FROM activities WHERE id=?').run(p.id);
    audit(db, u, 'удаление', 'запись истории', p.id, p, null);
    bump(db);
  });
  return { ok: true };
});

/* ---------- заявки ---------- */
function cleanLead(db, l, prev) {
  if (!l) throw new ApiError('Нет данных заявки.');
  const x = {
    id: str(l.id || (prev && prev.id) || uid('lead'), 64),
    title: str(l.title, 300).trim(),
    clientId: optRef(db, 'counterparties', l.clientId),
    kind: LEAD_KINDS[l.kind] ? l.kind : 'other',
    source: str(l.source, 100).trim(),
    budget: numOrBlank(l.budget),
    stage: STAGES[l.stage] ? l.stage : 'new',
    ownerId: optUser(db, l.ownerId),
    objectId: optRef(db, 'objects', l.objectId),
    dealId: optRef(db, 'deals', l.dealId),
    note: str(l.note, 5000),
    lostReason: str(l.lostReason, 300),
    createdAt: (prev && prev.createdAt) || now(),
    createdBy: (prev && prev.createdBy) || null,
    stageAt: (prev && prev.stage === l.stage && prev.stageAt) || now(),
    updatedAt: now()
  };
  return x;
}

function saveLeadTx(db, u, l) {
  let res;
  tx(db, () => {
    const prevRow = l && l.id ? db.prepare('SELECT data FROM leads WHERE id=?').get(str(l.id, 64)) : null;
    const prev = prevRow ? P(prevRow.data) : null;
    // быстрый ввод: новый клиент по имени и телефону
    if (l && !l.clientId && String(l.newClientName || '').trim()) {
      const t = CP_TYPE_BY_LEAD[l.kind];
      const cp = saveClientNoTx(db, u, { id: uid('cl'), name: l.newClientName, phone: l.newClientPhone || '', types: t ? [t] : [] });
      l = Object.assign({}, l, { clientId: cp.id });
    }
    const x = cleanLead(db, l, prev);
    if (!x.title) {
      const c = x.clientId ? P((db.prepare('SELECT data FROM counterparties WHERE id=?').get(x.clientId) || {}).data || 'null') : null;
      x.title = [LEAD_KINDS[x.kind], c && c.name].filter(Boolean).join(' — ') || 'Заявка';
    }
    if (!prev) x.createdBy = u.id;
    if (x.stage === 'lost' && !x.lostReason) throw new ApiError('Укажите причину отказа.');
    db.prepare('INSERT INTO leads(id,stage,updated_at,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET stage=excluded.stage, updated_at=excluded.updated_at, data=excluded.data')
      .run(x.id, x.stage, x.updatedAt, J(x));
    if (!prev) addActivity(db, u, { type: 'event', text: `Создана заявка «${x.title}»` + (x.source ? `, источник: ${x.source}` : ''), clientId: x.clientId, leadId: x.id });
    else if (prev.stage !== x.stage) addActivity(db, u, { type: 'event', text: `Этап: ${STAGES[prev.stage] || prev.stage} → ${STAGES[x.stage]}` + (x.stage === 'lost' ? `. Причина: ${x.lostReason}` : ''), clientId: x.clientId, leadId: x.id });
    audit(db, u, prev ? 'изменение' : 'создание', 'заявка', x.id, prev, x);
    bump(db);
    res = x;
  });
  return res;
}

// контрагент внутри уже открытой транзакции
function saveClientNoTx(db, u, c) {
  const name = str(c.name, 300).trim();
  if (!name) throw new ApiError('Укажите имя клиента.');
  const cp = { id: str(c.id, 64), name, types: c.types || [], birth: '', phone: str(c.phone, 200), email: '', other: '', note: '', agentShare: '', createdAt: now() };
  db.prepare('INSERT INTO counterparties(id,data) VALUES(?,?)').run(cp.id, J(cp));
  audit(db, u, 'создание', 'контрагент', cp.id, null, cp);
  return cp;
}

def('saveLead', 'crm_w', (db, u, l) => { saveLeadTx(db, u, l); return crmLoad(db, u); });

def('setLeadStage', 'crm_w', (db, u, id, stage, lostReason) => {
  const row = db.prepare('SELECT data FROM leads WHERE id=?').get(str(id, 64));
  if (!row) throw new ApiError('Заявка не найдена.');
  const l = P(row.data);
  saveLeadTx(db, u, Object.assign({}, l, { stage, lostReason: stage === 'lost' ? (lostReason || l.lostReason) : l.lostReason }));
  return crmLoad(db, u);
});

def('deleteLead', 'crm_w', (db, u, id) => {
  tx(db, () => {
    const row = db.prepare('SELECT data FROM leads WHERE id=?').get(str(id, 64));
    if (!row) return;
    db.prepare('DELETE FROM leads WHERE id=?').run(str(id, 64));
    audit(db, u, 'удаление', 'заявка', id, P(row.data), null);
    bump(db);
  });
  return crmLoad(db, u);
});

// Заявка → сделка: создаётся сделка в работе, заявка переходит в «Договор».
def('leadToDeal', 'crm_w', (db, u, id, f) => {
  f = f || {};
  tx(db, () => {
    const row = db.prepare('SELECT data FROM leads WHERE id=?').get(str(id, 64));
    if (!row) throw new ApiError('Заявка не найдена.');
    const l = P(row.data);
    if (l.dealId && db.prepare('SELECT 1 FROM deals WHERE id=?').get(l.dealId)) throw new ApiError('По заявке уже есть сделка.');
    if (!l.clientId) throw new ApiError('Сначала укажите клиента в заявке.');
    const c = P(db.prepare('SELECT data FROM counterparties WHERE id=?').get(l.clientId).data);
    const obj = l.objectId ? P((db.prepare('SELECT data FROM objects WHERE id=?').get(l.objectId) || {}).data || 'null') : null;
    const d = cleanDeal({
      id: uid('deal'), client: c.name, clientId: c.id, object: str(f.object || (obj && (obj.title || obj.address)) || '', 500),
      kind: str(f.kind || DEAL_KIND_BY_LEAD[l.kind] || 'Вторичка', 100), status: 'work', date: isDate(f.date) ? f.date : new Date().toISOString().slice(0, 10),
      commission: can(u, 'fin_w') ? Number(f.commission) || 0 : 0, agentId: str(f.agentId, 64), note: str(f.note || l.note, 2000)
    });
    db.prepare('INSERT INTO deals(id,data) VALUES(?,?)').run(d.id, J(d));
    l.dealId = d.id; const was = l.stage; l.stage = 'won'; l.stageAt = now(); l.updatedAt = now();
    db.prepare('UPDATE leads SET stage=?, updated_at=?, data=? WHERE id=?').run(l.stage, l.updatedAt, J(l), l.id);
    addActivity(db, u, { type: 'event', text: `Заключён договор — создана сделка` + (was !== 'won' ? ` (этап: ${STAGES[was]} → Договор)` : ''), clientId: l.clientId, leadId: l.id, dealId: d.id });
    audit(db, u, 'создание из заявки', 'сделка', d.id, null, d);
    bump(db);
  });
  return crmLoad(db, u);
});

/* ---------- сделки из CRM (без денег, если нет доступа к финансам) ---------- */
def('crmSaveDeal', 'crm_w', (db, u, d) => {
  if (!d || !d.id) throw new ApiError('Нет данных сделки.');
  tx(db, () => {
    const row = db.prepare('SELECT data FROM deals WHERE id=?').get(str(d.id, 64));
    if (!row) throw new ApiError('Сделка не найдена. Новые сделки создаются из заявки.');
    const prev = P(row.data);
    const fin = can(u, 'fin_w');
    const merged = Object.assign({}, prev, {
      object: d.object, kind: d.kind, status: d.status, date: d.date, expected: d.expected, note: d.note,
      clientId: d.clientId || prev.clientId, agentId: d.agentId
    });
    if (d.clientId) { const c = db.prepare('SELECT data FROM counterparties WHERE id=?').get(str(d.clientId, 64)); if (c) merged.client = P(c.data).name; }
    const prevExtra = prev.extra || [];
    merged.extra = (Array.isArray(d.extra) ? d.extra : []).filter(x => x && x.agentId).slice(0, 2).map(x => {
      if (fin) return x;
      const old = prevExtra.find(e => e.agentId === x.agentId) || {};
      return { agentId: x.agentId, share: old.share ?? '', fixedPay: old.fixedPay ?? '' };
    });
    if (fin) { merged.commission = d.commission; merged.share = d.share; merged.fixedPay = d.fixedPay; }
    else if (d.agentId !== prev.agentId) { merged.share = ''; merged.fixedPay = ''; }
    const x = cleanDeal(merged);
    db.prepare('UPDATE deals SET data=? WHERE id=?').run(J(x), x.id);
    if (prev.status !== x.status) addActivity(db, u, { type: 'event', text: `Статус сделки: ${DEAL_ST[prev.status] || prev.status} → ${DEAL_ST[x.status] || x.status}`, clientId: x.clientId, dealId: x.id });
    audit(db, u, 'изменение (CRM)', 'сделка', x.id, prev, x);
    bump(db);
  });
  return crmLoad(db, u);
});

/* ---------- клиенты ---------- */
def('crmSaveClient', 'crm_w', (db, u, c) => { saveClientTx(db, u, c); return crmLoad(db, u); });
def('crmDeleteClient', 'crm_w', (db, u, id) => { deleteClientTx(db, u, id); return crmLoad(db, u); });

/* ---------- задачи ---------- */
def('saveTask', 'crm_w', (db, u, t) => {
  if (!t || !String(t.title || '').trim()) throw new ApiError('Напишите, что нужно сделать.');
  tx(db, () => {
    const prevRow = t.id ? db.prepare('SELECT data FROM tasks WHERE id=?').get(str(t.id, 64)) : null;
    const prev = prevRow ? P(prevRow.data) : null;
    const x = {
      id: str(t.id || uid('task'), 64), title: str(t.title, 500).trim(), note: str(t.note, 3000),
      due: isDate(t.due) ? t.due : '', time: /^\d{2}:\d{2}$/.test(t.time || '') ? t.time : '',
      assigneeId: optUser(db, t.assigneeId) || u.id,
      clientId: optRef(db, 'counterparties', t.clientId), leadId: optRef(db, 'leads', t.leadId),
      dealId: optRef(db, 'deals', t.dealId), objectId: optRef(db, 'objects', t.objectId),
      done: !!t.done, doneAt: t.done ? ((prev && prev.doneAt) || now()) : null,
      createdBy: (prev && prev.createdBy) || u.id, createdAt: (prev && prev.createdAt) || now(), updatedAt: now()
    };
    db.prepare('INSERT INTO tasks(id,due,done,assignee,updated_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET due=excluded.due, done=excluded.done, assignee=excluded.assignee, updated_at=excluded.updated_at, data=excluded.data')
      .run(x.id, x.due || null, x.done ? 1 : 0, x.assigneeId, x.updatedAt, J(x));
    if (x.done && !(prev && prev.done) && (x.clientId || x.leadId || x.dealId || x.objectId))
      addActivity(db, u, { type: 'event', text: `Выполнена задача: ${x.title}`, clientId: x.clientId, leadId: x.leadId, dealId: x.dealId, objectId: x.objectId });
    audit(db, u, prev ? 'изменение' : 'создание', 'задача', x.id, prev, x);
    bump(db);
  });
  return crmLoad(db, u);
});

def('deleteTask', 'crm_w', (db, u, id) => {
  tx(db, () => {
    const row = db.prepare('SELECT data FROM tasks WHERE id=?').get(str(id, 64));
    if (!row) return;
    db.prepare('DELETE FROM tasks WHERE id=?').run(str(id, 64));
    audit(db, u, 'удаление', 'задача', id, P(row.data), null);
    bump(db);
  });
  return crmLoad(db, u);
});

/* ---------- восстановление из файла (вызывается из importData внутри транзакции) ---------- */
function restore(db, crm) {
  db.exec('DELETE FROM leads; DELETE FROM tasks; DELETE FROM objects; DELETE FROM activities; DELETE FROM inquiries;');
  (crm.inquiries || []).forEach(q => db.prepare('INSERT INTO inquiries(id,object_id,at,data) VALUES(?,?,?,?)').run(str(q.id, 64), str(q.objectId, 64), Number(q.at) || now(), J(q)));
  (crm.leads || []).forEach(l => db.prepare('INSERT INTO leads(id,stage,updated_at,data) VALUES(?,?,?,?)').run(str(l.id, 64), STAGES[l.stage] ? l.stage : 'new', Number(l.updatedAt) || now(), J(l)));
  (crm.tasks || []).forEach(t => db.prepare('INSERT INTO tasks(id,due,done,assignee,updated_at,data) VALUES(?,?,?,?,?,?)').run(str(t.id, 64), t.due || null, t.done ? 1 : 0, t.assigneeId || null, Number(t.updatedAt) || now(), J(t)));
  (crm.objects || []).forEach(o => db.prepare('INSERT INTO objects(id,updated_at,data) VALUES(?,?,?)').run(str(o.id, 64), Number(o.updatedAt) || now(), J(o)));
  (crm.activities || []).forEach(a => db.prepare('INSERT INTO activities(id,at,user_id,client_id,lead_id,deal_id,object_id,data) VALUES(?,?,?,?,?,?,?,?)')
    .run(str(a.id, 64), Number(a.at) || now(), a.userId || null, a.clientId || null, a.leadId || null, a.dealId || null, a.objectId || null, J(a)));
}

module.exports = { restore, crmLoad, STAGES };
