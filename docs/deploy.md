# Развёртывание ГЕОПУЛЬС на сервере

Прод: **https://201.34.158.13.sslip.io** — VPS `201.34.158.13` (нода `kvmnvm-1209`), Ubuntu 26.04,
2 vCPU, 3.9 ГБ RAM, 45 ГБ диска. Сертификат Let's Encrypt выпускает Caddy автоматически.

Кратко о контуре: наружу смотрит только Caddy (80/443), БД, API и фронтенд публикуются на
`127.0.0.1`; секреты живут в `/opt/geopuls/.env` (права `600`) и в git не попадают.

## Что где лежит

| Путь | Что это |
|---|---|
| `/opt/geopuls` | код коммита (развёрнут из `git archive`, git-истории на сервере нет) |
| `/opt/geopuls/.env` | конфигурация: домен, пароль БД, число воркеров, выгрузка для cron |
| `/opt/geopuls/backups` | дампы БД (`geopuls-<дата>.dump`), храним 14 дней |
| `/var/log/geopuls` | логи cron-задач и `monitor.json` (машиночитаемая история проверок) |
| `/etc/cron.d/geopuls` | расписание: бэкап, проверка копии, мониторинг, обновление данных |
| `/opt/geopuls/data` | выгрузки OSM для обновления данных (`data/raw/*.osm.pbf`) |

Скрипты эксплуатации — `infra/ops/`: `install-docker.sh`, `install-swap.sh`, `bootstrap.sh`, `deploy.sh`,
`update.sh`, `backup.sh`, `verify-backup.sh`, `monitor.sh`, `refresh-data.sh`, `watch-refresh-memory.sh`,
`cron.geopuls`.

## Первый деплой (с нуля)

```bash
# 1. Docker и compose, swap (один раз)
bash infra/ops/install-docker.sh
bash infra/ops/install-swap.sh          # 2 ГБ: импорт выгрузки пиково ест память, swap на VPS нет

# 2. Локально: архив коммита и прод-конфигурация
git archive --format=tar.gz -o geopuls-src.tar.gz HEAD
# .env готовится по образцу .env.example (обязательно: DOMAIN, POSTGRES_PASSWORD,
# пустой NEXT_PUBLIC_API_BASE_URL, GEOPULS_WORKERS)

# 3. Скопировать на сервер: архив, .env и, при желании, дамп данных
scp geopuls-src.tar.gz prod.env root@<IP>:/tmp/

# 4. Подготовка каталога и запуск
mkdir -p /opt/geopuls/backups
install -m 600 /tmp/prod.env /opt/geopuls/.env && sed -i 's/\r$//' /opt/geopuls/.env
tar -xzf /tmp/geopuls-src.tar.gz -C /opt/geopuls
cd /opt/geopuls
ARCHIVE=/tmp/geopuls-src.tar.gz DUMP=/tmp/geopuls-init.dump bash infra/ops/bootstrap.sh
```

`bootstrap.sh` собирает образы, поднимает прод-профиль (`docker compose --profile prod up -d`),
ждёт healthcheck'и, восстанавливает данные из дампа (если передан) и ставит cron.

## Обновление до новой версии

Релиз помечается аннотированным тегом, на сервер уезжает архив тега (для срочной правки можно взять
`HEAD`, но в прод правильнее пускать только помеченное состояние):

```bash
# локально
git tag -a v0.1.1 -m "кратко: что вошло в релиз"   # если релиз ещё не помечен
git push origin v0.1.1
git archive --format=tar.gz -o geopuls-src.tar.gz v0.1.1
scp geopuls-src.tar.gz root@<IP>:/tmp/

# на сервере
cd /opt/geopuls && tar -xzf /tmp/geopuls-src.tar.gz && chmod +x infra/ops/*.sh
ARCHIVE=/tmp/geopuls-src.tar.gz bash infra/ops/update.sh
```

Реестра образов нет: `update.sh` собирает образы на сервере из исходников коммита, поэтому
`docker compose pull` не используется. Скрипт сначала снимает бэкап, затем пересобирает и
перезапускает контейнеры; данные в томе `pgdata` не трогаются. Правки только в скриптах (`infra/ops`)
пересборки не требуют — достаточно распаковать архив.

**Откат**: положить архив предыдущего тега и повторить `update.sh` — данные остаются на месте.

## Домен и TLS

Сейчас используется `<IP>.sslip.io`: сервис `sslip.io` отдаёт публичный DNS для такого имени, поэтому
Let's Encrypt выдаёт обычный (не самоподписанный) сертификат без покупки домена. Caddy продлевает его
сам (в логах — `certificate obtained successfully`).

Переезд на свой домен — одна переменная:

1. A-запись домена → `201.34.158.13` (порты 80/443 должны быть открыты).
2. `DOMAIN=geopuls.example.ru` в `/opt/geopuls/.env`.
3. `docker compose --profile prod up -d` — Caddy выпустит сертификат на новое имя.
4. Фронтенд пересобирать не нужно: `NEXT_PUBLIC_API_BASE_URL` пуст, запросы идут на тот же origin.

## Данные

- **Начальное наполнение**: восстановление дампа (`bootstrap.sh` с `DUMP=...`).
- **Плановое обновление**: cron `infra/ops/refresh-data.sh` — воскресенье, 02:30. Скачивает свежую
  выгрузку Geofabrik (`curl -z`, только если появилась новее), затем `python -m geopuls.refresh`
  (справочники → POI → агрегация). Если свободной памяти меньше порога (по умолчанию 2000 МБ),
  полный импорт пропускается с тревогой в вебхук, а агрегаты пересобираются.
