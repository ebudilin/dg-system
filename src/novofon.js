'use strict';
// Телефония Novofon: раз в 3 минуты забираем отчёт по звонкам (Data API, get.calls_report)
// и раскладываем звонки по клиентам. Неизвестные входящие — в список «Звонки» для разбора.
const { getMeta, setMeta } = require('./db');
const { def, ApiError, audit, bump, tx, str, J, P } = require('./api');

const API = process.env.NOVOFON_API || 'https://dataapi-jsonrpc.novofon.ru/v2.0';
const FIELDS = ['id', 'start_time', 'finish_time', 'direction', 'is_lost', 'contact_phone_number', 'virtual_phone_number', 'talk_duration', 'total_duration', 'finish_reason', 'full_record_file_link', 'employees', 'communication_id', 'last_answered_employee_id'];

const S = db => Object.assign({ enabled: false, apiKey: '', defaultUserId: null, lastSync: 0, lastOk: 0, lastError: '', lastCount: 0 }, P(getMeta(db, 'novofon') || 'null') || {});
const saveS = (db, s) => setMeta(db, 'novofon', J(s));
const digits = s => String(s || '').replace(/\D/g, '');
const key10 = s => { let d = digits(s); if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1); return d.length >= 10 ? d.slice(-10) : ''; };
const fmtPhone = s => { const d = key10(s); return d ? `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}` : String(s || ''); };
const mmss = sec => { sec = Math.round(+sec || 0); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };

// время в часовом поясе Москвы, как ждёт API: YYYY-MM-DD hh:mm:ss
function msk(ms) {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
  return p.replace('T', ' ');
}
const fromMsk = s => Date.parse(String(s).replace(' ', 'T') + '+03:00');

async function rpc(apiKey, method, params) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: Object.assign({ access_token: apiKey }, params) }), signal: AbortSignal.timeout(30000) });
  const d = await r.json().catch(() => null);
  if (!d) throw new Error('Novofon ответил не JSON (HTTP ' + r.status + ')');
  if (d.error) {
    const m = (d.error.data && d.error.data.mnemonic) || '';
    if (/ip/i.test(m) || /ip/i.test(d.error.message || '')) throw new Error('Novofon не пускает сервер: добавьте IP сервера в белый список (Настройки → Правила и настройки безопасности → API). ' + (d.error.message || ''));
    throw new Error((d.error.message || 'Ошибка Novofon') + (m ? ' (' + m + ')' : ''));
  }
  return d.result;
}

// клиенты по номеру телефона (поле «телефон» и «другие контакты»; в поле может быть несколько номеров)
function phoneIndex(db) {
  const idx = {};
  for (const r of db.prepare('SELECT data FROM counterparties').all()) {
    const c = P(r.data); if (!c) continue;
    const txt = (c.phone || '') + ' ' + (c.other || '');
    (txt.match(/[+\d][\d\s()\-]{8,}\d/g) || []).forEach(m => { const k = key10(m); if (k && !idx[k]) idx[k] = c; });
  }
  return idx;
}

const spamList = db => P(getMeta(db, 'spamPhones') || '{}') || {};
function whoFor(db, clientId, s, fallback) {
  // кому поставить «перезвонить»: ответственный по открытой заявке клиента → ответственный по его объекту → дежурный из настроек
  if (clientId) {
    const ld = db.prepare("SELECT data FROM leads WHERE stage IN ('new','work','show','talks') AND instr(data, ?)>0 ORDER BY updated_at DESC LIMIT 1").get('"clientId":"' + clientId + '"');
    if (ld && P(ld.data).ownerId) return P(ld.data).ownerId;
    for (const r of db.prepare('SELECT data FROM objects WHERE instr(data, ?)>0').all('"' + clientId + '"')) { const o = P(r.data); if ((o.owners || []).includes(clientId) && o.responsibleId) return o.responsibleId; }
  }
  return fallback || s.defaultUserId || (db.prepare("SELECT id FROM users WHERE role='owner' AND active=1 ORDER BY id LIMIT 1").get() || {}).id || null;
}

