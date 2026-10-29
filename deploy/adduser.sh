#!/usr/bin/env bash
# Создать пользователя из командной строки сервера: bash /opt/dg/deploy/adduser.sh
set -e
set -a; . /etc/dg/env; set +a
exec sudo -u dg --preserve-env=DB_FILE,NODE_ENV node --disable-warning=ExperimentalWarning /opt/dg/scripts/create-user.js
