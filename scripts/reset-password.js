'use strict';
// Задать новый пароль пользователю из командной строки сервера.
// Запуск: bash /opt/dg/deploy/passwd.sh ЛОГИН
const readline = require('node:readline');
const path = require('node:path');
const { open } = require('../src/db');
const auth = require('../src/auth');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'dg.sqlite');
const login = String(process.argv[2] || '').trim().toLowerCase();
const db = open(DB_FILE);
if (!login) {
  console.log('Пользователи:');
  db.prepare('SELECT login, name, role, active FROM users ORDER BY name').all()
    .forEach(u => console.log(`  ${u.login}  —  ${u.name}, ${auth.ROLES[u.role] || u.role}${u.active ? '' : ' (отключён)'}`));
  console.log('Запуск: bash /opt/dg/deploy/passwd.sh ЛОГИН');
  process.exit(0);
}
const u = db.prepare('SELECT id, name FROM users WHERE login=?').get(login);
if (!u) { console.error('Нет пользователя с логином ' + login); process.exit(1); }
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const orig = rl._writeToOutput; let mute = false;
rl._writeToOutput = s => { if (!mute) orig.call(rl, s); };
rl.question(`Новый пароль для ${u.name} (не отображается): `, p => {
  rl._writeToOutput = orig; console.log();
  const bad = auth.validatePassword(p); if (bad) { console.error(bad); process.exit(1); }
  db.prepare('UPDATE users SET pass_hash=?, must_change=0, active=1 WHERE id=?').run(auth.hashPassword(p), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  db.prepare('INSERT INTO audit(at,user_name,action,entity,entity_id) VALUES(?,?,?,?,?)').run(Date.now(), 'сервер', 'сброс пароля', 'пользователь', login);
  console.log('Пароль изменён. Если были неудачные попытки входа — выполните: systemctl restart dg');
  process.exit(0);
});
mute = true;
