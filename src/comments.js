'use strict';
// Обсуждения: комментарии к задачам, сделкам, материалам справочника и объектам.
// В комментарии можно упомянуть сотрудника (@) и приложить файлы.
// Упоминания создают уведомление внутри CRM и, если у сотрудника подключён Max, сообщение туда.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { def, can, ApiError, audit, bump, str, J, P } = require('./api');
const { getMeta } = require('./db');

// Какие сущности можно обсуждать.
const ENTITIES = {
  task: 'задача', deal: 'сделка', kb: 'материал справочника',
  object: 'объект', client: 'клиент', lead: 'заявка'
};
const MAX_FILE = 25e6;                       // один файл — не больше 25 МБ
const MAX_FILES = 8;                         // вложений в комментарии
const TEXT_MAX = 8000;

const now = () => Date.now();
const uid = p => p + '_' + now().toString(36) + Math.random().toString(36).slice(2, 8);

let DIR = null;
function dir(db) {
  if (!DIR) {
    DIR = process.env.FILES_DIR || path.join(path.dirname(db.file || '.'), 'files');
    DIR = path.join(DIR, 'comments');
    fs.mkdirSync(DIR, { recursive: true });
  }
  return DIR;
}
const filePath = (db, id) => path.join(dir(db), String(id).replace(/[^\w-]/g, ''));

/* ---------- доступ ---------- */
// Читать обсуждение может любой вошедший сотрудник; писать — те, кто правит CRM,
// а в справочнике — те, кому разрешено редактирование (как и сами материалы).
function readOk(db, u, entity) { return !!u && !!ENTITIES[entity]; }
function writeOk(db, u, entity) {
  if (!u || !ENTITIES[entity]) return false;
  if (entity === 'kb') return require('./kb').canEdit(db, u);
  return can(u, 'crm_w');
}
function entityTitle(db, entity, id) {
  try {
    if (entity === 'task') { const r = db.prepare('SELECT data FROM tasks WHERE id=?').get(id); const x = P(r && r.data); return x ? x.title : ''; }
    if (entity === 'deal') { const r = db.prepare('SELECT data FROM deals WHERE id=?').get(id); const x = P(r && r.data); return x ? (x.client || '') + (x.object ? ' · ' + x.object : '') : ''; }
    if (entity === 'client') { const r = db.prepare('SELECT data FROM counterparties WHERE id=?').get(id); const x = P(r && r.data); return x ? x.name : ''; }
    if (entity === 'object') { const r = db.prepare('SELECT data FROM objects WHERE id=?').get(id); const x = P(r && r.data); return x ? (x.title || x.address || '') : ''; }
    if (entity === 'lead') { const r = db.prepare('SELECT data FROM leads WHERE id=?').get(id); const x = P(r && r.data); return x ? x.title : ''; }
    if (entity === 'kb') { const r = db.prepare('SELECT data FROM kb WHERE id=?').get(id); const x = P(r && r.data); return x ? (x.title || x.name || '') : ''; }
  } catch (_) { }
  return '';
}

/* ---------- чтение ---------- */
const usersIndex = db => {
  const m = {};
  for (const r of db.prepare('SELECT id, name, active FROM users').all()) m[r.id] = { id: r.id, name: r.name, active: !!r.active };
  return m;
};

function list(db, u, entity, entityId) {
  entity = str(entity, 32); entityId = str(entityId, 64);
  if (!readOk(db, u, entity)) throw new ApiError('Нет доступа к обсуждению.', 403);
  const people = usersIndex(db);
  const rows = db.prepare('SELECT * FROM comments WHERE entity=? AND entity_id=? ORDER BY at').all(entity, entityId);
  return {
    entity, entityId, title: entityTitle(db, entity, entityId),
    canWrite: writeOk(db, u, entity),
    me: { id: u.id, name: u.name },
    items: rows.map(r => rowOut(r, people)),
    people: Object.values(people).filter(p => p.active).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  };
}
function rowOut(r, people) {
  let mentions = [], files = [];
  try { mentions = JSON.parse(r.mentions || '[]'); } catch (_) { }
  try { files = JSON.parse(r.files || '[]'); } catch (_) { }
  return {
    id: r.id, at: r.at, userId: r.user_id, userName: r.user_name || (people[r.user_id] || {}).name || '',
    text: r.text, mentions: mentions.map(m => ({ id: m.id, name: (people[m.id] || {}).name || m.name || '' })),
    files, editedAt: r.edited_at || null
  };
}

