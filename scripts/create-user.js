'use strict';
// Создать пользователя из командной строки сервера (нужно для первого учредителя).
// Запуск: sudo -u dg node /opt/dg/scripts/create-user.js
const readline = require('node:readline');
const path = require('node:path');
const { open } = require('../src/db');
const auth = require('../src/auth');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'dg.sqlite');

function ask(rl, q, hidden) {
  return new Promise(res => {
    if (!hidden) return rl.question(q, a => res(a.trim()));
    const out = rl.output; let muted = false;
    const orig = rl._writeToOutput;
    rl._writeToOutput = s => { if (!muted) orig.call(rl, s); };
    rl.question(q, a => { rl._writeToOutput = orig; out.write('\n'); res(a); });
    muted = true;
  });
}

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const db = open(DB_FILE);
  console.log('Новый пользователь системы «Дорогой Город»');
  const name = await ask(rl, 'Имя (например, Евгений Будилин): ');
  const login = (await ask(rl, 'Логин латиницей (например, evgeniy): ')).toLowerCase();
  const roles = Object.keys(auth.ROLES);
  const role = (await ask(rl, `Роль (${roles.join(' / ')}) [owner]: `)) || 'owner';
  if (!roles.includes(role)) { console.error('Неизвестная роль.'); process.exit(1); }
  if (!/^[a-z0-9._-]{3,64}$/.test(login)) { console.error('Логин: от 3 символов, латиница, цифры, точка, дефис.'); process.exit(1); }
  if (db.prepare('SELECT 1 FROM users WHERE login=?').get(login)) { console.error('Такой логин уже есть.'); process.exit(1); }
  const p1 = await ask(rl, 'Пароль (не отображается при вводе): ', true);
  const bad = auth.validatePassword(p1); if (bad) { console.error(bad); process.exit(1); }
  const p2 = await ask(rl, 'Пароль ещё раз: ', true);
  if (p1 !== p2) { console.error('Пароли не совпадают.'); process.exit(1); }
  db.prepare('INSERT INTO users(login,name,role,finance,pass_hash,active,must_change,created_at) VALUES(?,?,?,?,?,1,0,?)')
    .run(login, name || login, role, role === 'owner' ? 'edit' : 'none', auth.hashPassword(p1), Date.now());
  db.prepare('INSERT INTO audit(at,user_name,action,entity,entity_id) VALUES(?,?,?,?,?)').run(Date.now(), 'сервер', 'создание', 'пользователь', login);
  console.log(`Готово: ${name || login} (${login}), роль ${auth.ROLES[role]}.`);
  rl.close();
})();
