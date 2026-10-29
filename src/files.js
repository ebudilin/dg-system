'use strict';
// Файлы объектов: фото, планировки, документы. Хранятся на сервере рядом с базой (папка files).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { def, can, ApiError, audit, bump, str, J, P } = require('./api');

const KINDS = { photo: 'Фото', plan: 'Планировка', doc: 'Документ', tpl: 'Шаблон' };
const DOC_TYPES = { contract: 'Договор с собственником', egrn: 'Выписка ЕГРН', title: 'Правоустанавливающие документы', id: 'Документы собственника', tech: 'Техпаспорт / план БТИ', other: 'Прочее' };
const MAX = { photo: 15e6, plan: 15e6, doc: 30e6, tpl: 30e6 };
const IMG = /^image\/(jpeg|png|webp)$/;

let DIR = null;
function dir(db) {
  if (!DIR) { DIR = process.env.FILES_DIR || path.join(path.dirname(db.file || '.'), 'files'); fs.mkdirSync(DIR, { recursive: true }); }
  return DIR;
}
const filePath = (db, f, thumb) => path.join(dir(db), f.object_id.replace(/[^\w-]/g, ''), f.id + (thumb ? '_t' : ''));
const rowOut = r => ({ id: r.id, objectId: r.object_id, kind: r.kind, docType: r.doc_type || '', name: r.name, mime: r.mime, size: r.size, key: r.pub_key, thumb: !!r.has_thumb, sort: r.sort, by: r.created_name, at: r.created_at });

function list(db, objectId) {
  return db.prepare('SELECT * FROM files WHERE object_id=? ORDER BY kind, sort, created_at').all(objectId).map(rowOut);
}

def('listFiles', null, (db, u, objectId) => list(db, str(objectId, 64)));

// приём файла: тело запроса — сами байты, параметры — в адресе
function upload(db, u, q, body) {
  const objectId = str(q.get('objectId'), 64);
  const isKb = objectId === 'kb';
  if (isKb ? !require('./kb').canEdit(db, u) : !can(u, 'crm_w')) throw new ApiError('Недостаточно прав.', 403);
  const o = isKb || db.prepare('SELECT data FROM objects WHERE id=?').get(objectId);
  if (!o) throw new ApiError('Объект не найден — сначала сохраните его.');
  if (isKb && q.get('kind') !== 'tpl') throw new ApiError('В справочник загружаются только шаблоны.');
  if (!isKb && q.get('kind') === 'tpl') throw new ApiError('Неверный тип файла.');
  const thumbFor = q.get('thumbFor');
  if (thumbFor) {
    const f = db.prepare('SELECT * FROM files WHERE id=? AND object_id=?').get(str(thumbFor, 64), objectId);
    if (!f) throw new ApiError('Файл не найден.');
    if (body.length > 2e6) throw new ApiError('Слишком большое превью.');
    fs.writeFileSync(filePath(db, f, true), body);
    db.prepare('UPDATE files SET has_thumb=1 WHERE id=?').run(f.id);
    return rowOut(db.prepare('SELECT * FROM files WHERE id=?').get(f.id));
  }
  const kind = KINDS[q.get('kind')] ? q.get('kind') : 'doc';
  const mime = str(q.get('mime') || 'application/octet-stream', 100).toLowerCase();
  if ((kind === 'photo' || kind === 'plan') && !IMG.test(mime)) throw new ApiError('Для фото и планировок нужны файлы JPG, PNG или WebP.');
  if (!body.length) throw new ApiError('Пустой файл.');
  if (body.length > MAX[kind]) throw new ApiError(`Файл больше ${Math.round(MAX[kind] / 1e6)} МБ.`);
  const id = 'f_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const name = str(q.get('name') || 'файл', 200).replace(/[\\/\0]/g, '_');
  const docType = kind === 'doc' && DOC_TYPES[q.get('docType')] ? q.get('docType') : '';
  const sort = (db.prepare('SELECT MAX(sort) m FROM files WHERE object_id=? AND kind=?').get(objectId, kind).m ?? -1) + 1;
  const rec = { id, object_id: objectId, kind, doc_type: docType, name, mime, size: body.length, pub_key: crypto.randomBytes(16).toString('hex'), sort, created_by: u.id, created_name: u.name, created_at: Date.now() };
  fs.mkdirSync(path.dirname(filePath(db, rec)), { recursive: true });
  fs.writeFileSync(filePath(db, rec), body);
  db.prepare('INSERT INTO files(id,object_id,kind,doc_type,name,mime,size,pub_key,has_thumb,sort,created_by,created_name,created_at) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)')
    .run(rec.id, rec.object_id, rec.kind, rec.doc_type, rec.name, rec.mime, rec.size, rec.pub_key, rec.sort, rec.created_by, rec.created_name, rec.created_at);
  audit(db, u, 'загрузка файла', 'объект', objectId, null, { id, kind, name, size: body.length });
  bump(db);
  return rowOut(db.prepare('SELECT * FROM files WHERE id=?').get(id));
}