def('listComments', null, (db, u, entity, entityId) => list(db, u, entity, entityId));

/* ---------- запись ---------- */
function normMentions(db, list) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 30)) {
    const id = Number(raw && raw.id != null ? raw.id : raw);
    if (!id || out.some(x => x.id === id)) continue;
    const r = db.prepare('SELECT id, name, active FROM users WHERE id=?').get(id);
    if (r && r.active) out.push({ id: r.id, name: r.name });
  }
  return out;
}
function takeFiles(db, u, ids) {
  const out = [];
  for (const raw of (Array.isArray(ids) ? ids : []).slice(0, MAX_FILES)) {
    const id = str(raw && raw.id != null ? raw.id : raw, 64);
    if (!id) continue;
    const f = db.prepare('SELECT * FROM comment_files WHERE id=? AND user_id=? AND comment_id IS NULL').get(id, u.id);
    if (f) out.push({ id: f.id, name: f.name, mime: f.mime, size: f.size });
  }
  return out;
}

def('addComment', null, (db, u, x) => {
  const entity = str(x && x.entity, 32), entityId = str(x && x.entityId, 64);
  if (!readOk(db, u, entity)) throw new ApiError('Неизвестный раздел обсуждения.');
  if (!writeOk(db, u, entity)) throw new ApiError('Недостаточно прав, чтобы комментировать.', 403);
  const text = str(x && x.text, TEXT_MAX).trim();
  const files = takeFiles(db, u, x && x.files);
  const mentions = normMentions(db, x && x.mentions);
  if (!text && !files.length) throw new ApiError('Напишите комментарий или приложите файл.');
  const id = uid('cmt');
  const at = now();
  db.prepare('INSERT INTO comments(id,entity,entity_id,user_id,user_name,at,text,mentions,files,edited_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)')
    .run(id, entity, entityId, u.id, u.name, at, text, J(mentions), J(files));
  for (const f of files) db.prepare('UPDATE comment_files SET comment_id=? WHERE id=?').run(id, f.id);
  audit(db, u, 'комментарий', ENTITIES[entity], entityId, null, { id, text: text.slice(0, 200), files: files.length, mentions: mentions.map(m => m.name) });
  bump(db);
  try { notify(db, u, { id, entity, entityId, at, text, mentions, files }); } catch (_) { /* сбой уведомлений не отменяет сохранённый комментарий */ }
  return list(db, u, entity, entityId);
});

def('deleteComment', null, (db, u, id) => {
  id = str(id, 64);
  const r = db.prepare('SELECT * FROM comments WHERE id=?').get(id);
  if (!r) throw new ApiError('Комментарий не найден.');
  const owner = u.role === 'owner';
  if (r.user_id !== u.id && !owner) throw new ApiError('Удалять чужие комментарии может только учредитель.', 403);
  db.prepare('DELETE FROM comments WHERE id=?').run(id);
  audit(db, u, 'удаление комментария', ENTITIES[r.entity] || r.entity, r.entity_id, { text: r.text }, null);
  bump(db);
  return list(db, u, r.entity, r.entity_id);
});

/* ---------- уведомления об упоминаниях ---------- */
function notify(db, author, c) {
  const at = Number(c.at) || now();
  const link = { text: 'Открыть в CRM', url: maxLink(db, c.entity, c.entityId) };
  for (const m of c.mentions) {
    db.prepare('INSERT INTO notifications(user_id,at,kind,entity,entity_id,comment_id,text,read) VALUES(?,?,?,?,?,?,?,0)')
      .run(Number(m.id), at, 'mention', c.entity, c.entityId, c.id, str(c.text, 500));
    if (m.id === author.id) continue;
    // Сообщение в Max — только если сотрудник привязал мессенджер.
    try {
      const prefs = require('./prefs').get(db, m.id) || {};
      if (prefs.maxUserId) {
        const what = ENTITIES[c.entity] || 'запись';
        const title = entityTitle(db, c.entity, c.entityId);
        const body = (c.text || '').trim() || (c.files.length ? 'Приложен файл' : '');
        require('./max').send(db, prefs.maxUserId,
          `**${author.name}** упомянул вас в ${what}${title ? ': ' + title : ''}\n\n${body}`.slice(0, 3900), link);
      }
    } catch (_) { /* уведомление в CRM уже создано — сбой мессенджера не должен ломать сохранение */ }
  }
}
function maxLink(db, entity, id) {
  const base = 'https://crm.fedset.ru';
  if (entity === 'task') return base + '/#tasks';
  if (entity === 'deal') return base + '/#deals';
  if (entity === 'kb') return base + '/#kb';
  if (entity === 'object') return base + '/#objects';
  if (entity === 'client') return base + '/#clients';
  if (entity === 'lead') return base + '/#leads';
  return base + '/';
}

