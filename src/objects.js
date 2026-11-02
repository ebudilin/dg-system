'use strict';
// Карточка объекта: параметры, собственники, документы, продвижение, расходы, обращения.
const { def, ApiError, audit, bump, tx, str, isDate, numOrBlank, J, P } = require('./api');

const D = {
  kinds: { flat: 'Квартира', house: 'Дом / участок', office: 'Офис', gab: 'ГАБ', retail: 'Торговое помещение', warehouse: 'Склад / производство', lot: 'Лот застройщика', other: 'Другое' },
  status: { draft: 'Черновик', active: 'Активный', paused: 'Остановлен', deposit: 'Задаток / бронь', failed: 'Срыв', sold: 'Реализован' },
  sources: ['Сарафан', 'Яндекс Карты', 'Заявка на сайте', 'Реклама', 'Повторный клиент', 'Партнёр / агент'],
  ownershipBasis: ['Договор купли-продажи', 'ДДУ', 'Договор уступки', 'Наследство', 'Дарение', 'Приватизация', 'Мена', 'Решение суда', 'Выплаченный пай', 'Другое'],
  roomsType: { isolated: 'Изолированные', adjacent: 'Смежные', mixed: 'Смежно-изолированные' },
  renovation: { rough: 'Черновая отделка', prefinish: 'Под чистовую отделку', finished: 'С отделкой', needs: 'Требуется ремонт', after: 'После ремонта', designer: 'Дизайнерский ремонт', euro: 'Евроремонт', standard: 'Типовой ремонт', capital: 'Требуется капитальный ремонт' },
  windows: { yard: 'Двор', street: 'Улица', embankment: 'Набережная', square: 'Сквер' },
  yard: { playground: 'Детская площадка', sports: 'Спортивная площадка', closed: 'Закрытая территория' },
  walls: ['Кирпич', 'Монолит', 'Монолит-кирпич', 'Панель', 'Блоки', 'Дерево', 'Другое'],
  slabs: ['Железобетонные', 'Деревянные', 'Смешанные'],
  parking: { ground: 'Наземная', multilevel: 'Многоуровневая', underground: 'Подземная', guarded: 'Охраняемая' },
  tenant: { no: 'Нет', yes: 'Есть' },
  expenseKinds: ['Фотосъёмка', 'Видеосъёмка', 'Справки и документы', 'Реклама ЦИАН', 'Реклама Авито', 'Реклама Яндекс', 'Другая реклама', 'Другое'],
  tips: [
    ['presentation', 'Подготовить презентацию'], ['photo', 'Профессиональные фотографии'], ['plan', 'Отрисовать планировку'],
    ['video_h', 'Снять горизонтальное видео-обзор'], ['video_v', 'Снять вертикальное видео'], ['promo', 'Снять рекламный ролик'],
    ['egrn', 'Заказать выписку из ЕГРН'], ['docs', 'Проверить документы юристом'], ['price', 'Анализ цены: сравнить с конкурентами'],
    ['ads', 'Разместить объявления: ЦИАН, Авито, Яндекс'],
    ['owner_call', 'Связаться с собственником: рассказать, что происходит по объекту'],
    ['owner_report', 'Подготовить отчёт собственнику: показы, звонки, обратная связь, рекомендации по цене']
  ],
  // регулярные советы: не «выполняются» навсегда, а напоминают раз в N дней
  recurring: { owner_call: 7, owner_report: 14 },
  inqChannels: ['ЦИАН', 'Авито', 'Яндекс Недвижимость', 'Домклик', 'Сайт', 'Звонок на номер агентства', 'Рекомендация', 'Соцсети', 'Другое'],
  inqWho: { buyer: 'Прямой интересант', agent: 'Агент' },
  inqStages: { new: 'Новое', show_set: 'Показ назначен', shown: 'Показ проведён', thinking: 'Думает', talks: 'Торг / переговоры', deposit: 'Задаток / бронь', deal: 'Купил / снял', declined: 'Не подошёл', noreply: 'Не выходит на связь' },
  inqClosed: ['deal', 'declined', 'noreply'],
  inqDecline: ['Цена', 'Планировка', 'Состояние / ремонт', 'Расположение', 'Этаж / вид', 'Документы', 'Выбрал другой объект', 'Передумал / отложил', 'Другое'],
  inqSvc: { '': 'Не предлагали', offered: 'Предложили, думает', lead: 'Заявка на подбор', refused: 'Отказался' }
};