- **Сколько это занимает** (замер на проде 28.09.2026, выгрузка Сибирского ФО 557 МБ, 2 vCPU):
  скачивание ≈ 2 мин, скан ≈ 40 мин, агрегация 0.2 с — полный цикл ≈ 42 мин, поэтому окно 02:30
  закрывается раньше бэкапа в 03:20. Пик памяти контейнера импорта 1.78 ГиБ, минимум свободной
  памяти на хосте 0.95 ГиБ. Чтобы перемерить, запустите рядом
  `nohup bash infra/ops/watch-refresh-memory.sh /var/log/geopuls/refresh-memory.log &`.
- **Ручной запуск**: `bash infra/ops/refresh-data.sh --skip-import` (быстро, только агрегаты).
- **Права на каталог выгрузки.** Плановое обновление скачивает PBF от имени root на хосте, а импорт
  выполняется в контейнере от непривилегированного пользователя `app` (uid 1000) и пишет рядом с
  выгрузкой файл кандидатов. Поэтому `refresh-data.sh` перед импортом отдаёт `data/raw` и сам PBF
  пользователю контейнера (uid/gid берутся из работающего контейнера). Если запускать импорт вручную
  из контейнера без этого шага, он упадёт с `PermissionError` — первый прогон на проде именно так и
  упал, поэтому это уже встроено в скрипт.

## Бэкапы и проверка восстановления

```bash
bash infra/ops/backup.sh                 # дамп в ./backups, ротация 14 дней (KEEP_DAYS)
bash infra/ops/verify-backup.sh          # восстановление в отдельную БД + сверка числа строк
KEEP_CHECK=1 bash infra/ops/verify-backup.sh   # оставить проверочную базу для разбора
```

`verify-backup.sh` возвращает ненулевой код при расхождении — это и есть «проверка выполнена, а не
заявлена» (DoD §11.1). Cron запускает её 1-го числа каждого месяца.

## Мониторинг и алерты

`monitor.sh` (cron каждые 5 минут) проверяет:

- `/healthz`, `/version`, `/readyz` — через публичный адрес, то есть тем же путём, что и пользователь
  (после двух неудачных прогонов подряд считается, что сервис недоступен ≥ 5 минут);
- свежесть данных: `data_version` из `/api/v1/meta/cities` старше 14 дней — тревога;
- диск и память > 85 %;
- все контейнеры в состоянии `running`;
- возраст последнего бэкапа (> 48 часов — тревога).

Результат пишется в `/var/log/geopuls/monitor.log` и `monitor.json`, при сбое — ненулевой код (cron
доставит письмо) и сообщение в вебхук, если задан `GEOPULS_ALERT_WEBHOOK` (поддерживается формат
Telegram `{"text": ...}`).

**Чего пока нет**: внешнего uptime-наблюдателя, который заметит падение всей машины. Рекомендация:
нацелить внешний сервис (UptimeRobot или Zabbix провайдера — агент уже работает на порту 10050) на
`https://<домен>/healthz` и `/readyz`. Порт 25 у провайдера закрыт, поэтому почтовые алерты из скриптов
не рассматриваются — только вебхук.

## Расписание (cron)

| Когда | Что | Лог |
|---|---|---|
| каждые 5 минут | мониторинг | `/var/log/geopuls/monitor.log` |
| ежедневно 03:20 | бэкап БД | `backup.log` |
| 1-го числа 04:20 | проверка восстановления | `verify-backup.log` |
| воскресенье 02:30 | обновление данных | `refresh.log` |
| 1-го числа 05:30 | обрезка разросшихся логов | — |

## Проверки после деплоя

```bash
curl -fsS https://<домен>/healthz && curl -fsS https://<домен>/readyz
curl -fsS -o /dev/null -w '%{http_code} %{size_download}\n' \
  "https://<домен>/api/v1/cells?city=tomsk&category=cafe&res=9"

# локально: карта, ячейки, клик по ячейке и список объектов в реальном браузере
cd frontend && PROD_URL="https://<домен>/?city=tomsk&category=cafe&debug=1" node scripts/prod-smoke.mjs

# нагрузочный прогон и Lighthouse (отчёты — docs/acceptance/)
cd backend && uv run python tools/loadtest.py --base-url https://<домен> --requests 40 --concurrency 6
npx lighthouse "https://<домен>/?city=tomsk&category=cafe" --chrome-flags="--headless=new"
```

Флаг `debug=1` в URL обязателен для браузерных проверок: ссылка на карту (`window.__geopulsMap`) в
продакшене отдаётся только с ним (ADR 0009). `prod-diagnose.mjs` печатает состояние карты, запросы к
API и ошибки консоли — инструмент для разбора «карта пустая» на проде.

## Безопасность

- Пароль root из выдачи провайдера передавался открытым текстом — **смените его** и заведите SSH-ключ
  (`ssh-copy-id`), после чего отключите вход по паролю (`PasswordAuthentication no` в
  `/etc/ssh/sshd_config`).
- Наружу открыты только 80/443; 5432/8000/3000 привязаны к `127.0.0.1`. Порты 465, 5060, 25, 53413,
  587, 389, 2525, 3389 закрыты на стороне провайдера — сервису они не нужны.
- `/opt/geopuls/.env` — права `600`; секреты и дампы не попадают в git (см. `.gitignore`).
- Firewall (`ufw`) на машине выключен, фильтрация — на стороне провайдера. Если включать `ufw`:
  разрешить 22, 80, 443 и 10050.


