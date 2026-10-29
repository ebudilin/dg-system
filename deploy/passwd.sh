#!/usr/bin/env bash
# Новый пароль пользователю: bash /opt/dg/deploy/passwd.sh ЛОГИН  (без логина — список пользователей)
set -e
set -a; . /etc/dg/env; set +a
exec sudo -u dg --preserve-env=DB_FILE,NODE_ENV node --disable-warning=ExperimentalWarning /opt/dg/scripts/reset-password.js "$@"