def('notifications', null, (db, u) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY at DESC LIMIT 60').all(u.id);
  return {
    unread: rows.filter(r => !r.read).length,
    items: rows.map(r => {
      const c = db.prepare('SELECT user_name FROM comments WHERE id=?').get(r.comment_id);
      return {
        id: r.id, at: r.at, kind: r.kind, entity: r.entity, entityId: r.entity_id, commentId: r.comment_id,
        text: r.text, read: !!r.read, by: (c && c.user_name) || '',
        title: entityTitle(db, r.entity, r.entity_id)
      };
    })
  };
});
def('readNotifications', null, (db, u, ids) => {
  const list = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : [];
  if (list.length) {
    const q = db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?');
    for (const id of list) q.run(id, u.id);
  } else db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(u.id);
  return true;
});

/* ---------- вложения ---------- */
// Файл загружается до сохранения комментария и привязывается к нему при сохранении.
const SAFE_MIME = /^(image\/(jpeg|png|webp|gif)|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.(wordprocessingml|spreadsheetml|presentationml)\.document|vnd\.ms-excel|vnd\.ms-powerpoint|zip|octet-stream)|text\/(plain|csv)|application\/rtf)$/i;

function upload(db, u, q, body) {
  if (!can(u, 'crm_w') && !require('./kb').canEdit(db, u)) throw new ApiError('Недостаточно прав.', 403);
  if (!body || !body.length) throw new ApiError('Пустой файл.');
  if (body.length > MAX_FILE) throw new ApiError('Файл больше 25 МБ.', 413);
  const name = str(q.get('name') || 'файл', 200).replace(/[\r\n\t]/g, ' ').trim() || 'файл';
  const mime = str(q.get('mime') || 'application/octet-stream', 120).toLowerCase();
  if (!SAFE_MIME.test(mime)) throw new ApiError('Такой тип файла приложить нельзя.');
  const id = uid('cf');
  fs.writeFileSync(filePath(db, id), body);
  db.prepare('INSERT INTO comment_files(id,name,mime,size,user_id,at,comment_id) VALUES(?,?,?,?,?,?,NULL)')
    .run(id, name, mime, body.length, u.id, now());
  return { id, name, mime, size: body.length };
}

function serve(db, res, id, headers) {
  const f = db.prepare('SELECT * FROM comment_files WHERE id=?').get(str(id, 64));
  if (!f) return false;
  const p = filePath(db, f.id);
  if (!fs.existsSync(p)) return false;
  // Вложение из комментария доступно тем, кто видит само обсуждение; «черновик» — только автору.
  if (f.comment_id) {
    const c = db.prepare('SELECT entity FROM comments WHERE id=?').get(f.comment_id);
    if (!c || !ENTITIES[c.entity]) return false;
  }
  const inline = /^image\//i.test(f.mime) || /^application\/pdf$/i.test(f.mime);
  res.writeHead(200, Object.assign({}, headers, {
    'Content-Type': f.mime, 'Content-Length': fs.statSync(p).size,
    'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`
  }));
  fs.createReadStream(p).pipe(res);
  return true;
}

// Уборка «черновиков»: файлы, загруженные больше суток назад и не прикреплённые к комментарию.
function sweep(db) {
  const cut = now() - 86400e3;
  for (const f of db.prepare('SELECT id FROM comment_files WHERE comment_id IS NULL AND at<?').all(cut)) {
    try { fs.unlinkSync(filePath(db, f.id)); } catch (_) { }
    db.prepare('DELETE FROM comment_files WHERE id=?').run(f.id);
  }
}

