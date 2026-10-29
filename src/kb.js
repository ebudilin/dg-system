'use strict';
// Справочник: цены на услуги, инструкции, шаблоны документов.
// Читают все; правят учредитель и те, кому он разрешил.
const fs = require('node:fs');
const { getMeta, setMeta } = require('./db');
const { def, can, ApiError, audit, bump, tx, str, J, P } = require('./api');

const KINDS = ['price', 'article', 'tpl'];
const TPL_CATS = { pres: 'Презентации для клиентов', services: 'Договоры на услуги агентства', sale: 'Купля-продажа', rent: 'Аренда и наём', deposit: 'Аванс и задаток', acts: 'Акты, расписки, согласия', other: 'Прочее' };
const ART_CATS = ['Работа в CRM', 'Звонки и показы', 'Сделки', 'Прочее'];
const CO_CATS = ['Продукты', 'Аптеки', 'Банки', 'Кафе и рестораны', 'Фастфуд', 'Одежда и обувь', 'Косметика', 'Алкоголь и табак', 'Пункты выдачи', 'Фитнес', 'Медицина', 'Другое'];
const now = () => Date.now();
const uid = p => p + '_' + now().toString(36) + Math.random().toString(36).slice(2, 8);

const editors = db => { const e = P(getMeta(db, 'kbEditors') || '[]'); return Array.isArray(e) ? e.map(Number) : []; };
const canEdit = (db, u) => !!u && (u.role === 'owner' || (u.role !== 'viewer' && editors(db).includes(Number(u.id))));

function items(db) {
  return db.prepare('SELECT data FROM kb ORDER BY kind, sort, updated_at').all().map(r => P(r.data)).filter(Boolean);
}
function file(db, id) {
  const f = id && db.prepare("SELECT id, name, size, mime FROM files WHERE id=? AND object_id='kb'").get(id);
  return f ? { id: f.id, name: f.name, size: f.size, mime: f.mime } : null;
}
function load(db, u) {
  return {
    items: items(db).map(x => x.kind === 'tpl' ? Object.assign(x, { file: file(db, x.fileId) }) : x),
    canEdit: canEdit(db, u), editors: u.role === 'owner' ? editors(db) : undefined,
    tplCats: TPL_CATS, artCats: ART_CATS, coCats: CO_CATS, canCo: can(u, 'crm_w')
  };
}

function clean(x, prev) {
  const kind = KINDS.includes(x.kind) ? x.kind : (prev && prev.kind);
  if (!kind) throw new ApiError('Неизвестный раздел.');
  const base = { id: (prev && prev.id) || uid('kb'), kind, sort: prev ? prev.sort : now(), updatedAt: now(), by: '' };
  if (kind === 'price') {
    const r = Object.assign(base, { group: str(x.group, 100).trim() || 'Услуги', name: str(x.name, 300).trim(), price: str(x.price, 200).trim(), note: str(x.note, 1000).trim() });
    if (!r.name) throw new ApiError('Укажите название услуги.');
    return r;
  }
  if (kind === 'article') {
    const r = Object.assign(base, { cat: str(x.cat, 100).trim() || 'Прочее', title: str(x.title, 300).trim(), body: str(x.body, 60000) });
    if (!r.title) throw new ApiError('Укажите заголовок.');
    return r;
  }
  const r = Object.assign(base, { cat: TPL_CATS[x.cat] ? x.cat : 'other', title: str(x.title, 300).trim(), note: str(x.note, 1000).trim(), fileId: str(x.fileId != null ? x.fileId : (prev && prev.fileId), 64) });
  if (!r.title) throw new ApiError('Укажите название шаблона.');
  return r;
}

def('kbLoad', null, (db, u) => load(db, u));

def('kbSave', null, (db, u, x) => {
  if (!canEdit(db, u)) throw new ApiError('Править справочник может учредитель или тот, кому он разрешил.', 403);
  tx(db, () => {
    const prevRow = x && x.id ? db.prepare('SELECT data FROM kb WHERE id=?').get(str(x.id, 64)) : null;
    const prev = prevRow ? P(prevRow.data) : null;
    const r = clean(x || {}, prev);
    r.by = u.name;
    if (r.kind === 'tpl' && r.fileId && !file(db, r.fileId)) throw new ApiError('Файл шаблона не найден — загрузите его снова.');
    if (prev && prev.kind === 'tpl' && prev.fileId && prev.fileId !== r.fileId) dropFile(db, prev.fileId);
    db.prepare('INSERT INTO kb(id,kind,sort,updated_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sort=excluded.sort, updated_at=excluded.updated_at, data=excluded.data').run(r.id, r.kind, r.sort, r.updatedAt, J(r));
    audit(db, u, prev ? 'изменение' : 'создание', 'справочник', r.id, prev, r);
    bump(db);
  });
  return load(db, u);
});

