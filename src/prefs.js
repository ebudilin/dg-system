'use strict';
// Личные настройки пользователя: сотрудник в Novofon, агент в финансах, уведомления в Max.
const { def, ApiError, audit, bump, str, J, P } = require('./api');

const NOTIFY = { tasks: 'Новые задачи мне', leads: 'Новые заявки мне', calls: 'Новые номера и пропущенные звонки', digest: 'Утренняя сводка в 9:00 (пн–пт)' };
const DEF_NOTIFY = { tasks: true, leads: true, calls: true, digest: true };

function get(db, id) {
  const r = db.prepare('SELECT prefs FROM users WHERE id=?').get(Number(id));
  const p = (r && P(r.prefs || '{}')) || {};
  p.notify = Object.assign({}, DEF_NOTIFY, p.notify || {});
  return p;
}
function set(db, id, patch) {
  const p = Object.assign(get(db, id), patch);
  db.prepare('UPDATE users SET prefs=? WHERE id=?').run(J(p), Number(id));
  return p;
}
function all(db) {
  return db.prepare('SELECT id, name, role, active, prefs FROM users').all().map(r => {
    const p = P(r.prefs || '{}') || {};
    p.notify = Object.assign({}, DEF_NOTIFY, p.notify || {});
    return { id: r.id, name: r.name, role: r.role, active: !!r.active, prefs: p };
  });
}
// номер телефона → 7XXXXXXXXXX
const normPhone = s => { let d = String(s || '').replace(/\D/g, ''); if (d.length === 10) d = '7' + d; if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1); return d.length === 11 ? d : ''; };
const fmt = d => d ? `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : '';
// виртуальный номер → пользователь CRM (у каждого сотрудника свои номера)
function vnumMap(db) {
  const m = {};
  all(db).forEach(u => { if (u.active) (u.prefs.vnums || []).forEach(n => { m[n] = u.id; }); });
  return m;
}
// номер для объявлений по объекту: первый виртуальный номер ответственного
function adPhone(db, userId) { const p = userId ? get(db, userId) : null; return p && (p.vnums || [])[0] ? fmt(p.vnums[0]) : ''; }
// сотрудник Novofon → пользователь CRM
function empMap(db) {
  const m = {};
  all(db).forEach(u => { if (u.active && u.prefs.novofonEmpId) m[String(u.prefs.novofonEmpId)] = u.id; });
  return m;
}

const pub = p => ({ photo: p.photo || 0, card: Object.assign({ position: '', phone: '', email: '', other: '' }, p.card || {}), maxLinked: !!p.maxUserId, maxName: p.maxName || '', notify: p.notify, novofonEmpId: p.novofonEmpId || '', novofonEmpName: p.novofonEmpName || '', novofonPhones: p.novofonPhones || '', vnums: (p.vnums || []).map(fmt), finAgentId: p.finAgentId || '' });

def('myProfile', null, (db, u) => pub(get(db, u.id)));
def('saveMyNotify', null, (db, u, n) => {
  const cur = get(db, u.id).notify;
  Object.keys(NOTIFY).forEach(k => { if (n && typeof n[k] === 'boolean') cur[k] = n[k]; });
  return pub(set(db, u.id, { notify: cur }));
});
// карточка сотрудника: имя, должность, контакты
def('saveMyCard', null, (db, u, x) => {
  x = x || {};
  const name = str(x.name, 100).trim();
  if (!name) throw new ApiError('Укажите имя.');
  if (name !== u.name) db.prepare('UPDATE users SET name=? WHERE id=?').run(name, u.id);
  const card = { position: str(x.position, 150).trim(), phone: str(x.phone, 100).trim(), email: str(x.email, 200).trim(), other: str(x.other, 500).trim() };
  const p = set(db, u.id, { card });
  audit(db, u, 'изменение своей карточки', 'пользователь', u.id, null, Object.assign({ name }, card));
  bump(db);
  return pub(p);
});
def('removeMyPhoto', null, (db, u) => {
  try { require('node:fs').unlinkSync(avatarPath(db, u.id)); } catch (_) {}
  bump(db);
  return pub(set(db, u.id, { photo: 0 }));
});
function avatarPath(db, id) { const path = require('node:path'); const dir = path.join(require('./files').dir(db), 'users'); require('node:fs').mkdirSync(dir, { recursive: true }); return path.join(dir, Number(id) + '.jpg'); }
function saveAvatar(db, u, body) {
  if (!body.length || body.length > 3e6) throw new ApiError('Фото должно быть до 3 МБ.');
  if (!(body[0] === 0xFF && body[1] === 0xD8)) throw new ApiError('Нужен файл JPG.');
  require('node:fs').writeFileSync(avatarPath(db, u.id), body);
  bump(db);
  return pub(set(db, u.id, { photo: Date.now() }));
}
def('maxUnlink', null, (db, u) => pub(set(db, u.id, { maxUserId: null, maxChatId: null, maxName: '' })));

def('listUserLinks', 'owner', (db) => all(db).map(x => Object.assign({ id: x.id, name: x.name, role: x.role, active: x.active }, pub(x.prefs))));
def('saveUserLinks', 'owner', (db, u, id, x) => {
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(Number(id))) throw new ApiError('Пользователь не найден.');
  x = x || {};
  const emp = str(x.novofonEmpId, 40);
  if (emp) { const other = all(db).find(o => o.id !== Number(id) && String(o.prefs.novofonEmpId || '') === emp); if (other) throw new ApiError(`Этот сотрудник Novofon уже привязан к пользователю «${other.name}».`); }
  const agent = str(x.finAgentId, 64);
  if (agent && !db.prepare('SELECT 1 FROM counterparties WHERE id=?').get(agent)) throw new ApiError('Агент не найден в контрагентах.');
  // Если виртуальные номера не переданы — сохраняем прежние, а не обнуляем.
  const prevV = (get(db, id).vnums || []);
  const rawV = x.vnums !== undefined ? x.vnums : prevV;
  const nums = [...new Set((Array.isArray(rawV) ? rawV : String(rawV || '').split(/[,;\n]/)).map(normPhone).filter(Boolean))].slice(0, 10);
  const vm = vnumMap(db);
  nums.forEach(n => { const o = vm[n]; if (o && o !== Number(id)) { const ou = all(db).find(z => z.id === o); throw new ApiError(`Номер ${fmt(n)} уже закреплён за «${ou ? ou.name : 'другим сотрудником'}».`); } });
  const p = set(db, id, { novofonEmpId: emp || null, novofonEmpName: str(x.novofonEmpName, 200), novofonPhones: str(x.novofonPhones, 300), vnums: nums, finAgentId: agent || null });
  // неразобранные звонки на номера сотрудника — ему
  if (nums.length) for (const r of db.prepare("SELECT id, data FROM calls WHERE status='new'").all()) {
    const d = P(r.data); if (d && nums.includes(normPhone(d.vnumber)) && d.userId !== Number(id)) { d.userId = Number(id); db.prepare('UPDATE calls SET data=? WHERE id=?').run(J(d), r.id); }
  }
  // неразобранные звонки этого сотрудника, пришедшие до привязки, — тоже ему
  if (p.novofonEmpId) for (const r of db.prepare("SELECT id, data FROM calls WHERE status='new'").all()) {
    const d = P(r.data); if (!d || d.userId) continue;
    if (d.ans === p.novofonEmpId || (!d.ans && (d.emps || []).length === 1 && d.emps[0] === p.novofonEmpId)) { d.userId = Number(id); db.prepare('UPDATE calls SET data=? WHERE id=?').run(J(d), r.id); }
  }
  audit(db, u, 'связи пользователя', 'пользователь', id, null, { novofonEmpId: p.novofonEmpId, vnums: p.vnums, finAgentId: p.finAgentId });
  bump(db);
  return pub(p);
});

module.exports = { get, set, all, empMap, vnumMap, adPhone, normPhone, NOTIFY, avatarPath, saveAvatar };