/* ---------- общий поиск по CRM ---------- */
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
const digits = s => String(s || '').replace(/\D/g, '');
const phoneHit = (query, ...vals) => {
  const qd = digits(query);
  if (qd.length < 4) return false;
  const tail = qd.slice(-7);
  return vals.some(v => { const d = digits(v); return d && (d.includes(qd) || d.slice(-10) === qd.slice(-10) || (tail.length === 7 && d.includes(tail))); });
};
const cut = (s, q, len = 140) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const i = norm(t).indexOf(norm(q));
  if (i < 0) return t.slice(0, len) + (t.length > len ? '…' : '');
  const a = Math.max(0, i - 50), b = Math.min(t.length, i + Math.max(40, q.length + 60));
  return (a ? '…' : '') + t.slice(a, b) + (b < t.length ? '…' : '');
};
const good = (q, ...vals) => vals.some(v => norm(v).includes(norm(q)));

def('search', null, (db, u, query) => {
  const q = str(query, 120).trim();
  if (q.length < 2) return { query: q, total: 0, groups: [] };
  const fin = can(u, 'fin_r');
  const P_ = s => { try { return JSON.parse(s); } catch (_) { return null; } };
  const groups = [];
  const add = (key, title, items) => { if (items.length) groups.push({ key, title, items }); };

  // Клиенты и контрагенты
  { const items = [];
    for (const r of db.prepare('SELECT data FROM counterparties').all()) {
      const c = P_(r.data); if (!c) continue;
      const types = (c.types || []).join(' ');
      if (good(q, c.name, c.phone, c.email, c.other, c.note, types) || phoneHit(q, c.phone, c.other)) {
        items.push({ type: 'client', id: c.id, title: c.name || 'Контрагент', sub: [c.phone, c.email, types].filter(Boolean).join(' · ').slice(0, 160), hit: cut([c.note, c.other].filter(Boolean).join(' '), q) });
      }
    }
    add('clients', 'Клиенты и контрагенты', items.sort((a, b) => a.title.localeCompare(b.title, 'ru')).slice(0, 12)); }

  // Заявки
  { const items = [];
    for (const r of db.prepare('SELECT data, stage FROM leads').all()) {
      const l = P_(r.data); if (!l) continue;
      if (good(q, l.title, l.source, l.note, l.lostReason) || phoneHit(q, l.phone)) {
        items.push({ type: 'lead', id: l.id, title: l.title || 'Заявка', sub: [(db.prepare('SELECT data FROM counterparties WHERE id=?').get(l.clientId) ? (P_(db.prepare('SELECT data FROM counterparties WHERE id=?').get(l.clientId).data) || {}).name : ''), l.source, l.stage].filter(Boolean).join(' · '), hit: cut([l.note, l.lostReason].filter(Boolean).join(' '), q) });
      }
    }
    add('leads', 'Заявки', items.slice(0, 12)); }

  // Сделки (финансовые поля — только при доступе к финансам)
  { const items = [];
    for (const r of db.prepare('SELECT data FROM deals').all()) {
      const d = P_(r.data); if (!d) continue;
      if (good(q, d.client, d.object, d.kind, d.note)) {
        const sub = [d.kind, d.status === 'work' ? 'в работе' : d.status === 'deal' ? 'договор' : d.status === 'closed' ? 'закрыта' : d.status === 'lost' ? 'сорвалась' : d.status, fin && d.commission ? 'комиссия ' + Number(d.commission).toLocaleString('ru-RU') + ' ₽' : ''].filter(Boolean).join(' · ');
        items.push({ type: 'deal', id: d.id, title: (d.client || 'Сделка') + (d.object ? ' · ' + d.object : ''), sub, hit: cut(d.note, q) });
      }
    }
    add('deals', 'Сделки', items.slice(0, 12)); }

  // Объекты
  { const items = [];
    for (const r of db.prepare('SELECT data FROM objects').all()) {
      const o = P_(r.data); if (!o) continue;
      if (good(q, o.title, o.address, o.metro, o.developer, o.cadastral, o.description) || phoneHit(q, o.phone)) {
        items.push({ type: 'object', id: o.id, title: o.title || o.address || 'Объект', sub: [o.address, o.metro, o.developer].filter(Boolean).join(' · ').slice(0, 160), hit: cut(o.description, q) });
      }
    }
    add('objects', 'Объекты', items.slice(0, 12)); }

  // Задачи
  { const items = [];
    for (const r of db.prepare('SELECT data FROM tasks').all()) {
      const t = P_(r.data); if (!t) continue;
      if (good(q, t.title, t.note, t.time)) {
        items.push({ type: 'task', id: t.id, title: t.title || 'Задача', sub: [t.done ? 'выполнена' : 'в работе', t.due || ''].filter(Boolean).join(' · '), hit: cut(t.note, q) });
      }
    }
    add('tasks', 'Задачи', items.slice(0, 12)); }

  // Звонки — по номеру, сотруднику и расшифровке
  { const items = [];
    for (const r of db.prepare('SELECT data, status, client_id, at FROM calls ORDER BY at DESC LIMIT 4000').all()) {
      const c = P_(r.data); if (!c) continue;
      if (phoneHit(q, c.phone, c.vnumber) || good(q, c.emp, c.comment)) {
        items.push({ type: 'call', id: c.id, title: c.phone || 'Звонок', sub: [new Date(c.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }), c.dir === 'in' ? 'входящий' : 'исходящий', c.status === 'new' ? 'не разобран' : c.status === 'spam' ? 'спам' : c.status === 'lead' ? 'заявка' : ''].filter(Boolean).join(' · '), hit: cut(c.comment, q), q: c.phone || '' });
      }
      if (items.length >= 12) break;
    }
    add('calls', 'Звонки', items); }

  // Обращения по объектам
  { const items = [];
    for (const r of db.prepare('SELECT data FROM inquiries ORDER BY at DESC LIMIT 2000').all()) {
      const i = P_(r.data); if (!i) continue;
      if (good(q, i.name, i.phone, i.channel, i.result, i.note, i.agency) || phoneHit(q, i.phone)) {
        const o = db.prepare('SELECT data FROM objects WHERE id=?').get(i.objectId); const oo = o ? P_(o.data) : null;
        items.push({ type: 'inquiry', id: i.id, title: (i.name || 'Обращение') + (oo ? ' · ' + (oo.title || oo.address || '') : ''), sub: [i.phone, i.channel].filter(Boolean).join(' · '), hit: cut([i.result, i.note].filter(Boolean).join(' '), q) });
      }
      if (items.length >= 12) break;
    }
    add('inquiries', 'Обращения', items); }

  // Справочник (wiki): инструкции, цены, шаблоны
  { const items = [];
    for (const r of db.prepare('SELECT data FROM kb').all()) {
      const k = P_(r.data); if (!k) continue;
      if (good(q, k.title, k.name, k.body, k.cat, k.group, k.note, k.price)) {
        const kind = k.kind === 'article' ? 'инструкция' : k.kind === 'price' ? 'услуга' : 'шаблон';
        items.push({ type: 'kb', id: k.id, title: k.title || k.name || 'Материал', sub: [kind, k.cat || k.group].filter(Boolean).join(' · '), hit: cut(k.body || k.note || k.price, q, 180) });
      }
    }
    add('kb', 'Справочник и инструкции', items.slice(0, 15)); }

  // Комментарии сотрудников
  { const items = [];
    for (const r of db.prepare('SELECT * FROM comments ORDER BY at DESC LIMIT 3000').all()) {
      if (!good(q, r.text)) continue;
      const title = entityTitle(db, r.entity, r.entity_id) || (ENTITIES[r.entity] || 'запись');
      items.push({ type: 'comment', id: r.id, title, sub: [r.user_name, ENTITIES[r.entity] || r.entity].filter(Boolean).join(' · '), hit: cut(r.text, q, 180), entity: r.entity, entityId: r.entity_id });
      if (items.length >= 10) break;
    }
    add('comments', 'Комментарии сотрудников', items); }

  return { query: q, total: groups.reduce((s, g) => s + g.items.length, 0), groups };
});

module.exports = { list, serve, upload, sweep, ENTITIES };
