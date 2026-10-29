'use strict';
// Выгрузка объектов на ЦИАН XML-фидом (формат feed_version 2).
// В фид попадает объект только после явного решения учредителя («Выгружать на ЦИАН»).
const crypto = require('node:crypto');
const { getMeta, setMeta } = require('./db');
const { def, ApiError, audit, bump, tx, str, J, P } = require('./api');
const FILES = require('./files');

const STATES = { off: 'Не выгружается', ready: 'Готов, ждёт решения', on: 'Выгружается на ЦИАН' };

function settings(db) {
  const s = P(getMeta(db, 'cian') || 'null') || {};
  if (!s.token) { s.token = crypto.randomBytes(16).toString('hex'); setMeta(db, 'cian', J(s)); }
  return Object.assign({ phone: '+74951280041', baseUrl: 'https://crm.fedset.ru' }, s);
}

const digits = s => String(s || '').replace(/\D/g, '');
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
const esc = s => String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const floorNum = f => { const m = String(f || '').match(/-?\d+/); return m ? +m[0] : null; };

const MAP = {
  rooms: v => v === 'studio' ? 9 : v === '7+' || +v >= 6 ? 6 : (+v >= 1 ? +v : null),
  roomType: { isolated: 'separate', adjacent: 'combined', mixed: 'both' },
  repair: { designer: 'design', euro: 'euro', after: 'cosmetic', finished: 'cosmetic', standard: 'cosmetic', needs: 'no', capital: 'no', rough: 'no', prefinish: 'no' },
  walls: { 'кирпич': 'brick', 'монолит': 'monolith', 'монолит-кирпич': 'monolithBrick', 'панель': 'panel', 'блоки': 'block', 'дерево': 'wood' },
  parking: { ground: 'ground', multilevel: 'multilevel', underground: 'underground' }
};

// что мешает выгрузке (пустой список — можно выгружать)
function check(o, files, s) {
  const p = [];
  if (o.kind !== 'flat') p.push('пока выгружаются только квартиры');
  if (!o.address) p.push('адрес');
  if (!(num(o.price) > 0)) p.push('цена');
  if (!(num(o.area) > 0)) p.push('общая площадь');
  if (floorNum(o.floor) == null) p.push('этаж');
  if (!(num(o.floors) > 0)) p.push('этажей в здании');
  if (MAP.rooms(o.rooms) == null) p.push('количество комнат');
  const d = (o.description || '').trim().length;
  if (d < 15) p.push('описание');
  else if (d > 3000) p.push('описание длиннее 3000 знаков — сократите');
  if (num(o.livingArea) != null && num(o.kitchenArea) != null && num(o.area) && num(o.livingArea) + num(o.kitchenArea) >= num(o.area)) p.push('жилая + кухня должны быть меньше общей площади');
  if (!files.some(f => f.kind === 'photo')) p.push('хотя бы одно фото');
  if (digits(s.phone).length < 10) p.push('телефон для объявлений в настройках');
  return p;
}

function objectXml(o, files, s) {
  const base = s.baseUrl.replace(/\/$/, '');
  const photos = files.filter(f => f.kind === 'photo'), plans = files.filter(f => f.kind === 'plan');
  const ph = digits(s.phone).slice(-10);
  const t = (tag, v) => (v === null || v === undefined || v === '') ? '' : `<${tag}>${esc(v)}</${tag}>`;
  const win = (o.windows || []).includes('yard') && (o.windows || []).includes('street') ? 'yardAndStreet' : (o.windows || []).includes('yard') ? 'yard' : (o.windows || []).includes('street') ? 'street' : '';
  const park = (o.parking || []).map(k => MAP.parking[k]).find(Boolean);
  const rent = o.offer === 'rent';
  return `<object>
${t('ExternalId', o.id)}
${t('Category', rent ? 'flatRent' : 'flatSale')}
${t('Description', (o.description || '').trim())}
${t('Address', o.address)}
${t('CadastralNumber', o.cadastral)}
<Phones><PhoneSchema><CountryCode>+7</CountryCode><Number>${esc(ph)}</Number></PhoneSchema></Phones>
${t('FlatRoomsCount', MAP.rooms(o.rooms))}
${t('RoomType', MAP.roomType[o.roomsType])}
${t('TotalArea', num(o.area))}
${t('LivingArea', num(o.livingArea))}
${t('KitchenArea', num(o.kitchenArea))}
${t('FloorNumber', floorNum(o.floor))}
${t('RepairType', MAP.repair[o.renovation])}
${t('WindowsViewType', win)}
<Building>${t('FloorsCount', num(o.floors))}${t('MaterialType', MAP.walls[String(o.walls || '').trim().toLowerCase()])}${t('CeilingHeight', num(o.ceiling))}${o.lifts === 'none' ? '<PassengerLiftsCount>0</PassengerLiftsCount>' : t('PassengerLiftsCount', num(o.lifts))}${park ? `<Parking><Type>${park}</Type></Parking>` : ''}</Building>
<BargainTerms>${t('Price', num(o.price))}<Currency>rur</Currency>${rent ? '<LeaseTermType>longTerm</LeaseTermType>' : `<SaleType>${o.saleType === 'alternative' ? 'alternative' : 'free'}</SaleType>`}</BargainTerms>
<Photos>${photos.map((f, i) => `<PhotoSchema><FullUrl>${esc(base + '/pub/' + f.key + '.jpg')}</FullUrl><IsDefault>${i === 0}</IsDefault></PhotoSchema>`).join('')}</Photos>
${plans[0] ? `<LayoutPhoto><FullUrl>${esc(base + '/pub/' + plans[0].key + '.jpg')}</FullUrl><IsDefault>true</IsDefault></LayoutPhoto>` : ''}
</object>`.replace(/\n{2,}/g, '\n');
}