const now = () => Date.now();
const uid = p => p + '_' + now().toString(36) + Math.random().toString(36).slice(2, 8);
const pick = (v, dict, def) => Object.prototype.hasOwnProperty.call(dict, v) ? v : def;
const multi = (v, dict) => (Array.isArray(v) ? v : []).filter(k => Object.prototype.hasOwnProperty.call(dict, k));
const optRef = (db, table, id) => { id = str(id, 64); return id && db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id) ? id : ''; };
const optUser = (db, id) => (id && db.prepare('SELECT 1 FROM users WHERE id=?').get(Number(id))) ? Number(id) : null;
const STATUS_ORDER = ['draft', 'active', 'paused', 'deposit', 'failed', 'sold'];

function cleanHistory(h, createdAt) {
  h = Array.isArray(h) ? h : [];
  // старый формат {at, from, to}: первая «from» — стартовая цена
  if (h.length && h[0] && h[0].price == null && h[0].from != null) {
    const conv = [];
    if (+h[0].from > 0) conv.push({ at: createdAt || h[0].at, price: +h[0].from, note: 'стартовая цена' });
    h.forEach(e => e && e.to != null && conv.push({ at: e.at, price: +e.to, note: '' }));
    h = conv;
  }
  return h.map(e => {
    if (!e) return null;
    const price = e.price != null ? Number(e.price) : Number(e.to);  // старый формат {from,to}
    const at = Number(e.at) || (isDate(e.date) ? new Date(e.date + 'T12:00:00').getTime() : 0);
    return price > 0 && at ? { at, price, note: str(e.note, 200) } : null;
  }).filter(Boolean).sort((a, b) => a.at - b.at).slice(-100);
}