function dropFile(db, id) {
  const f = db.prepare("SELECT * FROM files WHERE id=? AND object_id='kb'").get(id);
  if (!f) return;
  db.prepare('DELETE FROM files WHERE id=?').run(id);
  const FILES = require('./files');
  for (const t of ['', '_t']) { try { fs.unlinkSync(require('node:path').join(FILES.dir(db), 'kb', id + t)); } catch (_) {} }
}

def('kbDelete', null, (db, u, id) => {
  if (!canEdit(db, u)) throw new ApiError('Нет прав на правку справочника.', 403);
  tx(db, () => {
    const row = db.prepare('SELECT data FROM kb WHERE id=?').get(str(id, 64));
    if (!row) return;
    const r = P(row.data);
    if (r.kind === 'tpl' && r.fileId) dropFile(db, r.fileId);
    db.prepare('DELETE FROM kb WHERE id=?').run(r.id);
    audit(db, u, 'удаление', 'справочник', r.id, r, null);
    bump(db);
  });
  return load(db, u);
});

// поменять местами с соседом в той же группе
def('kbMove', null, (db, u, id, dir) => {
  if (!canEdit(db, u)) throw new ApiError('Нет прав на правку справочника.', 403);
  tx(db, () => {
    const all = items(db), me = all.find(x => x.id === id);
    if (!me) return;
    const grp = x => x.kind === me.kind && (me.kind === 'price' ? x.group === me.group : x.cat === me.cat);
    const list = all.filter(grp), i = list.indexOf(me), j = i + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= list.length) return;
    list.forEach((x, k) => { x.sort = k; });
    [list[i].sort, list[j].sort] = [list[j].sort, list[i].sort];
    list.forEach(x => db.prepare('UPDATE kb SET sort=?, data=? WHERE id=?').run(x.sort, J(x), x.id));
    bump(db);
  });
  return load(db, u);
});

def('kbSetEditors', 'owner', (db, u, ids) => {
  const valid = (Array.isArray(ids) ? ids : []).map(Number).filter(id => db.prepare('SELECT 1 FROM users WHERE id=?').get(id));
  setMeta(db, 'kbEditors', J(valid));
  audit(db, u, 'редакторы справочника', 'справочник', null, null, valid);
  return load(db, u);
});