function feed(db) {
  const s = settings(db), out = [];
  for (const r of db.prepare('SELECT data FROM objects').all()) {
    const o = P(r.data);
    if (!o || !o.cian || o.cian.state !== 'on') continue;
    if (!['active', 'deposit'].includes(o.status)) continue; // остановленные, срывы и проданные снимаются автоматически
    const files = FILES.objectFiles(db, o.id);
    if (check(o, files, s).length) continue;
    out.push(objectXml(o, files, s));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed>\n<feed_version>2</feed_version>\n${out.join('\n')}\n</feed>\n`;
}

/* ---------- API ---------- */
def('cianStatus', null, (db, u, objectId) => {
  const row = db.prepare('SELECT data FROM objects WHERE id=?').get(str(objectId, 64));
  if (!row) throw new ApiError('Объект не найден.');
  const o = P(row.data), s = settings(db), files = FILES.objectFiles(db, o.id);
  const problems = check(o, files, s);
  return { state: (o.cian && o.cian.state) || 'off', cian: o.cian || null, problems, inFeed: !problems.length && o.cian && o.cian.state === 'on' && ['active', 'deposit'].includes(o.status),
    preview: objectXml(o, files, s), states: STATES };
});

// staff: off ↔ ready; включить выгрузку (on) — только учредитель
def('setCianState', 'crm_w', (db, u, objectId, state) => {
  if (!STATES[state]) throw new ApiError('Неизвестное состояние.');
  if (state === 'on' && u.role !== 'owner') throw new ApiError('Включить выгрузку на ЦИАН может только учредитель. Отметьте объект как «Готов» — учредитель увидит его в списке.');
  tx(db, () => {
    const row = db.prepare('SELECT data FROM objects WHERE id=?').get(str(objectId, 64));
    if (!row) throw new ApiError('Объект не найден.');
    const o = P(row.data);
    if (state === 'on') { const pr = check(o, FILES.objectFiles(db, o.id), settings(db)); if (pr.length) throw new ApiError('Не хватает: ' + pr.join(', ') + '.'); }
    const prev = o.cian || null;
    o.cian = { state, by: u.name, at: Date.now() };
    db.prepare('UPDATE objects SET data=?, updated_at=? WHERE id=?').run(J(o), Date.now(), o.id);
    const txt = { off: 'Выгрузка на ЦИАН выключена', ready: 'Объект отмечен как готовый к выгрузке на ЦИАН', on: 'Включена выгрузка на ЦИАН' }[state];
    const a = { id: 'act_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), type: 'event', text: txt, at: Date.now(), userId: u.id, userName: u.name, clientId: o.ownerId || '', leadId: '', dealId: '', objectId: o.id };
    db.prepare('INSERT INTO activities(id,at,user_id,client_id,lead_id,deal_id,object_id,data) VALUES(?,?,?,?,?,?,?,?)').run(a.id, a.at, u.id, a.clientId || null, null, null, o.id, J(a));
    audit(db, u, txt, 'объект', o.id, prev, o.cian);
    bump(db);
  });
  return require('./crm').crmLoad(db, u);
});

def('cianSettings', 'owner', (db) => { const s = settings(db); return Object.assign({}, s, { feedPath: '/feeds/cian/' + s.token + '.xml' }); });
def('saveCianSettings', 'owner', (db, u, x) => {
  const s = settings(db);
  if (x && x.phone != null) { if (digits(x.phone).length < 10) throw new ApiError('Укажите телефон полностью.'); s.phone = str(x.phone, 30); }
  if (x && x.baseUrl) s.baseUrl = /^https?:\/\/[\w.-]+(:\d+)?$/.test(x.baseUrl) ? x.baseUrl : s.baseUrl;
  if (x && x.newToken) s.token = crypto.randomBytes(16).toString('hex');
  setMeta(db, 'cian', J(s));
  audit(db, u, 'настройки ЦИАН', 'интеграции', null, null, { phone: s.phone, newToken: !!(x && x.newToken) });
  return Object.assign({}, s, { feedPath: '/feeds/cian/' + s.token + '.xml' });
});

module.exports = { feed, settings, STATES };