function addTask(db, title, assigneeId, clientId, callId) {
  const now = Date.now(), id = 'task_' + now.toString(36) + Math.random().toString(36).slice(2, 7);
  const t = { id, title, note: '', due: new Date(now + 3 * 3600e3).toISOString().slice(0, 10), time: '', assigneeId, clientId: clientId || '', leadId: '', dealId: '', objectId: '',
    done: false, doneAt: null, createdBy: null, createdAt: now, updatedAt: now, callId };
  db.prepare('INSERT INTO tasks(id,due,done,assignee,updated_at,data) VALUES(?,?,?,?,?,?)').run(id, t.due, 0, assigneeId, now, J(t));
}

// кто из сотрудников отвечает за звонок: поднявший трубку → единственный, кому звонило → ответственный по объекту виртуального номера
function agentFor(db, c, ctx) {
  const em = ctx.em || (ctx.em = require('./prefs').empMap(db));
  const ans = c.last_answered_employee_id != null ? c.last_answered_employee_id : ((c.employees || []).find(e => e.is_answered) || {}).employee_id;
  if (ans != null && em[String(ans)]) return em[String(ans)];
  const ids = [...new Set((c.employees || []).map(e => em[String(e.employee_id)]).filter(Boolean))];
  if (ids.length === 1) return ids[0];
  const vm = require('./inquiries').vnums(db)[digits(c.virtual_phone_number)];
  if (vm && vm.objectId) { const o = P((db.prepare('SELECT data FROM objects WHERE id=?').get(vm.objectId) || {}).data || 'null'); if (o && o.responsibleId) return o.responsibleId; }
  return null;
}
const uname = (db, id) => (id && (db.prepare('SELECT name FROM users WHERE id=?').get(Number(id)) || {}).name) || '';

function processCall(db, c, idx, s, ctx) {
  ctx = ctx || {};
  const id = String(c.id);
  if (db.prepare('SELECT 1 FROM calls WHERE id=?').get(id)) return false;
  if (!c.finish_time) return false; // звонок ещё идёт — заберём в следующий раз
  const crm = require('./crm');
  const at = fromMsk(c.start_time) || Date.now();
  const dir = c.direction === 'out' ? 'out' : 'in', lost = !!c.is_lost;
  const phone = String(c.contact_phone_number || ''), k = key10(phone);
  const client = k ? idx[k] : null;
  const emp = (c.employees || []).map(e => e.employee_full_name).filter(Boolean)[0] || '';
  const rec = c.full_record_file_link || '';
  const agent = agentFor(db, c, ctx);
  const ansId = c.last_answered_employee_id != null ? c.last_answered_employee_id : ((c.employees || []).find(e => e.is_answered) || {}).employee_id;
  const data = { id, at, dir, lost, phone, userId: agent || null, ans: ansId != null ? String(ansId) : null, emps: [...new Set((c.employees || []).map(e => String(e.employee_id)))], vnumber: String(c.virtual_phone_number || ''), talk: +c.talk_duration || 0, total: +c.total_duration || 0, emp, rec, reason: c.finish_reason || '', comm: c.communication_id || null };
  let status = 'ignored';
  if (k && spamList(db)[k]) {
    db.prepare('INSERT INTO calls(id,at,direction,is_lost,phone,vnumber,client_id,status,data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, at, dir, lost ? 1 : 0, phone, data.vnumber, null, 'spam', J(data));
    return true;
  }
  if (client) {
    status = 'linked';
    const text = `${dir === 'in' ? 'Входящий' : 'Исходящий'} звонок${lost ? ' — пропущенный' : ', ' + mmss(data.talk)}${emp ? ' · ' + emp : ''} · ${fmtPhone(phone)}`;
    crm.addActivity(db, null, { type: 'call', text, at, clientId: client.id, userId: agent || null, userName: agent ? 'Телефония · ' + uname(db, agent) : 'Телефония', url: rec, callId: id });
    if (dir === 'in' && lost) addTask(db, `Перезвонить: ${client.name}, ${fmtPhone(phone)} (пропущенный)`, whoFor(db, client.id, s, agent), client.id, id);
  } else if (dir === 'in' && k) {
    status = 'new';
    if (lost) addTask(db, `Перезвонить: ${fmtPhone(phone)} — новый номер, пропущенный`, whoFor(db, null, s, agent), '', id);
  }
  db.prepare('INSERT INTO calls(id,at,direction,is_lost,phone,vnumber,client_id,status,data) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, at, dir, lost ? 1 : 0, phone, data.vnumber, client ? client.id : null, status, J(data));
  return true;
}

let running = false;
async function sync(db, force) {
  const s = S(db);
  if (!s.apiKey || (!s.enabled && !force) || running) return { skipped: true };
  running = true;
  try {
    const till = Date.now(), from = Math.max(s.lastOk ? s.lastOk - 30 * 60e3 : till - 2 * 86400e3, till - 7 * 86400e3);
    const res = await rpc(s.apiKey, 'get.calls_report', { date_from: msk(from), date_till: msk(till), fields: FIELDS, limit: 5000, offset: 0 });
    const list = (res && res.data) || [];
    let n = 0;
    tx(db, () => {
      const idx = phoneIndex(db), ctx = {};
      list.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time))).forEach(c => { if (processCall(db, c, idx, s, ctx)) n++; });
      if (n) bump(db);
    });
    Object.assign(s, { lastSync: till, lastOk: till, lastError: '', lastCount: n });
    saveS(db, s);
    return { ok: true, received: list.length, added: n };
  } catch (e) {
    Object.assign(s, { lastSync: Date.now(), lastError: String(e.message || e) });
    saveS(db, s);
    return { ok: false, error: s.lastError };
  } finally { running = false; }
}

