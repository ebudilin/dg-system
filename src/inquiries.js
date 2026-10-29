'use strict';
// Обращения по объектам: кто звонил (прямой интересант или агент), что дальше (показ, итог),
// и база интересантов — им можно предлагать наши услуги подбора.
const { getMeta, setMeta } = require('./db');
const { def, ApiError, audit, bump, tx, str, J, P } = require('./api');
const { D } = require('./objects');

const ST = D.inqStages, WHO = D.inqWho, SVC = D.inqSvc;
const now = () => Date.now();
const uid = p => p + '_' + now().toString(36) + Math.random().toString(36).slice(2, 8);
const digits = s => String(s || '').replace(/\D/g, '');
const key10 = s => { let d = digits(s); if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1); return d.length >= 10 ? d.slice(-10) : ''; };
const fmtPhone = s => { const k = key10(s); return k ? `+7 ${k.slice(0, 3)} ${k.slice(3, 6)}-${k.slice(6, 8)}-${k.slice(8)}` : String(s || ''); };
const objName = o => o.title || o.address || 'объект';
const mmss = s => { s = Math.round(+s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const getObj = (db, id) => { const r = db.prepare('SELECT data FROM objects WHERE id=?').get(str(id, 64)); return r ? P(r.data) : null; };
const getTask = (db, id) => { const r = id && db.prepare('SELECT data FROM tasks WHERE id=?').get(id); return r ? P(r.data) : null; };
const pad = n => String(n).padStart(2, '0');
// дата и время по Москве (сервер может жить в UTC)
const mskParts = ms => { const d = new Date(ms + 3 * 3600e3); return { date: d.toISOString().slice(0, 10), time: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) }; };

function crm() { return require('./crm'); }

function putTask(db, t) {
  db.prepare('INSERT INTO tasks(id,due,done,assignee,updated_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET due=excluded.due, done=excluded.done, assignee=excluded.assignee, updated_at=excluded.updated_at, data=excluded.data')
    .run(t.id, t.due || null, t.done ? 1 : 0, t.assigneeId || null, t.updatedAt, J(t));
}
function newTask(db, u, f) {
  const t = Object.assign({ id: uid('task'), title: '', note: '', due: '', time: '', assigneeId: u.id, clientId: '', leadId: '', dealId: '', objectId: '',
    done: false, doneAt: null, createdBy: u.id, createdAt: now(), updatedAt: now() }, f);
  putTask(db, t);
  return t;
}
function closeTask(db, id) {
  const t = getTask(db, id);
  if (t && !t.done) { t.done = true; t.doneAt = now(); t.updatedAt = now(); putTask(db, t); }
}

// клиент по телефону; если нет — создаём (интересант становится частью базы)
function findClient(db, phone) {
  const k = key10(phone);
  if (!k) return null;
  for (const r of db.prepare('SELECT data FROM counterparties').all()) {
    const c = P(r.data); if (!c) continue;
    if (((c.phone || '') + ' ' + (c.other || '')).match(/[+\d][\d\s()\-]{8,}\d/g)?.some(m => key10(m) === k)) return c;
  }
  return null;
}
function ensureClient(db, u, q, o) {
  if (q.clientId && db.prepare('SELECT 1 FROM counterparties WHERE id=?').get(q.clientId)) return q.clientId;
  const found = findClient(db, q.phone);
  if (found) return found.id;
  if (!q.name && !key10(q.phone)) return '';
  const type = q.who === 'agent' ? 'outagent' : (o.offer === 'rent' ? 'tenant' : 'buyer');
  const cp = { id: uid('cl'), name: q.name || fmtPhone(q.phone), types: [type], birth: '', phone: key10(q.phone) ? fmtPhone(q.phone) : '', email: '', other: '',
    note: q.who === 'agent' && q.agency ? 'Агентство: ' + q.agency : 'Звонил по объекту «' + objName(o) + '»', agentShare: '', createdAt: now() };
  db.prepare('INSERT INTO counterparties(id,data) VALUES(?,?)').run(cp.id, J(cp));
  audit(db, u, 'создание из обращения', 'контрагент', cp.id, null, cp);
  return cp.id;
}

// неразобранные звонки с этого номера → в историю клиента и объекта
function linkCalls(db, phone, clientId, objectId) {
  const k = key10(phone);
  if (!k || !clientId) return;
  for (const r of db.prepare("SELECT id, data FROM calls WHERE status='new' AND phone LIKE ?").all('%' + k)) {
    const d = P(r.data);
    db.prepare("UPDATE calls SET status='linked', client_id=? WHERE id=?").run(clientId, r.id);
    crm().addActivity(db, null, { type: 'call', text: `${d.dir === 'in' ? 'Входящий' : 'Исходящий'} звонок${d.lost ? ' — пропущенный' : ', ' + mmss(d.talk)}${d.emp ? ' · ' + d.emp : ''} · ${fmtPhone(d.phone)}`,
      at: d.at, clientId, objectId, userName: 'Телефония', url: d.rec, callId: d.id });
  }
}

function clean(db, q, prev) {
  const o = getObj(db, q.objectId || (prev && prev.objectId));
  if (!o) throw new ApiError('Выберите объект.');
  const pick = (v, dict, d) => Object.prototype.hasOwnProperty.call(dict, v) ? v : d;
  const x = {
    id: (prev && prev.id) || str(q.id, 64) || uid('inq'), objectId: o.id,
    at: (prev && prev.at) || Math.min(Number(q.at) || now(), now()),
    name: str(q.name, 200).trim(), phone: str(q.phone, 100).trim(), channel: str(q.channel, 100).trim(),
    who: pick(q.who, WHO, 'buyer'), agency: str(q.agency, 200).trim(), note: str(q.note, 2000),
    stage: pick(q.stage, ST, 'new'), showAt: Number(q.showAt) || null, result: str(q.result, 3000),
    reason: str(q.reason, 200), svc: pick(q.svc, SVC, ''), clientId: str(q.clientId != null ? q.clientId : (prev && prev.clientId), 64),
    leadId: (prev && prev.leadId) || '', showTaskId: (prev && prev.showTaskId) || '', fbTaskId: (prev && prev.fbTaskId) || '',
    callIds: [...new Set([...((prev && prev.callIds) || []), ...(q.callId ? [str(q.callId, 64)] : [])])],
    userId: (prev && prev.userId) || null, userName: (prev && prev.userName) || '', updatedAt: now()
  };
  if (x.who === 'agent') { if (x.svc === 'lead') x.svc = ''; } else x.agency = '';
  if (x.leadId) x.svc = 'lead';
  if (x.stage === 'show_set' && !x.showAt) throw new ApiError('Укажите дату и время показа.');
  if (x.stage === 'declined' && !x.reason) throw new ApiError('Укажите, почему объект не подошёл.');
  if (!x.name && !key10(x.phone)) throw new ApiError('Укажите имя или телефон.');
  return { x, o };
}

// сохранение обращения внутри транзакции
function saveTx(db, u, q) {
  const prevRow = q.id ? db.prepare('SELECT data FROM inquiries WHERE id=?').get(str(q.id, 64)) : null;
  const prev = prevRow ? P(prevRow.data) : null;
  const { x, o } = clean(db, q, prev);
  if (!prev) { x.userId = u.id; x.userName = u.name; }
  x.clientId = ensureClient(db, u, x, o);
  const resp = o.responsibleId || u.id;
  const who = x.name || fmtPhone(x.phone);
  // показ → задача ответственному; любой другой этап закрывает задачу на показ
  if (x.stage === 'show_set') {
    const { date, time } = mskParts(x.showAt);
    const t = getTask(db, x.showTaskId);
    const title = `Показ: ${objName(o)} — ${who}${x.who === 'agent' ? ' (агент)' : ''}`;
    if (t && !t.done) { Object.assign(t, { title, due: date, time, updatedAt: now() }); putTask(db, t); }
    else x.showTaskId = newTask(db, u, { title, due: date, time, assigneeId: resp, clientId: x.clientId, objectId: o.id, note: x.note }).id;
  } else if (x.showTaskId) closeTask(db, x.showTaskId);
  if (x.stage === 'shown' && (!prev || prev.stage !== 'shown') && !getTask(db, x.fbTaskId)) {
    const tomorrow = mskParts(now() + 86400e3).date;
    x.fbTaskId = newTask(db, u, { title: `Узнать решение после показа: ${who} (${objName(o)})`, due: tomorrow, assigneeId: resp, clientId: x.clientId, objectId: o.id }).id;
  }
  if (D.inqClosed.includes(x.stage) && x.fbTaskId) closeTask(db, x.fbTaskId);
  db.prepare('INSERT INTO inquiries(id,object_id,at,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET object_id=excluded.object_id, at=excluded.at, data=excluded.data').run(x.id, x.objectId, x.at, J(x));
  // история клиента и объекта
  const head = `Обращение по объекту «${objName(o)}»`;
  if (!prev) crm().addActivity(db, u, { type: 'event', text: `${head}: ${WHO[x.who].toLowerCase()}${x.agency ? ', ' + x.agency : ''}${x.channel ? ', источник: ' + x.channel : ''}${x.stage !== 'new' ? '. Этап: ' + ST[x.stage] : ''}`, clientId: x.clientId, objectId: o.id });
  else if (prev.stage !== x.stage) {
    let t = `${head}: ${ST[prev.stage] || prev.stage} → ${ST[x.stage]}`;
    if (x.stage === 'show_set') t += ', ' + mskParts(x.showAt).date.split('-').reverse().join('.') + ' ' + mskParts(x.showAt).time;
    if (x.stage === 'declined') t += '. Причина: ' + x.reason;
    if (x.result && x.result !== prev.result) t += '. ' + x.result;
    crm().addActivity(db, u, { type: x.stage === 'shown' ? 'show' : 'event', text: t, clientId: x.clientId, objectId: o.id });
  }
  linkCalls(db, x.phone, x.clientId, o.id);
  audit(db, u, prev ? 'изменение' : 'создание', 'обращение', x.id, prev, x);
  bump(db);
  return x;
}

function callsFor(db, phone) {
  const k = key10(phone);
  if (!k) return [];
  return db.prepare('SELECT data FROM calls WHERE phone LIKE ? ORDER BY at DESC LIMIT 50').all('%' + k).map(r => P(r.data)).filter(Boolean)
    .map(c => ({ id: c.id, at: c.at, dir: c.dir, lost: c.lost, talk: c.talk, emp: c.emp, rec: c.rec, vnumber: c.vnumber }));
}

/* ---------- API ---------- */
def('listInquiries', null, (db, u, objectId) =>
  db.prepare('SELECT data FROM inquiries WHERE object_id=? ORDER BY at DESC').all(str(objectId, 64)).map(r => P(r.data)).filter(Boolean)
    .map(q => Object.assign(q, { calls: callsFor(db, q.phone) })));

def('listAllInquiries', null, (db) =>
  db.prepare('SELECT data FROM inquiries ORDER BY at DESC LIMIT 5000').all().map(r => P(r.data)).filter(Boolean));

def('getInquiry', null, (db, u, id) => {
  const r = db.prepare('SELECT data FROM inquiries WHERE id=?').get(str(id, 64));
  if (!r) throw new ApiError('Обращение не найдено.');
  const q = P(r.data);
  return Object.assign(q, { calls: callsFor(db, q.phone) });
});

def('saveInquiry', 'crm_w', (db, u, q) => {
  if (!q) throw new ApiError('Нет данных.');
  let x; tx(db, () => { x = saveTx(db, u, q); });
  return Object.assign(crm().crmLoad(db, u), { saved: x });
});

def('deleteInquiry', 'crm_w', (db, u, id) => {
  tx(db, () => {
    const row = db.prepare('SELECT data FROM inquiries WHERE id=?').get(str(id, 64));
    if (!row) return;
    const q = P(row.data);
    if (q.showTaskId) closeTask(db, q.showTaskId);
    db.prepare('DELETE FROM inquiries WHERE id=?').run(q.id);
    audit(db, u, 'удаление', 'обращение', q.id, q, null);
    bump(db);
  });
  return crm().crmLoad(db, u);
});

// прямой интересант → заявка на подбор (наши услуги)
def('inquiryToLead', 'crm_w', (db, u, id, kind) => {
  let leadId;
  tx(db, () => {
    const row = db.prepare('SELECT data FROM inquiries WHERE id=?').get(str(id, 64));
    if (!row) throw new ApiError('Обращение не найдено.');
    const q = P(row.data);
    if (q.who === 'agent') throw new ApiError('Это агент — заявку на подбор создают для прямых интересантов.');
    if (q.leadId && db.prepare('SELECT 1 FROM leads WHERE id=?').get(q.leadId)) throw new ApiError('Заявка уже создана.');
    const o = getObj(db, q.objectId) || {};
    if (!q.clientId) q.clientId = ensureClient(db, u, q, o);
    const all = db.prepare('SELECT data FROM inquiries').all().map(r => P(r.data)).filter(z => z && z.clientId === q.clientId);
    const objs = [...new Set(all.map(z => (getObj(db, z.objectId) || {})).map(objName))];
    const c = P(db.prepare('SELECT data FROM counterparties WHERE id=?').get(q.clientId).data);
    const k = ['buy', 'rent', 'commercial'].includes(kind) ? kind : (o.offer === 'rent' ? 'rent' : (['office', 'gab', 'retail', 'warehouse'].includes(o.kind) ? 'commercial' : 'buy'));
    const lead = { id: uid('lead'), title: `Подбор — ${c.name}`, clientId: c.id, kind: k, source: 'Обращение по объекту' + (q.channel ? ' (' + q.channel + ')' : ''),
      budget: o.price || '', stage: 'new', ownerId: o.responsibleId || u.id, objectId: '', dealId: '',
      note: `Звонил по объектам: ${objs.join('; ')}.${q.result ? ' ' + q.result : ''}${q.note ? ' ' + q.note : ''}`.trim(), lostReason: '',
      createdAt: now(), createdBy: u.id, stageAt: now(), updatedAt: now() };
    db.prepare('INSERT INTO leads(id,stage,updated_at,data) VALUES(?,?,?,?)').run(lead.id, lead.stage, lead.updatedAt, J(lead));
    all.forEach(z => { z.leadId = lead.id; z.svc = 'lead'; db.prepare('UPDATE inquiries SET data=? WHERE id=?').run(J(z), z.id); });
    crm().addActivity(db, u, { type: 'event', text: `Создана заявка на подбор из обращения по объекту «${objName(o)}»`, clientId: c.id, leadId: lead.id, objectId: o.id || '' });
    audit(db, u, 'создание из обращения', 'заявка', lead.id, null, lead);
    bump(db);
    leadId = lead.id;
  });
  return Object.assign(crm().crmLoad(db, u), { leadId });
});

// отметка по услугам для всех обращений человека
def('setInquirySvc', 'crm_w', (db, u, ids, svc) => {
  if (!['', 'offered', 'refused'].includes(svc)) throw new ApiError('Неизвестное значение.');
  tx(db, () => {
    (Array.isArray(ids) ? ids : []).slice(0, 200).forEach(id => {
      const r = db.prepare('SELECT data FROM inquiries WHERE id=?').get(str(id, 64)); if (!r) return;
      const q = P(r.data); if (q.leadId) return;
      q.svc = svc; db.prepare('UPDATE inquiries SET data=? WHERE id=?').run(J(q), q.id);
      if (svc) crm().addActivity(db, u, { type: 'event', text: svc === 'refused' ? 'Отказался от услуг подбора' : 'Предложили услуги подбора', clientId: q.clientId, objectId: q.objectId });
    });
    bump(db);
  });
  return crm().crmLoad(db, u);
});

/* ---------- виртуальные номера: какая площадка / какой объект ---------- */
function vnums(db) { return P(getMeta(db, 'vnums') || 'null') || {}; }
def('vnumList', 'owner', (db) => {
  const map = vnums(db);
  const seen = db.prepare("SELECT vnumber v, COUNT(*) n, MAX(at) last FROM calls WHERE vnumber<>'' GROUP BY vnumber ORDER BY n DESC").all();
  Object.keys(map).forEach(k => { if (!seen.some(s => digits(s.v) === k)) seen.push({ v: k, n: 0, last: null }); });
  return seen.map(s => Object.assign({ v: digits(s.v), n: s.n, last: s.last }, map[digits(s.v)] || { channel: '', objectId: '' }));
});
def('saveVnums', 'owner', (db, u, list) => {
  const map = {};
  (Array.isArray(list) ? list : []).forEach(x => { const k = digits(x.v); if (!k) return; const ch = str(x.channel, 100).trim(), ob = str(x.objectId, 64); if (ch || ob) map[k] = { channel: ch, objectId: ob }; });
  setMeta(db, 'vnums', J(map));
  audit(db, u, 'виртуальные номера', 'интеграции', null, null, map);
  bump(db);
  return crm().crmLoad(db, u);
});

function inquiryCounts(db) {
  const out = {};
  for (const r of db.prepare('SELECT object_id, data FROM inquiries').all()) {
    const q = P(r.data); if (!q) continue;
    const c = out[r.object_id] || (out[r.object_id] = { n: 0, last: 0, direct: 0, agents: 0, shows: 0, open: 0 });
    c.n++; c.last = Math.max(c.last, q.at || 0);
    if (q.who === 'agent') c.agents++; else c.direct++;
    if (['shown', 'thinking', 'talks', 'deposit', 'deal'].includes(q.stage) || (q.stage === 'declined' && q.showTaskId)) c.shows++;
    if (q.stage === 'show_set') c.open++;
  }
  return out;
}

module.exports = { saveTx, inquiryCounts, vnums, key10, fmtPhone };
