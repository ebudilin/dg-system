#!/usr/bin/env bash
# Автообновление: раз в 2 минуты забирает новую версию из GitHub и перезапускает систему.
set -uo pipefail
APP=/opt/dg
cd "$APP" || exit 1
OLD=$(sudo -H -u dg git rev-parse HEAD)
sudo -H -u dg git fetch -q origin || { echo "Нет связи с GitHub"; exit 0; }
NEW=$(sudo -H -u dg git rev-parse '@{u}')
if [ "$OLD" != "$NEW" ]; then
  sudo -H -u dg git reset -q --hard "$NEW"
  echo "Обновление $OLD → $NEW"
  # install.sh переустанавливает systemd-юниты и перегенерирует nginx —
  # запускаем только когда менялись именно файлы инфраструктуры.
  # Остальные изменения в deploy/ (например, вспомогательные скрипты) требуют лишь перезапуска.
  if sudo -H -u dg git diff --name-only "$OLD" "$NEW" | grep -qE '^deploy/(dg\.service|dg-update\.(service|timer)|dg-backup\.(service|timer)|nginx\.conf|install\.sh)$'; then
    bash "$APP/deploy/install.sh"
  else
    systemctl restart dg.service
  fi
fi
# HTTPS: пробуем раз в час, пока сертификат не выпущен
if [ ! -d /etc/letsencrypt/live/${DOMAIN:-crm.fedset.ru} ] && [ "$(date +%M)" -lt 2 ]; then bash "$APP/deploy/https.sh"; fi
exit 0
