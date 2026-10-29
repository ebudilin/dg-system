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
    ['ads', 'Разместить объявления: ЦИАН, Авито, Яндекс']
  ],
  inqChannels: ['ЦИАН', 'Авито', 'Яндекс Недвижимость', 'Домклик', 'Сайт', 'Звонок на номер агентства', 'Рекомендация', 'Соцсети', 'Другое'],
  inqWho: { buyer: 'Прямой покупатель', agent: 'Агент' }
};

const now = () => Date.now();
const uid = p => p + '_' + now().toString(36) + Math.random().toString(36).slice(2, 8);
const pick = (v, dict, def) => Object.prototype.hasOwnProperty.call(dict, v) ? v : def;
const multi = (v, dict) => (Array.isArray(v) ? v : []).filter(k => Object.prototype.hasOwnProperty.call(dict, k));
const optRef = (db, table, id) => { id = str(id, 64); return id && db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id) ? id : ''; };
const optUser = (db, id) => (id && db.prepare('SELECT 1 FROM users WHERE id=?').get(Number(id))) ? Number(id) : null;
const STATUS_ORDER = ['draft', 'active', 'paused', 'deposit', 'failed', 'sold'];

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
    description: str(o.description, 5000), developer: str(o.developer, 200), link: str(o.link, 1000), note: str(o.note, 5000),
    // договор с собственником
    contractDate: isDate(o.contractDate) ? o.contractDate : '', contractUntil: isDate(o.contractUntil) ? o.contractUntil : '', exclusive: !!o.exclusive,
    // продвижение и расходы
    tips: (Array.isArray(o.tips) ? o.tips : []).slice(0, 40).map(t => ({ key: str(t.key || uid('tip'), 40), title: str(t.title, 200).trim(), done: !!t.done, taskId: str(t.taskId, 64) })).filter(t => t.title),
    expenses: (Array.isArray(o.expenses) ? o.expenses : []).slice(0, 200).map(e => ({ id: str(e.id || uid('exp'), 40), date: isDate(e.date) ? e.date : '', kind: str(e.kind, 60), amount: Number(e.amount) || 0, note: str(e.note, 300) })).filter(e => e.amount > 0),
    createdAt: p.createdAt || now(), updatedAt: now(),
    activeSince: p.activeSince || null, priceHistory: Array.isArray(p.priceHistory) ? p.priceHistory.slice(-50) : []
  };
  x.ownerId = x.owners[0] || '';
  if (['active', 'deposit', 'paused'].includes(x.status) && !x.activeSince) x.activeSince = now();
  if (x.status === 'draft') x.activeSince = null;
  if (prev && (prev.price === '' || prev.price == null ? null : +prev.price) !== (x.price === '' ? null : +x.price) && x.price !== '') x.priceHistory.push({ at: now(), from: prev.price, to: x.price });
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
    const tip = (o.tips || []).find(t => t.key === key);
    if (!tip) throw new ApiError('Совет не найден.');
    if (tip.taskId && db.prepare('SELECT 1 FROM tasks WHERE id=?').get(tip.taskId)) throw new ApiError('Задача по этому совету уже есть.');
    const t = { id: uid('task'), title: `${tip.title} — ${o.title || o.address}`, note: '', due: isDate(due) ? due : '', time: '', assigneeId: o.responsibleId || u.id,
      clientId: '', leadId: '', dealId: '', objectId: o.id, done: false, doneAt: null, createdBy: u.id, createdAt: now(), updatedAt: now(), tipKey: tip.key };
    db.prepare('INSERT INTO tasks(id,due,done,assignee,updated_at,data) VALUES(?,?,?,?,?,?)').run(t.id, t.due || null, 0, t.assigneeId, t.updatedAt, J(t));
    tip.taskId = t.id;
    db.prepare('UPDATE objects SET data=?, updated_at=? WHERE id=?').run(J(o), now(), o.id);
    audit(db, u, 'создание', 'задача', t.id, null, t);
    bump(db);
  });
  return require('./crm').crmLoad(db, u);
});

/* ---------- обращения по объекту ---------- */
function cleanInq(db, q, prev) {
  const objectId = optRef(db, 'objects', q.objectId || (prev && prev.objectId));
  if (!objectId) throw new ApiError('Объект не найден.');
  return {
    id: str(q.id || (prev && prev.id) || uid('inq'), 64), objectId,
    at: Number(q.at) || (prev && prev.at) || now(),
    name: str(q.name, 200).trim(), phone: str(q.phone, 100).trim(), channel: str(q.channel, 100).trim(),
    who: pick(q.who, D.inqWho, 'buyer'), note: str(q.note, 2000),
    result: str(q.result, 300), leadId: (prev && prev.leadId) || '',
    userId: (prev && prev.userId) || null, userName: (prev && prev.userName) || ''
  };
}

