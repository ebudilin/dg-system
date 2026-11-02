'use strict';
// Веб-сервер системы «Дорогой Город». Без внешних зависимостей: Node.js 22+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./db');
const auth = require('./auth');
const { F, ApiError, can } = require('./api');
require('./crm');
const FILES = require('./files');
const CIAN = require('./cian');
const NOVOFON = require('./novofon');
require('./inquiries');
const KB = require('./kb');
require('./prefs');
const MAX = require('./max');
const COMMENTS = require('./comments');
require('./team');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'dg.sqlite');
const PUB = path.join(__dirname, '..', 'public');
const COOKIE = 'dg_s';

const db = open(DB_FILE);
setInterval(() => { try { auth.purgeSessions(db); } catch (_) {} }, 3600e3).unref();
setInterval(() => { try { COMMENTS.sweep(db); } catch (_) {} }, 6 * 3600e3).unref();
KB.seed(db);
NOVOFON.start(db);
MAX.start(db);

const pages = {};
function page(name) {
  if (!pages[name] || process.env.NODE_ENV !== 'production') pages[name] = fs.readFileSync(path.join(PUB, name));
  return pages[name];
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS, extra || {}));
  res.end(body);
}
const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);

function readBody(req, limit, raw) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new ApiError('Слишком большой запрос.', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const b = Buffer.concat(chunks); resolve(raw ? b : b.toString('utf8')); });
    req.on('error', reject);
  });
}

const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const clientIp = req => String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');

function sessionCookie(req, token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (isHttps(req) ? '; Secure' : '');
}

// Защита от подделки запросов: запись принимается только со своей страницы.
// Учитывает работу за реверс-прокси: порт, под которым систему видит клиент, может
// отличаться от порта приложения (например 81 -> 3001), поэтому за прокси сравниваем
// имя хоста, а порт сверяем только при прямом подключении.
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // старые браузеры и fetch с той же страницы без Origin
  let u;
  try { u = new URL(o); } catch (_) { return false; }
  const fwdHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const rawHost = String(fwdHost || req.headers.host || '').toLowerCase();
  if (!rawHost) return false;
  const hostName = rawHost.replace(/:\d+$/, '');
  if (u.hostname.toLowerCase() !== hostName) return false;
  const behindProxy = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  if (behindProxy) return true; // порт мог быть переписан прокси
  const originPort = u.port || (u.protocol === 'https:' ? '443' : '80');
  const hostPort = (rawHost.match(/:(\d+)$/) || [])[1] || originPort;
  return originPort === hostPort;
}

