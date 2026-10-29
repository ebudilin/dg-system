#!/usr/bin/env bash
# Ночная резервная копия: база (30 дней) и зеркало папки с файлами объектов.
set -euo pipefail
DB=/var/lib/dg/dg.sqlite
DIR=/var/backups/dg
[ -f "$DB" ] || exit 0
F="$DIR/dg-$(date +%F).sqlite"
sqlite3 "$DB" ".backup '$F'"
gzip -f "$F"
chmod 640 "$F.gz"
find "$DIR" -name 'dg-*.sqlite.gz' -mtime +30 -delete
if [ -d /var/lib/dg/files ]; then
  mkdir -p "$DIR/files"
  if command -v rsync >/dev/null; then rsync -a --delete /var/lib/dg/files/ "$DIR/files/"; else cp -a -u /var/lib/dg/files/. "$DIR/files/"; fi
fi
echo "Копия: $F.gz"
