#!/usr/bin/env bash
# Установка и обновление настроек сервера. Запускать от root: bash /opt/dg/deploy/install.sh
# Скрипт можно запускать повторно — он ничего не ломает и не трогает данные.
set -euo pipefail
APP=/opt/dg
DATA=/var/lib/dg
DOMAIN="${DOMAIN:-crm.fedset.ru}"

[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== Пакеты"
command -v sqlite3 >/dev/null || apt-get install -y sqlite3 dnsutils >/dev/null
command -v rsync >/dev/null || apt-get install -y rsync >/dev/null
command -v dig >/dev/null || apt-get install -y dnsutils >/dev/null
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then echo "Нужен Node.js 22+"; exit 1; fi

echo "== Папки и настройки"
mkdir -p "$DATA" /var/backups/dg /etc/dg
chown dg:dg "$DATA"; chmod 750 "$DATA"
chown root:dg /var/backups/dg; chmod 750 /var/backups/dg
touch /etc/dg/env
grep -q '^DB_FILE=' /etc/dg/env || echo "DB_FILE=$DATA/dg.sqlite" >> /etc/dg/env
grep -q '^NODE_ENV=' /etc/dg/env || echo "NODE_ENV=production" >> /etc/dg/env
grep -q '^PORT=' /etc/dg/env || echo "PORT=3000" >> /etc/dg/env
chown root:dg /etc/dg/env; chmod 640 /etc/dg/env

# PostgreSQL системе не нужен (база — файл SQLite) — освобождаем память
if systemctl is-enabled postgresql >/dev/null 2>&1; then systemctl disable --now postgresql >/dev/null 2>&1 || true; fi

echo "== Сертификат Минцифры (нужен для мессенджера Max)"
if [ ! -s /etc/dg/ru_ca.pem ]; then
  T=$(mktemp -d)
  if curl -fsS --max-time 25 https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt -o "$T/root.crt" && \
     curl -fsS --max-time 25 https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt -o "$T/sub.crt" && \
     grep -q "BEGIN CERTIFICATE" "$T/root.crt"; then
    cat "$T/root.crt" "$T/sub.crt" > /etc/dg/ru_ca.pem; chmod 644 /etc/dg/ru_ca.pem; echo "   установлен"
  else
    echo "!! Не удалось скачать сертификат Минцифры — Max может не подключиться (повторите install.sh позже)"
  fi
  rm -rf "$T"
fi

echo "== Службы"
install -m 644 "$APP/deploy/dg.service" /etc/systemd/system/dg.service
install -m 644 "$APP/deploy/dg-update.service" /etc/systemd/system/dg-update.service
install -m 644 "$APP/deploy/dg-update.timer" /etc/systemd/system/dg-update.timer
install -m 644 "$APP/deploy/dg-backup.service" /etc/systemd/system/dg-backup.service
install -m 644 "$APP/deploy/dg-backup.timer" /etc/systemd/system/dg-backup.timer
systemctl daemon-reload
systemctl enable --now dg.service dg-update.timer dg-backup.timer >/dev/null
systemctl restart dg.service

echo "== Веб-сервер"
sed "s/__DOMAIN__/$DOMAIN/g" "$APP/deploy/nginx.conf" > /etc/nginx/sites-available/dg
ln -sf /etc/nginx/sites-available/dg /etc/nginx/sites-enabled/dg
rm -f /etc/nginx/sites-enabled/default
# если сертификат уже выпущен — certbot сам допишет HTTPS при следующем запуске
nginx -t >/dev/null && systemctl reload nginx

echo "== HTTPS"
bash "$APP/deploy/https.sh" || true

sleep 1
if curl -fsS http://127.0.0.1:3000/health >/dev/null; then echo "== Система работает"; else echo "!! Система не отвечает: journalctl -u dg -n 50"; fi