// Доступ к объекту: кто даёт, где ключи, движение ключей, двойная проверка.
const ACCESS_WHO = { keys: 'Ключи у нас', tenant: 'Арендатор', owner: 'Собственник приезжает сам', proxy: 'Доверенное лицо собственника' };
const KEY_HOLDER_MAX = 120;
function cleanAccess(db, a, prev) {
  if (!a || typeof a !== 'object') return (prev && prev.access) || { who: '', keysAt: '', keysMoves: [], keysCheck: null, proxyName: '', proxyPhone: '', note: '' };
  const who = Object.prototype.hasOwnProperty.call(ACCESS_WHO, a.who) ? a.who : '';
  const old = (prev && prev.access) || { keysMoves: [], keysCheck: null };
  // журнал движения ключей: только добавляем, историю не переписываем
  const moves = (Array.isArray(old.keysMoves) ? old.keysMoves : []).slice(-200);
  if (Array.isArray(a.keysMoves)) {
    const knownIds = new Set(moves.map(m => m.id));
    for (const m of a.keysMoves.slice(0, 50)) {
      if (!m || knownIds.has(m.id)) continue;   // уже записанные переходы не меняем
      const to = str(m.to, KEY_HOLDER_MAX).trim();
      if (!to) continue;
      moves.push({ id: str(m.id || uid('kmv'), 40), at: now(), from: str(m.from, KEY_HOLDER_MAX).trim(), to, note: str(m.note, 200).trim(), by: str(m.by, 100) });
    }
  }
  const check = a.keysCheck && a.keysCheck.confirmed === true
    ? { confirmed: true, at: now(), by: str(a.keysCheck.by, 100), note: str(a.keysCheck.note, 300) }
    : (a.keysCheck === null ? null : old.keysCheck);
  return {
    who,
    keysAt: str(a.keysAt, KEY_HOLDER_MAX).trim(),          // где ключи сейчас (например, «ящик — Анна»)
    keysMoves: moves,
    keysCheck: check,
    proxyName: str(a.proxyName, 200).trim(),
    proxyPhone: str(a.proxyPhone, 40).trim(),
    accessNote: str(a.accessNote, 1000)
  };
}
function cleanObject(db, o, prev) {
  const p = prev || {};
  const x = {
    id: str(o.id || p.id || uid('obj'), 64),
    title: str(o.title, 300).trim(), address: str(o.address, 500).trim(), metro: str(o.metro, 100),
    kind: pick(o.kind, D.kinds, 'flat'), offer: o.offer === 'rent' ? 'rent' : 'sale',
    status: pick(o.status, D.status, 'draft'),
    responsibleId: optUser(db, o.responsibleId),
    source: str(o.source, 100).trim(),
    // документы
    cadastral: str(o.cadastral, 60).trim(), ownershipDate: isDate(o.ownershipDate) ? o.ownershipDate : '', ownershipBasis: str(o.ownershipBasis, 200).trim(),
    owners: (Array.isArray(o.owners) ? o.owners : []).map(id => optRef(db, 'counterparties', id)).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 10),
    encumbrances: str(o.encumbrances, 2000), tenant: pick(o.tenant, D.tenant, ''), tenantNote: str(o.tenantNote, 500),
    extraContacts: str(o.extraContacts, 2000),
    // параметры
    roomsType: pick(o.roomsType, D.roomsType, ''), rooms: o.rooms === 'studio' ? 'studio' : (o.rooms === '' || o.rooms == null ? '' : str(o.rooms, 10)),
    area: numOrBlank(o.area), livingArea: numOrBlank(o.livingArea), kitchenArea: numOrBlank(o.kitchenArea), kitchenLiving: !!o.kitchenLiving,
    renovation: pick(o.renovation, D.renovation, ''), windows: multi(o.windows, D.windows), yard: multi(o.yard, D.yard),
    ceiling: numOrBlank(o.ceiling), floor: str(o.floor, 20), floors: numOrBlank(o.floors), walls: str(o.walls, 60), slabs: str(o.slabs, 60),
    lifts: o.lifts === 'none' ? 'none' : numOrBlank(o.lifts), parking: multi(o.parking, D.parking),
    price: numOrBlank(o.price), saleReason: str(o.saleReason, 1000),
    description: str(o.description, 5000), developer: str(o.developer, 200), link: str(o.link, 1000), diskLink: /^https?:\/\//.test(o.diskLink || '') ? str(o.diskLink, 1000) : '', note: str(o.note, 5000),
    // договор с собственником
    contractDate: isDate(o.contractDate) ? o.contractDate : '', contractUntil: isDate(o.contractUntil) ? o.contractUntil : '', exclusive: !!o.exclusive,
    // продвижение и расходы
    tips: (Array.isArray(o.tips) ? o.tips : []).slice(0, 40).map(t => ({ key: str(t.key || uid('tip'), 40), title: str(t.title, 200).trim(), done: !!t.done, taskId: str(t.taskId, 64) })).filter(t => t.title),
    expenses: (Array.isArray(o.expenses) ? o.expenses : []).slice(0, 200).map(e => ({ id: str(e.id || uid('exp'), 40), date: isDate(e.date) ? e.date : '', kind: str(e.kind, 60), amount: Number(e.amount) || 0, note: str(e.note, 300), opId: str(e.opId, 64) })).filter(e => e.amount > 0),
    access: cleanAccess(db, o.access, p.access),
    createdAt: p.createdAt || now(), updatedAt: now(),
    cian: p.cian || null, saleType: o.saleType === 'alternative' ? 'alternative' : 'free',
    activeSince: p.activeSince || null, priceHistory: cleanHistory(o.priceHistory !== undefined ? o.priceHistory : p.priceHistory, p.createdAt)
  };
  x.ownerId = x.owners[0] || '';
  if (['active', 'deposit', 'paused'].includes(x.status) && !x.activeSince) x.activeSince = now();
  if (x.status === 'draft') x.activeSince = null;
  // история цены: первая запись — стартовая цена (с датой появления объекта), дальше каждое изменение
  const h = x.priceHistory;
  if (!h.length && prev && prev.price !== '' && prev.price != null && +prev.price > 0) h.push({ at: prev.createdAt || now(), price: +prev.price, note: 'стартовая цена' });
  const lastP = h.length ? h[h.length - 1].price : null;
  if (x.price !== '' && x.price != null && +x.price > 0 && +x.price !== lastP) h.push({ at: now(), price: +x.price, note: h.length ? '' : 'стартовая цена' });
  if (x.description.length > 5000) throw new ApiError('Описание — не больше 5000 символов.');
  return x;
}

