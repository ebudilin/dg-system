#!/usr/bin/env bash
# Выпускает сертификат HTTPS, как только домен указывает на этот сервер.
set -uo pipefail
DOMAIN="${DOMAIN:-crm.fedset.ru}"
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  # сертификат есть; убедимся, что nginx-конфиг его использует (после переустановки конфига)
  grep -q "ssl_certificate" /etc/nginx/sites-available/dg || certbot --nginx -d "$DOMAIN" --non-interactive --reinstall --redirect >/dev/null 2>&1 || true
  exit 0
fi
MYIP=$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
DNSIP=$(dig +short A "$DOMAIN" @1.1.1.1 | tail -n1)
if [ -z "$DNSIP" ] || [ "$DNSIP" != "$MYIP" ]; then
  echo "Домен $DOMAIN пока не указывает на этот сервер ($MYIP; в DNS: ${DNSIP:-нет записи}). HTTPS включится автоматически позже."
  exit 0
fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
  && echo "HTTPS включён: https://$DOMAIN"