function start(db) { setInterval(() => { sync(db).catch(() => {}); }, 3 * 60e3).unref(); setTimeout(() => sync(db).catch(() => {}), 15e3).unref(); }

/* ---------- API ---------- */
const pub = s => ({ enabled: s.enabled, hasKey: !!s.apiKey, defaultUserId: s.defaultUserId, lastSync: s.lastSync, lastOk: s.lastOk, lastError: s.lastError, lastCount: s.lastCount });
def('novofonSettings', 'owner', (db) => pub(S(db)));
def('saveNovofonSettings', 'owner', (db, u, x) => {
  const s = S(db);
  if (x.apiKey != null && String(x.apiKey).trim()) s.apiKey = str(x.apiKey, 200).trim();
  if (x.clearKey) s.apiKey = '';
  s.enabled = !!x.enabled && !!s.apiKey;
  s.defaultUserId = x.defaultUserId ? Number(x.defaultUserId) : null;
  saveS(db, s);
  audit(db, u, 'настройки Novofon', 'интеграции', null, null, { enabled: s.enabled, defaultUserId: s.defaultUserId });
  return pub(s);
});
// проверка и немедленная загрузка (вызывается из интерфейса; ждёт ответ Novofon)
def('novofonSyncNow', 'owner', (db) => sync(db, true).then(r => Object.assign({ settings: pub(S(db)) }, r)));

def('listCalls', null, (db, u, days) => {
  const since = Date.now() - Math.min(60, Math.max(1, +days || 7)) * 86400e3;
  return db.prepare("SELECT data, status, client_id FROM calls WHERE at>? OR status='new' ORDER BY at DESC LIMIT 1000").all(since)
    .map(r => Object.assign(P(r.data) || {}, { status: r.status, clientId: r.client_id || '' }));
});