function addEvent(db, u, text, objectId, clientId) {
  const id = uid('act'), at = now();
  const a = { id, type: 'event', text, at, userId: u.id, userName: u.name, clientId: clientId || '', leadId: '', dealId: '', objectId };
  db.prepare('INSERT INTO activities(id,at,user_id,client_id,lead_id,deal_id,object_id,data) VALUES(?,?,?,?,?,?,?,?)').run(id, at, u.id, clientId || null, null, null, objectId, J(a));
}

const money = n => (n === '' || n == null) ? '—' : new Intl.NumberFormat('ru-RU').format(Math.round(+n)) + ' ₽';

def('saveObject', 'crm_w', (db, u, o, newOwners) => {
  if (!o || !(String(o.title || '').trim() || String(o.address || '').trim())) throw new ApiError('Укажите название или адрес объекта.');
  let saved;
  tx(db, () => {
    const prevRow = o.id ? db.prepare('SELECT data FROM objects WHERE id=?').get(str(o.id, 64)) : null;
    const prev = prevRow ? P(prevRow.data) : null;
    // новые собственники — создаём карточки контрагентов
    const owners = Array.isArray(o.owners) ? o.owners.slice() : [];
    for (const n of (Array.isArray(newOwners) ? newOwners : [])) {
      const name = str(n && n.name, 300).trim(); if (!name) continue;
      const cp = { id: uid('cl'), name, types: ['owner'], birth: isDate(n.birth) ? n.birth : '', phone: str(n.phone, 200), email: str(n.email, 200), other: '', note: '', agentShare: '', createdAt: now() };
      db.prepare('INSERT INTO counterparties(id,data) VALUES(?,?)').run(cp.id, J(cp));
      audit(db, u, 'создание', 'контрагент', cp.id, null, cp);
      owners.push(cp.id);
    }
    const x = cleanObject(db, Object.assign({}, o, { owners }), prev);
    db.prepare('INSERT INTO objects(id,updated_at,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data').run(x.id, x.updatedAt, J(x));
    if (!prev) addEvent(db, u, `Объект добавлен, статус: ${D.status[x.status]}`, x.id, x.ownerId);
    else {
      if (prev.status !== x.status) addEvent(db, u, `Статус: ${D.status[prev.status] || prev.status} → ${D.status[x.status]}`, x.id, x.ownerId);
      const nv = v => (v === '' || v == null) ? null : Number(v);
      if (nv(prev.price) !== nv(x.price)) addEvent(db, u, `Цена: ${money(prev.price)} → ${money(x.price)}`, x.id, x.ownerId);
      if ((prev.responsibleId || null) !== (x.responsibleId || null)) {
        const nm = id => { const r = id && db.prepare('SELECT name FROM users WHERE id=?').get(id); return r ? r.name : 'нет'; };
        addEvent(db, u, `Ответственный: ${nm(prev.responsibleId)} → ${nm(x.responsibleId)}`, x.id, x.ownerId);
      }
    }
    audit(db, u, prev ? 'изменение' : 'создание', 'объект', x.id, prev, x);
    bump(db);
    saved = x;
  });
  return { object: saved, data: require('./crm').crmLoad(db, u) };
});