/* ---------- стартовое наполнение (один раз) ---------- */
const SEED = [
  ['price', { group: 'Жильё: продажа и покупка', name: 'Продажа квартиры или дома (работаем с продавцом)', price: '3% от цены продажи', note: '' }],
  ['price', { group: 'Жильё: продажа и покупка', name: 'Поиск квартиры для покупателя (вторичное жильё)', price: '400 000 ₽', note: 'При цене квартиры от 40 млн ₽' }],
  ['price', { group: 'Жильё: продажа и покупка', name: 'Поиск квартиры для покупателя (вторичное жильё)', price: '300 000 ₽', note: 'При цене квартиры до 40 млн ₽' }],
  ['price', { group: 'Аренда', name: 'Сдача квартиры в аренду', price: '100% месячной арендной ставки', note: '' }],
  ['price', { group: 'Юридические услуги', name: 'Сопровождение сделки', price: '150 000 ₽', note: '' }],
  ['price', { group: 'Юридические услуги', name: 'Юридическое сопровождение (отдельная услуга)', price: '150 000 ₽', note: '' }],
  ['article', { cat: 'Звонки и показы', title: 'Звонок по объекту: что делать', body: `## Во время разговора
- Представьтесь: «Дорогой Город, [имя], слушаю вас».
- Узнайте имя и **кто звонит: сам покупатель (арендатор) или агент**. Спросите прямо: «Вы смотрите для себя или представляете клиента?»
- Уточните, где увидели объявление: ЦИАН, Авито, сайт.
- Ответьте на вопросы по объекту, предложите показ и сразу договоритесь о дате и времени.

## Вопросы прямому интересанту
- Для себя или для семьи? Кто ещё участвует в решении?
- Бюджет и способ оплаты: свои деньги, ипотека (одобрена?), продажа своей квартиры.
- Сроки: когда хочет выйти на сделку или заехать.
- Что важно: район, метро, площадь, этаж, ремонт.

## Сразу после разговора — в CRM
1. Вкладка «Звонки» → у номера нажмите **«По объекту»**, выберите объект, отметьте «Прямой интересант» или «Агент».
2. Договорились о показе — этап «Показ назначен», дата и время. Задача на показ появится у ответственного по объекту.
3. Звонок пришёл не через телефонию (мессенджер, личный номер) — карточка объекта → «Обращения» → «Новое обращение».

## После показа
- Этап «Показ проведён» и впечатления в комментарии. CRM поставит задачу узнать решение на следующий день.
- Дальше: «Думает», «Торг», «Задаток» или «Не подошёл» с причиной.

## Прямой интересант — это потенциальный клиент
Если объект не подошёл, предложите наши услуги поиска: подберём варианты, проверим документы, проведём сделку. Цены — в разделе «Цены на услуги». В CRM нажмите **«Предложить подбор»** — появится заявка в воронке.

## Агент
Запишите агентство и имя. Агенты — тоже база: им можно отправлять наши новые объекты.` }],
  ['article', { cat: 'Звонки и показы', title: 'Показ объекта', body: `## Перед показом
- Подтвердите показ с интересантом и собственником за 2–3 часа.
- Проверьте, что в квартире порядок, есть свет, ключи у вас или собственник на месте.
- Возьмите планировку и основные цифры: цена, площадь, расходы на содержание, когда квартира освобождается.

## На показе
- Приходите заранее. Ведите по плану: вход → лучшие комнаты → вид из окна → кухня и санузлы.
- Спрашивайте, что нравится и что смущает — это пойдёт в отчёт собственнику.
- Не обсуждайте снижение цены от имени собственника без его согласия.

## После показа
- В тот же день: этап «Показ проведён» и комментарий в обращении.
- Если интересант заинтересован — следующий шаг: повторный показ, встреча, торг.
- Обратную связь передайте собственнику: она войдёт в регулярный отчёт.` }],
  ['article', { cat: 'Сделки', title: 'Купля-продажа квартиры (вторичное жильё): этапы', body: `Черновик — дополните под наши правила.

## 1. Договор с клиентом
Подписываем договор на услуги (шаблон — в разделе «Шаблоны документов»). Фиксируем стоимость и что входит в работу.

## 2. Проверка объекта и продавца
- Выписка из ЕГРН: собственники, обременения, аресты.
- Правоустанавливающие документы: на каком основании получена квартира.
- Кто зарегистрирован в квартире; есть ли у несовершеннолетних доли (нужно разрешение опеки).
- Согласие супруга, если квартира куплена в браке.
- Доверенности, наследство, недавние сделки — повод для дополнительной проверки юристом.

## 3. Аванс или задаток
Соглашение: сумма, срок выхода на сделку, что делает каждая сторона до сделки, что происходит с деньгами при срыве.

## 4. Подготовка к сделке
- Ипотека: одобрение покупателя и объекта банком, оценка, страхование.
- Расчёты: аккредитив, безопасная сделка банка или ячейка.
- Согласовать дату, место и список документов.

## 5. Сделка
Подписание договора купли-продажи и подача на регистрацию (МФЦ, банк или нотариус — если сделка нотариальная).

## 6. После регистрации
Расчёт с продавцом, передача квартиры по акту, снятие с регистрационного учёта в срок по договору, оплата нашего вознаграждения. Отмечайте этапы в сделке в CRM.` }],
  ['article', { cat: 'Сделки', title: 'Аренда (наём) квартиры: этапы', body: `Договор **найма** — когда квартиру снимает человек; договор **аренды** — когда снимает компания.

## Работа с собственником
- Договор на услуги, фото, текст объявления, ставка и условия: депозит, животные, дети, срок.
- Проверить право собственности (выписка ЕГРН) и что сдаёт собственник или его представитель по доверенности.

## Показы и выбор арендатора
- Звонки фиксируем как обращения по объекту, показы — этапами обращения.
- Узнать у кандидата: кто будет жить, срок, работа, животные.

## Сделка
- Договор найма (аренды), опись имущества и акт приёма-передачи: состояние, показания счётчиков, ключи.
- Оплата: первый месяц и депозит — собственнику; наше вознаграждение — по прайсу.

## После заселения
Попросить отзыв, поставить задачу на окончание договора — напомнить собственнику заранее.` }],
  ['article', { cat: 'Работа в CRM', title: 'Короткая памятка по CRM', body: `- **Сегодня** — ваши задачи и напоминания. Начинайте день отсюда.
- **Звонки** — разберите новые номера: «По объекту», «Заявка», «Это клиент…» или «Не клиент».
- **Обращения** — все, кто звонил по объектам. Прямым интересантам, которым объект не подошёл, предлагайте подбор.
- **Объекты** — карточка объекта: фото, документы, обращения, площадки, история.
- **Заявки** — воронка клиентов на наши услуги. У каждой заявки должна быть следующая задача.
- **Справочник** — цены, инструкции, шаблоны документов.` }]
];