// разбор нового номера: привязать к клиенту / создать заявку / не клиент
def('resolveCall', 'crm_w', (db, u, id, action, x) => {
  x = x || {};
  const crm = require('./crm');
  const row = db.prepare('SELECT * FROM calls WHERE id=?').get(str(id, 64));
  if (!row) throw new ApiError('Звонок не найден.');
  let clientId = str(x.clientId, 64), leadId = '';
  if (action === 'spam' || action === 'unspam') {
    tx(db, () => {
      const k = key10(row.phone), sp = spamList(db);
      if (action === 'spam') {
        if (k) sp[k] = { at: Date.now(), by: u.name };
        const ids = db.prepare("SELECT id FROM calls WHERE phone=? AND status IN ('new','ignored')").all(row.phone).map(r => r.id);
        ids.forEach(cid => db.prepare("UPDATE calls SET status='spam' WHERE id=?").run(cid));
        // задачи «Перезвонить» по этим звонкам больше не нужны
        for (const t of db.prepare('SELECT id, data FROM tasks WHERE done=0').all()) {
          const d = P(t.data); if (d && d.callId && ids.includes(d.callId)) { d.done = true; d.doneAt = Date.now(); d.updatedAt = Date.now(); d.note = [d.note, 'Закрыта: номер отмечен как спам'].filter(Boolean).join('\n');
            db.prepare('UPDATE tasks SET done=1, updated_at=?, data=? WHERE id=?').run(Date.now(), J(d), t.id); }
        }
      } else {
        delete sp[k];
        db.prepare("UPDATE calls SET status='new' WHERE phone=? AND status='spam'").run(row.phone);
      }
      setMeta(db, 'spamPhones', J(sp));
      audit(db, u, action === 'spam' ? 'номер в спам' : 'номер из спама', 'звонок', id, null, { phone: row.phone });
      bump(db);
    });
    return require('./crm').crmLoad(db, u);
  }
  if (action === 'inquiry') {
    tx(db, () => {
      require('./inquiries').saveTx(db, u, Object.assign({}, x, { id: '', phone: fmtPhone(row.phone), callId: row.id, at: row.at }));
      // звонки с этого номера уже в истории клиента; помечаем и те, что были «не клиент»
      db.prepare("UPDATE calls SET status='linked' WHERE phone=? AND status='ignored'").run(row.phone);
      audit(db, u, 'разбор звонка: обращение по объекту', 'звонок', id, null, { objectId: x.objectId });
    });
    return require('./crm').crmLoad(db, u);
  }
  if (action === 'lead') {
    const l = crm.saveLeadTx(db, u, { newClientName: str(x.name, 200).trim() || fmtPhone(row.phone), newClientPhone: fmtPhone(row.phone), kind: x.kind || 'buy',
      source: x.source || 'Звонок', note: str(x.note, 2000), ownerId: x.ownerId ? Number(x.ownerId) : u.id, stage: 'new' });
    clientId = l.clientId; leadId = l.id;
  }
  tx(db, () => {
    const sameNumber = db.prepare("SELECT id, data FROM calls WHERE status='new' AND phone=?").all(row.phone);
    if (action === 'ignore') {
      sameNumber.forEach(r => db.prepare("UPDATE calls SET status='ignored' WHERE id=?").run(r.id));
    } else if (action === 'link' || action === 'lead') {
      if (action === 'link') {
        const cp = db.prepare('SELECT data FROM counterparties WHERE id=?').get(clientId);
        if (!cp) throw new ApiError('Выберите клиента.');
        const cc = P(cp.data), k = key10(row.phone);
        if (!digits((cc.phone || '') + ' ' + (cc.other || '')).includes(k)) {
          if (!cc.phone) cc.phone = fmtPhone(row.phone); else cc.other = [cc.other, fmtPhone(row.phone)].filter(Boolean).join(', ');
          db.prepare('UPDATE counterparties SET data=? WHERE id=?').run(J(cc), cc.id);
        }
      }
      sameNumber.forEach(r => {
        const d = P(r.data);
        db.prepare('UPDATE calls SET status=?, client_id=? WHERE id=?').run(action === 'lead' ? 'lead' : 'linked', clientId || null, r.id);
        crm.addActivity(db, null, { type: 'call', text: `${d.dir === 'in' ? 'Входящий' : 'Исходящий'} звонок${d.lost ? ' — пропущенный' : ', ' + mmss(d.talk)}${d.emp ? ' · ' + d.emp : ''} · ${fmtPhone(d.phone)}`,
          at: d.at, clientId, leadId, userName: 'Телефония', url: d.rec, callId: d.id });
      });
    } else throw new ApiError('Неизвестное действие.');
    audit(db, u, 'разбор звонка: ' + action, 'звонок', id, null, { clientId, leadId });
    bump(db);
  });
  return require('./crm').crmLoad(db, u);
});

// сотрудники в кабинете Novofon (для привязки к пользователям CRM)
def('novofonEmployees', 'owner', async (db) => {
  const s = S(db);
  if (!s.apiKey) throw new ApiError('Сначала подключите Novofon (ключ API).');
  const r = await rpc(s.apiKey, 'get.employees', {});
  return ((r && r.data) || []).map(e => ({ id: String(e.id), name: e.full_name || [e.last_name, e.first_name].filter(Boolean).join(' '),
    ext: (e.extension && e.extension.extension_phone_number) || '', phones: (e.phone_numbers || []).map(p => fmtPhone(p.phone_number)).filter(Boolean) }));
});

function newCount(db) { return (db.prepare("SELECT COUNT(DISTINCT phone) n FROM calls WHERE status='new'").get() || {}).n || 0; }

module.exports = { start, sync, newCount, fmtPhone, key10 };