def('deleteObject', 'crm_w', (db, u, id) => {
  tx(db, () => {
    const row = db.prepare('SELECT data FROM objects WHERE id=?').get(str(id, 64));
    if (!row) return;
    const needle = '"' + str(id, 64) + '"';
    if (db.prepare('SELECT 1 FROM leads WHERE instr(data, ?)>0 LIMIT 1').get(needle)) throw new ApiError('Объект указан в заявке — сначала уберите его оттуда.');
    if (u.role !== 'owner' && P(row.data).status !== 'draft') throw new ApiError('Удалить можно только черновик. Остальные объекты переведите в «Остановлен» или удалит учредитель.');
    db.prepare('DELETE FROM objects WHERE id=?').run(str(id, 64));
    db.prepare('DELETE FROM inquiries WHERE object_id=?').run(str(id, 64));
    const FL = require('./files');
    db.prepare('DELETE FROM files WHERE object_id=?').run(str(id, 64));
    try { require('node:fs').rmSync(require('node:path').join(FL.dir(db), str(id, 64).replace(/[^\w-]/g, '')), { recursive: true, force: true }); } catch (_) {}
    audit(db, u, 'удаление', 'объект', id, P(row.data), null);
    bump(db);
  });
  return require('./crm').crmLoad(db, u);
});

// Совет → задача ответственному по объекту
def('tipToTask', 'crm_w', (db, u, objectId, key, due) => {
  tx(db, () => {
    const row = db.prepare('SELECT data FROM objects WHERE id=?').get(str(objectId, 64));
    if (!row) throw new ApiError('Объект не найден.');
    const o = P(row.data);
    let tip = (o.tips || []).find(t => t.key === key);
    if (!tip) {
      const def = D.tips.find(t => t[0] === key);
      if (!def) throw new ApiError('Совет не найден.');
      tip = { key, title: def[1], done: false, taskId: '' };
      o.tips = (o.tips || []).concat([tip]);
    }
    if (tip.taskId) {
      const tr = db.prepare('SELECT done FROM tasks WHERE id=?').get(tip.taskId);
      if (tr && (!tr.done || !D.recurring[tip.key])) throw new ApiError('Задача по этому совету уже есть.');
    }
    const t = { id: uid('task'), title: `${D.recurring[tip.key] ? (tip.key === 'owner_report' ? 'Отчёт собственнику' : 'Позвонить собственнику') : tip.title} — ${o.title || o.address}`, note: '', due: isDate(due) ? due : '', time: '', assigneeId: o.responsibleId || u.id,
      clientId: '', leadId: '', dealId: '', objectId: o.id, done: false, doneAt: null, createdBy: u.id, createdAt: now(), updatedAt: now(), tipKey: tip.key };
    db.prepare('INSERT INTO tasks(id,due,done,assignee,updated_at,data) VALUES(?,?,?,?,?,?)').run(t.id, t.due || null, 0, t.assigneeId, t.updatedAt, J(t));
    tip.taskId = t.id;
    db.prepare('UPDATE objects SET data=?, updated_at=? WHERE id=?').run(J(o), now(), o.id);
    audit(db, u, 'создание', 'задача', t.id, null, t);
    bump(db);
  });
  return require('./crm').crmLoad(db, u);
});