function seed(db) {
  if (getMeta(db, 'kbSeeded')) return;
  tx(db, () => {
    if (!db.prepare('SELECT 1 FROM kb LIMIT 1').get()) {
      SEED.forEach(([kind, x], i) => { const r = clean(Object.assign({ kind }, x), null); r.sort = i; r.by = 'Стартовое наполнение'; db.prepare('INSERT INTO kb(id,kind,sort,updated_at,data) VALUES(?,?,?,?,?)').run(r.id + i, kind, i, now(), J(Object.assign(r, { id: r.id + i }))); });
    }
    setMeta(db, 'kbSeeded', '1');
  });
}

/* ---------- сети и арендаторы: компания и несколько контактов с комментариями ---------- */
const cuid = p => p + '_' + now().toString(36) + Math.random().toString(36).slice(2, 7);
function cleanContact(c, prev) {
  return { id: (prev && prev.id) || str(c.id, 64) || cuid('ct'), name: str(c.name, 200).trim(), role: str(c.role, 200).trim(), phone: str(c.phone, 100).trim(),
    email: str(c.email, 200).trim(), notes: (prev && prev.notes) || [] };
}
function getCo(db, id) { const r = db.prepare("SELECT data FROM kb WHERE id=? AND kind='company'").get(str(id, 64)); return r ? P(r.data) : null; }
function putCo(db, c) { c.updatedAt = now(); db.prepare('INSERT INTO kb(id,kind,sort,updated_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data').run(c.id, 'company', c.sort || 0, c.updatedAt, J(c)); }
const needW = u => { if (!can(u, 'crm_w')) throw new ApiError('Недостаточно прав.', 403); };

