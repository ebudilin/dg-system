#!/usr/bin/env bash
# Ночная резервная копия базы. Хранится 30 дней в /var/backups/dg.
set -euo pipefail
DB=/var/lib/dg/dg.sqlite
DIR=/var/backups/dg
[ -f "$DB" ] || exit 0
F="$DIR/dg-$(date +%F).sqlite"
sqlite3 "$DB" ".backup '$F'"
gzip -f "$F"
chmod 640 "$F.gz"
find "$DIR" -name 'dg-*.sqlite.gz' -mtime +30 -delete
echo "Копия: $F.gz"