// Расход по объекту → операция «Расход» в финансах (нужно право вносить финансы)
def('expenseToFinance', 'fin_w', (db, u, objectId, expId, acc, cat) => {
  tx(db, () => {
    const row = db.prepare('SELECT data FROM objects WHERE id=?').get(str(objectId, 64));
    if (!row) throw new ApiError('Объект не найден.');
    const o = P(row.data);
    const e = (o.expenses || []).find(x => x.id === expId);
    if (!e) throw new ApiError('Сохраните объект, затем вносите расход в финансы.');
    if (e.opId && db.prepare('SELECT 1 FROM ops WHERE id=?').get(e.opId)) throw new ApiError('Этот расход уже внесён в финансы.');
    const cfg = P(require('./db').getMeta(db, 'cfg') || 'null') || {};
    if (!(cfg.accounts || []).some(a => a.id === acc)) throw new ApiError('Выберите счёт.');
    if (!(cfg.categories || []).some(c => c.id === cat && c.kind === 'out')) throw new ApiError('Выберите статью расхода.');
    const date = e.date || new Date().toISOString().slice(0, 10);
    const AB = cfg.archive && cfg.archive.before;
    if (AB && date < AB) throw new ApiError('Дата расхода в закрытом периоде финансов — измените дату.');
    const deal = db.prepare('SELECT id FROM deals WHERE instr(data, ?) > 0 LIMIT 1').get('"objectId":"' + o.id + '"');
    const op = { id: uid('op'), date, type: 'out', amount: Number(e.amount), acc, cat, party: '', comment: `Объект «${o.title || o.address}»: ${e.kind || 'расход'}${e.note ? ' — ' + e.note : ''}`, createdAt: now() };
    if (deal) op.dealId = deal.id;
    db.prepare('INSERT INTO ops(id,date,archive,include,created_at,data) VALUES(?,?,NULL,1,?,?)').run(op.id, op.date, op.createdAt, J(op));
    e.opId = op.id;
    db.prepare('UPDATE objects SET data=?, updated_at=? WHERE id=?').run(J(o), now(), o.id);
    audit(db, u, 'создание из расхода по объекту', 'операция', op.id, null, op);
    bump(db);
  });
  return require('./crm').crmLoad(db, u);
});

module.exports = { D, STATUS_ORDER };

// Двойная проверка ключей: отметка «точно есть» + сообщение ответственному.
def('keysVerified', 'crm_w', (db, u, objectId, where) => {
  const id = str(objectId, 64);
  const row = db.prepare('SELECT data FROM objects WHERE id=?').get(id);
  if (!row) throw new ApiError('Объект не найден.');
  const o = P(row.data);
  const a = o.access || {};
  const place = str(where, KEY_HOLDER_MAX).trim() || a.keysAt || '';
  o.access = Object.assign({}, a, { keysCheck: { confirmed: true, at: now(), by: u.name, note: place } });
  db.prepare('UPDATE objects SET data=?, updated_at=? WHERE id=?').run(J(o), now(), id);
  audit(db, u, 'ключи перепроверены', 'объект', id, null, { где: place });
  bump(db);
  // сообщение ответственному (если он не сам проверял)
  const resp = o.responsibleId && Number(o.responsibleId);
  if (resp && resp !== u.id) {
    const title = o.title || o.address || 'объект';
    const text = `Ключи перепроверены: ${title}. Подтверждено, что ключи на месте${place ? ' (' + place + ')' : ''}. Проверил(а): ${u.name}.`;
    db.prepare('INSERT INTO notifications(user_id,at,kind,entity,entity_id,comment_id,text,read) VALUES(?,?,?,?,?,?,?,0)')
      .run(resp, now(), 'keys', 'object', id, null, text.slice(0, 500));
    try {
      const prefs = require('./prefs').get(db, resp) || {};
      if (prefs.maxUserId) require('./max').send(db, prefs.maxUserId, text.slice(0, 3900), { text: 'Открыть объект', url: 'https://crm.fedset.ru/#objects' });
    } catch (_) { /* уведомление в CRM уже создано */ }
  }
  return require('./crm').crmLoad(db, u);
});
