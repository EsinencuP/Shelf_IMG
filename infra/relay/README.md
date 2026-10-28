# Relay на домашнем ПК

Отдельный Node-сервер без Docker и без сборки Next.js. Исходящие запросы идут с IP
этого компьютера через общий `publicGet` → `outboundFetch`. Требуется Node.js 24
и установленные зависимости проекта (`npm ci` в корне).

Из корня проекта подготовьте локальные настройки:

```powershell
if (-not (Test-Path infra/relay/.env.local)) {
  Copy-Item infra/relay/.env.example infra/relay/.env.local
}
```

Задайте в `infra/relay/.env.local` случайный `RELAY_TOKEN` длиной 32–256 ASCII-символов
без пробелов. Сгенерировать и записать токен без вывода в терминал можно так:

```powershell
node --input-type=module -e "import{randomBytes}from'node:crypto';import{readFileSync,writeFileSync}from'node:fs';const p='infra/relay/.env.local';const s=readFileSync(p,'utf8');if(!/^RELAY_TOKEN=.+$/m.test(s))writeFileSync(p,s.replace(/^RELAY_TOKEN=.*$/m,'RELAY_TOKEN='+randomBytes(32).toString('hex')));"
npm run relay
```

Сервер слушает <http://127.0.0.1:8787>. Для остановки нажмите **Ctrl+C**.
Секрет хранится только в `.env.local`; файл исключён из Git. Переменные процесса
имеют приоритет над env-файлом. При отсутствии токена или allowlist сервер не стартует.

| Переменная              | По умолчанию | Назначение                                                 |
| ----------------------- | ------------ | ---------------------------------------------------------- |
| `RELAY_TOKEN`           | Нет          | Bearer-токен обоих endpoint                                |
| `RELAY_ALLOWED_DOMAINS` | Нет          | Точные имена разрешённых доменов через запятую             |
| `RELAY_HOST`            | `127.0.0.1`  | Только loopback: `127.0.0.1` или `::1`                     |
| `RELAY_PORT`            | `8787`       | Порт от 1 до 65535                                         |
| `RELAY_MAX_BYTES`       | `4000000`    | Максимум байт ответа; можно уменьшить                      |
| `RELAY_TIMEOUT_MS`      | `15000`      | Общий бюджет DNS, загрузки и редиректов, максимум 30000 мс |

Allowlist не принимает URL, IP, `*` или маски поддоменов. `metro.zakaz.md` и
`api.metro.zakaz.md` — разные записи. CDN изображений нужно добавить отдельно.
На каждом редиректе повторно проверяются allowlist и DNS. Приватные, служебные и
смешанные публичные/приватные DNS-ответы отклоняются; соединение закрепляется за
проверенным IP. Разрешён только публичный HTTPS на порту 443.

Оба endpoint требуют `Authorization: Bearer <RELAY_TOKEN>`:

- `GET /health` → `200 {"ok":true,"service":"shelf-relay"}`. Не проверяет магазины.
- `POST /fetch`, `Content-Type: application/json`, тело `{"url":"https://metro.zakaz.md/ru/"}`.
  Выполняет только GET; дополнительные поля запроса отклоняются. Возвращает байты
  HTML, JSON или изображения, исходный HTTP-статус и `Content-Type`.
  `X-Shelf-Upstream-Status` и `X-Shelf-Upstream-Url` показывают итоговый ответ источника.

Без токена — 401; домен вне allowlist — 403; приватный/некорректный URL или DNS — 422;
слишком большой запрос/ответ — 413; таймаут — 504. Ошибки соединения возвращаются
как 502 без технических подробностей. Лимит — три одновременные загрузки; при
превышении — 429. Входящий JSON ограничен 16 КиБ, редиректы — тремя переходами.
Куки, Authorization и произвольные заголовки клиента источнику не передаются.

Примеры для PowerShell (`curl.exe`, чтобы не вызывать PowerShell-алиас):

```powershell
# Проверка авторизации: ожидается 401.
curl.exe -i http://127.0.0.1:8787/health

# Чтение токена в память из уже настроенного .env.local.
$relayToken = ((Get-Content infra/relay/.env.local | Where-Object { $_ -match '^RELAY_TOKEN=' }) -replace '^RELAY_TOKEN=', '').Trim()

# Заголовок передаётся curl через stdin, токен не попадает в аргументы процесса.
"Authorization: Bearer $relayToken" | curl.exe -i --header '@-' http://127.0.0.1:8787/health

# HTML METRO: ожидается 200, если домашний IP допускается источником.
'{"url":"https://metro.zakaz.md/ru/"}' | Set-Content -Encoding ascii relay-request.json
"Authorization: Bearer $relayToken" | curl.exe --header '@-' --header 'Content-Type: application/json' --data-binary '@relay-request.json' http://127.0.0.1:8787/fetch

# Приватный IP: ожидается 422.
'{"url":"https://127.0.0.1/"}' | Set-Content -Encoding ascii relay-request.json
"Authorization: Bearer $relayToken" | curl.exe -i --header '@-' --header 'Content-Type: application/json' --data-binary '@relay-request.json' http://127.0.0.1:8787/fetch
Remove-Item -LiteralPath relay-request.json
Remove-Variable relayToken
```

Сервис доступен на loopback. Для доступа Vercel настройте HTTPS-туннель, затем
задайте в окружении приложения `RELAY_URL=https://pc.tailnet.ts.net` (база, без
`/fetch`) и тот же `RELAY_TOKEN`. Для локальной проверки приложения используйте
`RELAY_URL=http://127.0.0.1:8787`. Эти переменные находятся в `.env.local` приложения
или Vercel env; настройки самого сервера остаются в `infra/relay/.env.local`.

Приложение повторяет заблокированный GET один раз через relay. Сам relay всегда
загружает напрямую, даже если в его окружении присутствует `RELAY_URL`.
Ответы сервиса отмечены `X-Shelf-Relay: 1`; заголовки `X-Shelf-Upstream-*`
присутствуют только при полученном HTTP-ответе источника.
[Политика повторов и статус relay_offline](../../docs/OUTBOUND-FETCH.md).
