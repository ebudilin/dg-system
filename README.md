# Дорогой Город — система учёта

Управленческий учёт агентства: операции, сделки (до 3 агентов), контрагенты, ДДС, ОПиУ, план-факт, архив закрытых периодов. Вход по логину и паролю, роли, журнал изменений.

## Устройство

- Node.js 22+, **без внешних зависимостей** (`npm install` не нужен).
- База — один файл SQLite: `/var/lib/dg/dg.sqlite`.
- Веб-сервер nginx → приложение на `127.0.0.1:3000`. HTTPS — Let's Encrypt (certbot), выпускается автоматически, когда домен указывает на сервер.
- Автообновление: каждые 2 минуты сервер забирает новую версию из этого репозитория и перезапускается (`dg-update.timer`).
- Резервная копия базы — каждую ночь в 03:30, хранится 30 дней: `/var/backups/dg/`.

## Роли

| Роль | Что может |
|---|---|
| Учредитель (`owner`) | всё: настройки, пользователи, журнал, закрытие периода, импорт и выгрузка |
| Бухгалтер (`accountant`) | операции, сделки, контрагенты, планы, архив |
| Просмотр (`viewer`) | только смотреть |

## Первая установка (один раз, от root)

```bash
mkdir -p /opt/dg && chown dg:dg /opt/dg
sudo -H -u dg git clone git@github.com:ebudilin/dg-system.git /opt/dg
bash /opt/dg/deploy/install.sh
bash /opt/dg/deploy/adduser.sh     # создать первого учредителя
```

## Полезные команды

```bash
systemctl status dg                 # работает ли система
journalctl -u dg -n 100             # журнал приложения
journalctl -u dg-update -n 20       # журнал автообновления
bash /opt/dg/deploy/backup.sh       # сделать резервную копию сейчас
bash /opt/dg/deploy/adduser.sh      # добавить пользователя из консоли
```

## Восстановление из копии

```bash
systemctl stop dg
gunzip -c /var/backups/dg/dg-ГГГГ-ММ-ДД.sqlite.gz > /var/lib/dg/dg.sqlite
rm -f /var/lib/dg/dg.sqlite-wal /var/lib/dg/dg.sqlite-shm
chown dg:dg /var/lib/dg/dg.sqlite
systemctl start dg
```
