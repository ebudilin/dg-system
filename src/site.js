'use strict';
// Публичные ссылки компании (футер) и реквизиты ООО: редактирует учредитель в настройках.
// Реквизиты отдаются страницей /requisites и скачиваются как PDF.
const { getMeta, setMeta } = require('./db');
const { def, ApiError, audit, bump, str, J, P } = require('./api');

const LINKS = [
  { key: 'site', label: 'Сайт Дорогой Город' },
  { key: 'fedset', label: 'Сайт Федсеть' },
  { key: 'vk', label: 'Группа в VK' },
  { key: 'instagram', label: 'Инстаграм' },
  { key: 'telegram', label: 'Канал в Телеграм' },
  { key: 'dzen', label: 'Яндекс Дзен' },
  { key: 'vc', label: 'VC' },
  { key: 'max', label: 'Канал в Max' }
];
const REQ_FIELDS = [
  ['fullName', 'Полное наименование'], ['shortName', 'Сокращённое наименование'],
  ['inn', 'ИНН'], ['kpp', 'КПП'], ['ogrn', 'ОГРН'], ['okpo', 'ОКПО'],
  ['legalAddress', 'Юридический адрес'], ['postAddress', 'Почтовый адрес'],
  ['bank', 'Банк'], ['bik', 'БИК'], ['account', 'Расчётный счёт'], ['corrAccount', 'Корр. счёт'],
  ['director', 'Руководитель'], ['directorBasis', 'Действует на основании'],
  ['phone', 'Телефон'], ['email', 'Email'], ['website', 'Сайт'], ['taxSystem', 'Система налогообложения']
];

const defaults = () => ({ links: Object.fromEntries(LINKS.map(l => [l.key, ''])), requisites: Object.fromEntries(REQ_FIELDS.map(([k]) => [k, ''])) });
function get(db) {
  const s = Object.assign(defaults(), P(getMeta(db, 'site') || 'null') || {});
  s.links = Object.assign(defaults().links, s.links || {});
  s.requisites = Object.assign(defaults().requisites, s.requisites || {});
  return s;
}
const httpOk = v => !v || /^https?:\/\/[^\s]+$/i.test(v);

// публичные данные для футера: видны всем, кто вошёл
def('siteLinks', null, (db) => LINKS.map(l => ({ key: l.key, label: l.label, url: get(db).links[l.key] || '' })).filter(l => l.url));

// строки реквизитов для страницы и копирования (видно всем вошедшим)
def('siteRequisites', null, (db, u) => ({ rows: requisitesRows(db), canEdit: u.role === 'owner' }));

// полные настройки — только учредителю
def('siteSettings', 'owner', (db) => {
  const s = get(db);
  return { links: LINKS.map(l => ({ key: l.key, label: l.label, url: s.links[l.key] || '' })), requisites: REQ_FIELDS.map(([k, label]) => ({ key: k, label, value: s.requisites[k] || '' })) };
});

def('saveSiteSettings', 'owner', (db, u, x) => {
  // Ссылки и реквизиты сохраняются независимо: незаполненные реквизиты
  // (например, нет полного наименования) не должны блокировать сохранение ссылок.
  const cur = get(db);
  const links = Object.assign({}, cur.links);
  const req = Object.assign({}, cur.requisites);
  const bad = [];
  if (x && x.links && typeof x.links === 'object') {
    for (const l of LINKS) {
      if (!(l.key in x.links)) continue;
      const v = str(x.links[l.key], 500).trim();
      if (!httpOk(v)) { bad.push(`«${l.label}»: ссылка должна начинаться с https://`); continue; }
      links[l.key] = v;
    }
  }
  if (x && x.requisites && typeof x.requisites === 'object') {
    for (const [k] of REQ_FIELDS) if (k in x.requisites) req[k] = str(x.requisites[k], 300).trim();
  }
  if (bad.length) throw new ApiError(bad.join('; ') + '. Остальные изменения не сохранены.');
  setMeta(db, 'site', J({ links, requisites: req }));
  audit(db, u, 'изменение', 'настройки сайта', 'site', J(cur), J({ links, requisites: req }));
  bump(db);
  return { ok: true, requisitesIncomplete: !req.fullName };
});

// страница реквизитов: печатная HTML-версия; PDF собирается на сервере
function requisitesRows(db) {
  const r = get(db).requisites;
  return REQ_FIELDS.filter(([k]) => r[k]).map(([k, label]) => [label, r[k]]);
}

module.exports = { LINKS, REQ_FIELDS, get, requisitesRows };