def('kbSaveCompany', null, (db, u, x) => {
  needW(u);
  tx(db, () => {
    const prev = x && x.id ? getCo(db, x.id) : null;
    const c = { id: (prev && prev.id) || cuid('co'), kind: 'company', sort: (prev && prev.sort) || now(), name: str(x.name, 200).trim(), cat: str(x.cat, 100).trim() || 'Другое',
      site: str(x.site, 300).trim(), reqs: str(x.reqs, 3000), note: str(x.note, 3000), by: (prev && prev.by) || u.name, contacts: (prev && prev.contacts) || [] };
    if (!c.name) throw new ApiError('Укажите название компании.');
    const dup = db.prepare("SELECT data FROM kb WHERE kind='company'").all().map(r => P(r.data)).find(o => o && o.id !== c.id && o.name.toLowerCase() === c.name.toLowerCase());
    if (dup) throw new ApiError(`Компания «${dup.name}» уже есть в справочнике.`);
    putCo(db, c);
    audit(db, u, prev ? 'изменение' : 'создание', 'компания', c.id, prev, c);
    bump(db);
  });
  return load(db, u);
});
def('kbDeleteCompany', null, (db, u, id) => {
  needW(u);
  const c = getCo(db, id);
  if (!c) return load(db, u);
  if (c.contacts.length && !canEdit(db, u)) throw new ApiError('Компанию с контактами удаляет учредитель или редактор справочника.');
  db.prepare('DELETE FROM kb WHERE id=?').run(c.id);
  audit(db, u, 'удаление', 'компания', c.id, c, null); bump(db);
  return load(db, u);
});
def('kbSaveContact', null, (db, u, companyId, x) => {
  needW(u);
  tx(db, () => {
    const c = getCo(db, companyId); if (!c) throw new ApiError('Компания не найдена.');
    const i = x && x.id ? c.contacts.findIndex(k => k.id === x.id) : -1;
    const k = cleanContact(x || {}, i >= 0 ? c.contacts[i] : null);
    if (!k.name && !k.phone && !k.email) throw new ApiError('Укажите имя, телефон или почту контакта.');
    if (i >= 0) c.contacts[i] = k; else { k.by = u.name; k.at = now(); c.contacts.push(k); }
    if (x && String(x.comment || '').trim()) k.notes.push({ text: str(x.comment, 2000).trim(), by: u.name, at: now() });
    putCo(db, c); audit(db, u, i >= 0 ? 'изменение контакта' : 'новый контакт', 'компания', c.id, null, k); bump(db);
  });
  return load(db, u);
});
def('kbDeleteContact', null, (db, u, companyId, contactId) => {
  needW(u);
  const c = getCo(db, companyId); if (!c) throw new ApiError('Компания не найдена.');
  const k = c.contacts.find(x => x.id === contactId);
  c.contacts = c.contacts.filter(x => x.id !== contactId);
  putCo(db, c); audit(db, u, 'удаление контакта', 'компания', c.id, k, null); bump(db);
  return load(db, u);
});
def('kbContactComment', null, (db, u, companyId, contactId, text) => {
  needW(u);
  const c = getCo(db, companyId); if (!c) throw new ApiError('Компания не найдена.');
  const k = c.contacts.find(x => x.id === contactId); if (!k) throw new ApiError('Контакт не найден.');
  if (!String(text || '').trim()) throw new ApiError('Напишите комментарий.');
  k.notes.push({ text: str(text, 2000).trim(), by: u.name, at: now() });
  putCo(db, c); bump(db);
  return load(db, u);
});
// вставка из таблицы: Компания | Контакт | Должность | Телефон | Email | Комментарий | Категория
def('kbImportCompanies', null, (db, u, text) => {
  needW(u);
  const rows = String(text || '').split(/\r?\n/).map(l => l.split(/\t|;/).map(x => x.trim())).filter(r => r[0]);
  if (rows.length && /компан|сеть|название/i.test(rows[0][0])) rows.shift();
  if (!rows.length) throw new ApiError('Вставьте строки из таблицы: Компания, Контакт, Должность, Телефон, Email, Комментарий, Категория.');
  let nCo = 0, nCt = 0;
  tx(db, () => {
    const all = db.prepare("SELECT data FROM kb WHERE kind='company'").all().map(r => P(r.data)).filter(Boolean);
    const byName = {}; all.forEach(c => { byName[c.name.toLowerCase()] = c; });
    const touched = new Set();
    rows.slice(0, 2000).forEach(([name, cname, role, phone, email, comment, cat]) => {
      let c = byName[name.toLowerCase()];
      if (!c) { c = { id: cuid('co'), kind: 'company', sort: now(), name: str(name, 200), cat: str(cat, 100) || 'Другое', site: '', reqs: '', note: '', by: u.name, contacts: [] }; byName[name.toLowerCase()] = c; nCo++; }
      else if (cat && c.cat === 'Другое') c.cat = str(cat, 100);
      if (cname || phone || email) {
        const ex = c.contacts.find(k => (phone && k.phone && k.phone.replace(/\D/g, '').slice(-10) === phone.replace(/\D/g, '').slice(-10)) || (cname && k.name.toLowerCase() === cname.toLowerCase()));
        if (!ex) { const k = cleanContact({ name: cname, role, phone, email }); k.by = u.name; k.at = now(); if (comment) k.notes.push({ text: str(comment, 2000), by: u.name, at: now() }); c.contacts.push(k); nCt++; }
        else if (comment && !ex.notes.some(n => n.text === comment)) ex.notes.push({ text: str(comment, 2000), by: u.name, at: now() });
      }
      touched.add(c);
    });
    touched.forEach(c => putCo(db, c));
    audit(db, u, 'импорт компаний', 'справочник', null, null, { companies: nCo, contacts: nCt });
    bump(db);
  });
  return Object.assign(load(db, u), { imported: { companies: nCo, contacts: nCt } });
});

module.exports = { canEdit, seed, items };