def('deleteFile', 'crm_w', (db, u, id) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(str(id, 64));
  if (!f) return { ok: true };
  if (f.object_id === 'kb') throw new ApiError('Шаблон удаляется в справочнике.');
  if (f.created_by !== u.id && u.role !== 'owner') throw new ApiError('Удалить файл может тот, кто его загрузил, или учредитель.');
  db.prepare('DELETE FROM files WHERE id=?').run(f.id);
  for (const t of [false, true]) { try { fs.unlinkSync(filePath(db, f, t)); } catch (_) {} }
  audit(db, u, 'удаление файла', 'объект', f.object_id, { id: f.id, name: f.name, kind: f.kind }, null);
  bump(db);
  return list(db, f.object_id);
});

// новый порядок фото (первое — главное)
def('reorderFiles', 'crm_w', (db, u, objectId, ids) => {
  objectId = str(objectId, 64);
  const st = db.prepare('UPDATE files SET sort=? WHERE id=? AND object_id=?');
  (Array.isArray(ids) ? ids : []).forEach((id, i) => st.run(i, str(id, 64), objectId));
  bump(db);
  return list(db, objectId);
});

def('setFileDocType', 'crm_w', (db, u, id, docType) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(str(id, 64));
  if (!f) throw new ApiError('Файл не найден.');
  db.prepare('UPDATE files SET doc_type=? WHERE id=?').run(DOC_TYPES[docType] ? docType : '', f.id);
  bump(db);
  return list(db, f.object_id);
});

// отдать файл вошедшему пользователю
function serve(db, res, id, thumb, headers) {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(str(id, 64));
  if (!f) return false;
  const p = filePath(db, f, thumb && f.has_thumb);
  if (!fs.existsSync(p)) return false;
  const inline = IMG.test(f.mime) || f.mime === 'application/pdf';
  res.writeHead(200, Object.assign({}, headers, {
    'Content-Type': thumb && f.has_thumb ? 'image/jpeg' : f.mime,
    'Content-Length': fs.statSync(p).size,
    'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`
  }));
  fs.createReadStream(p).pipe(res);
  return true;
}

// открытая ссылка на фото — только для объектов, которые выгружаются на площадку
function servePublic(db, res, key) {
  const f = db.prepare('SELECT * FROM files WHERE pub_key=?').get(str(key, 64));
  if (!f || (f.kind !== 'photo' && f.kind !== 'plan')) return false;
  const o = P((db.prepare('SELECT data FROM objects WHERE id=?').get(f.object_id) || {}).data || 'null');
  if (!o || !o.cian || o.cian.state !== 'on') return false;
  const p = filePath(db, f);
  if (!fs.existsSync(p)) return false;
  res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': fs.statSync(p).size, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(p).pipe(res);
  return true;
}

function objectFiles(db, objectId) { return list(db, objectId); }
function counts(db) {
  const out = {};
  for (const r of db.prepare("SELECT object_id id, kind, COUNT(*) n FROM files WHERE object_id<>'kb' GROUP BY object_id, kind").all()) (out[r.id] = out[r.id] || {})[r.kind] = r.n;
  return out;
}

module.exports = { KINDS, DOC_TYPES, upload, serve, servePublic, objectFiles, counts, dir };