def('listInquiries', null, (db, u, objectId) =>
  db.prepare('SELECT data FROM inquiries WHERE object_id=? ORDER BY at DESC').all(str(objectId, 64)).map(r => P(r.data)).filter(Boolean));

def('saveInquiry', 'crm_w', (db, u, q) => {
  if (!q || !(String(q.name || '').trim() || String(q.phone || '').trim())) throw new ApiError('Укажите имя или телефон звонившего.');
  let x;
  tx(db, () => {
    const prevRow = q.id ? db.prepare('SELECT data FROM inquiries WHERE id=?').get(str(q.id, 64)) : null;
    const prev = prevRow ? P(prevRow.data) : null;
    x = cleanInq(db, q, prev);
    if (!prev) { x.userId = u.id; x.userName = u.name; }
    db.prepare('INSERT INTO inquiries(id,object_id,at,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at, data=excluded.data').run(x.id, x.objectId, x.at, J(x));
    audit(db, u, prev ? 'изменение' : 'создание', 'обращение', x.id, prev, x);
    bump(db);
  });
  return x;
});

def('deleteInquiry', 'crm_w', (db, u, id) => {
  tx(db, () => {
    const row = db.prepare('SELECT data FROM inquiries WHERE id=?').get(str(id, 64));
    if (!row) return;
    db.prepare('DELETE FROM inquiries WHERE id=?').run(str(id, 64));
    audit(db, u, 'удаление', 'обращение', id, P(row.data), null);
    bump(db);
  });
  return { ok: true };
});

// Обращение прямого покупателя → заявка на покупку с этим объектом
def('inquiryToLead', 'crm_w', (db, u, id) => {
  tx(db, () => {
    const row = db.prepare('SELECT data FROM inquiries WHERE id=?').get(str(id, 64));
    if (!row) throw new ApiError('Обращение не найдено.');
    const q = P(row.data);
    if (q.leadId && db.prepare('SELECT 1 FROM leads WHERE id=?').get(q.leadId)) throw new ApiError('Заявка по обращению уже создана.');
    const o = P(db.prepare('SELECT data FROM objects WHERE id=?').get(q.objectId).data);
    const cp = { id: uid('cl'), name: q.name || q.phone, types: ['buyer'], birth: '', phone: q.phone, email: '', other: '', note: '', agentShare: '', createdAt: now() };
    db.prepare('INSERT INTO counterparties(id,data) VALUES(?,?)').run(cp.id, J(cp));
    const l = { id: uid('lead'), title: `Покупка — ${cp.name} (${o.title || o.address})`, clientId: cp.id, kind: o.offer === 'rent' ? 'rent' : 'buy', source: q.channel,
      budget: '', stage: 'new', ownerId: o.responsibleId || u.id, objectId: o.id, dealId: '', note: q.note, lostReason: '',
      createdAt: now(), createdBy: u.id, stageAt: now(), updatedAt: now() };
    db.prepare('INSERT INTO leads(id,stage,updated_at,data) VALUES(?,?,?,?)').run(l.id, l.stage, l.updatedAt, J(l));
    q.leadId = l.id; q.result = q.result || 'Создана заявка';
    db.prepare('UPDATE inquiries SET data=? WHERE id=?').run(J(q), q.id);
    const a = { id: uid('act'), type: 'event', text: `Создана заявка из обращения по объекту «${o.title || o.address}»`, at: now(), userId: u.id, userName: u.name, clientId: cp.id, leadId: l.id, dealId: '', objectId: o.id };
    db.prepare('INSERT INTO activities(id,at,user_id,client_id,lead_id,deal_id,object_id,data) VALUES(?,?,?,?,?,?,?,?)').run(a.id, a.at, u.id, cp.id, l.id, null, o.id, J(a));
    audit(db, u, 'создание из обращения', 'заявка', l.id, null, l);
    bump(db);
  });
  return require('./crm').crmLoad(db, u);
});

function inquiryCounts(db) {
  const out = {};
  for (const r of db.prepare('SELECT object_id, COUNT(*) n, MAX(at) last FROM inquiries GROUP BY object_id').all()) out[r.object_id] = { n: r.n, last: r.last };
  return out;
}

module.exports = { D, STATUS_ORDER, inquiryCounts };