function currentUser(req) {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  const u = auth.userBySession(db, token);
  if (u) u.token = token;
  return u;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/health') return send(res, 200, 'ok');

  if (p === '/login' && req.method === 'GET') {
    if (currentUser(req)) return send(res, 302, '', null, { Location: '/' });
    return send(res, 200, page('login.html'), 'text/html; charset=utf-8');
  }

  if (p === '/auth/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'Запрос отклонён.' });
    const body = JSON.parse((await readBody(req, 10e3)) || '{}');
    const login = String(body.login || '').trim().toLowerCase(), ip = clientIp(req);
    if (auth.tooMany('ip:' + ip) || auth.tooMany('login:' + login)) return json(res, 429, { error: 'Слишком много попыток. Подождите 15 минут.' });
    const row = db.prepare('SELECT * FROM users WHERE login=?').get(login);
    if (!row || !row.active || !auth.checkPassword(body.password, row.pass_hash)) {
      auth.noteFail('ip:' + ip); auth.noteFail('login:' + login);
      return json(res, 401, { error: 'Неверный логин или пароль.' });
    }
    auth.clearFails('login:' + login);
    const s = auth.createSession(db, row.id, ip);
    db.prepare('INSERT INTO audit(at,user_id,user_name,action,entity) VALUES(?,?,?,?,?)').run(Date.now(), row.id, row.name, 'вход', ip);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, s.token, auth.SESSION_DAYS * 86400) });
  }

  if (p === '/auth/logout' && req.method === 'POST') {
    const token = auth.parseCookies(req.headers.cookie)[COOKIE];
    if (token) auth.dropSession(db, token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (p === '/' || p === '/index.html' || p === '/crm') {
    if (!currentUser(req)) return send(res, 302, '', null, { Location: '/login' });
    return send(res, 200, page('crm.html'), 'text/html; charset=utf-8');
  }

  if (p === '/pulse') {
    const u = currentUser(req);
    if (!u) return send(res, 302, '', null, { Location: '/login' });
    return send(res, 200, page('pulse.html'), 'text/html; charset=utf-8');
  }
  if (p === '/finance') {
    const u = currentUser(req);
    if (!u) return send(res, 302, '', null, { Location: '/login' });
    if (!can(u, 'fin_r')) return send(res, 302, '', null, { Location: '/' });
    return send(res, 200, page('finance.html'), 'text/html; charset=utf-8');
  }

  if (p === '/favicon.ico') return send(res, 204, '');

  // фид ЦИАН и открытые фото объявлений — без входа, по секретной ссылке
  let mm = p.match(/^\/feeds\/cian\/([0-9a-f]{32})\.xml$/);
  if (mm && req.method === 'GET') {
    if (mm[1] !== CIAN.settings(db).token) return send(res, 404, 'Не найдено');
    return send(res, 200, CIAN.feed(db), 'application/xml; charset=utf-8');
  }
  mm = p.match(/^\/pub\/([0-9a-f]{32})\.jpg$/);
  if (mm && req.method === 'GET') { if (!FILES.servePublic(db, res, mm[1])) send(res, 404, 'Не найдено'); return; }

  // файлы объектов — только для вошедших
  mm = p.match(/^\/files\/([\w-]+)(\/thumb)?$/);
  if (mm && req.method === 'GET') {
    if (!currentUser(req)) return send(res, 401, 'Войдите в систему');
    if (!FILES.serve(db, res, mm[1], !!mm[2], SEC_HEADERS)) send(res, 404, 'Файл не найден');
    return;
  }
  // фото сотрудников
  mm = p.match(/^\/avatar\/(\d+)\.jpg$/);
  if (mm && req.method === 'GET') {
    if (!currentUser(req)) return send(res, 401, 'Войдите в систему');
    const f = require('./prefs').avatarPath(db, mm[1]);
    if (!fs.existsSync(f)) return send(res, 404, 'Нет фото');
    res.writeHead(200, Object.assign({}, SEC_HEADERS, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'Content-Length': fs.statSync(f).size }));
    return fs.createReadStream(f).pipe(res);
  }
  if (p === '/avatar' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u) return json(res, 401, { error: 'Сессия закончилась. Войдите заново.' });
    if (!sameOrigin(req)) return json(res, 403, { error: 'Запрос отклонён.' });
    const body = await readBody(req, 3e6, true);
    return json(res, 200, { result: require('./prefs').saveAvatar(db, u, body) });
  }
  // вложения комментариев: доступны только вошедшим, права наследуются от обсуждения
  mm = p.match(/^\/cfiles\/([\w-]+)$/);
  if (mm && req.method === 'GET') {
    if (!currentUser(req)) return send(res, 401, 'Войдите в систему');
    if (!COMMENTS.serve(db, res, mm[1], SEC_HEADERS)) send(res, 404, 'Файл не найден');
    return;
  }
  if (p === '/cupload' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u) return json(res, 401, { error: 'Сессия закончилась. Войдите заново.' });
    if (!sameOrigin(req)) return json(res, 403, { error: 'Запрос отклонён.' });
    const body = await new Promise((resolve, reject) => { const ch = []; let n = 0;
      req.on('data', c => { n += c.length; if (n > 26e6) { reject(new ApiError('Файл больше 25 МБ.', 413)); req.destroy(); } else ch.push(c); });
      req.on('end', () => resolve(Buffer.concat(ch))); req.on('error', reject); });
    return json(res, 200, { result: COMMENTS.upload(db, u, url.searchParams, body) });
  }

  if (p === '/upload' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u) return json(res, 401, { error: 'Сессия закончилась. Войдите заново.' });
    if (!sameOrigin(req)) return json(res, 403, { error: 'Запрос отклонён.' });
    const body = await new Promise((resolve, reject) => { const ch = []; let n = 0;
      req.on('data', c => { n += c.length; if (n > 62e6) { reject(new ApiError('Файл больше 60 МБ.', 413)); req.destroy(); } else ch.push(c); });
      req.on('end', () => resolve(Buffer.concat(ch))); req.on('error', reject); });
    return json(res, 200, { result: FILES.upload(db, u, url.searchParams, body) });
  }

  const m = p.match(/^\/api\/([A-Za-z]+)$/);
  if (m && req.method === 'POST') {
    const u = currentUser(req);
    if (!u) return json(res, 401, { error: 'Сессия закончилась. Войдите заново.' });
    if (!sameOrigin(req)) return json(res, 403, { error: 'Запрос отклонён.' });
    const f = F[m[1]];
    if (!f) return json(res, 404, { error: 'Нет такой функции.' });
    if (!can(u, f.roles)) return json(res, 403, { error: 'Недостаточно прав для этого действия.' });
    const raw = await readBody(req, m[1] === 'importData' ? 50e6 : 2e6);
    let args = [];
    if (raw) { try { args = JSON.parse(raw); } catch (_) { throw new ApiError('Неверный формат запроса.'); } }
    if (!Array.isArray(args)) args = [args];
    const result = await f.fn(db, u, ...args);
    return json(res, 200, { result });
  }

  return send(res, 404, 'Не найдено');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    const status = e instanceof ApiError ? e.status : 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, req.url, e);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Ошибка на сервере. Попробуйте ещё раз.' : e.message });
  });
});
server.listen(PORT, HOST, () => console.log(`dg-system: http://${HOST}:${PORT}, база ${DB_FILE}`));
module.exports = server;
