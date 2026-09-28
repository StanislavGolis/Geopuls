# Поднимает весь стек в контейнерах одной командой: PostgreSQL + PostGIS, API и фронтенд.
#
# Запуск:    pwsh -File tools/docker-up.ps1
# Прод:      pwsh -File tools/docker-up.ps1 -Prod     (профиль caddy: HTTPS на 80/443)
# Без сборки: pwsh -File tools/docker-up.ps1 -NoBuild (использовать уже собранные образы)
# Остановка: pwsh -File tools/docker-down.ps1
#
# Данные БД живут в томе `pgdata` и сохраняются между перезапусками.
# Миграции применяются автоматически при старте контейнера API (backend/docker-entrypoint.sh).

[CmdletBinding()]
param(
    [int]$ApiPort = 8000,
    [int]$WebPort = 3000,
    [switch]$Prod,
    [switch]$NoBuild,
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

Push-Location $repoRoot
try {
    # Порты прокидываются в docker-compose.yml: CORS и базовый URL API зависят от них
    $env:API_PORT = "$ApiPort"
    $env:WEB_PORT = "$WebPort"

    $profileArgs = if ($Prod) { @('--profile', 'prod') } else { @() }

    if (-not $NoBuild) {
        Write-Host '1/3 Собираю образы (первый раз это несколько минут: зависимости + сборка Next)...'
        & docker compose @profileArgs build
        if ($LASTEXITCODE -ne 0) { throw 'сборка образов завершилась с ошибкой' }
    }

    Write-Host '2/3 Поднимаю контейнеры...'
    & docker compose @profileArgs up -d
    if ($LASTEXITCODE -ne 0) { throw 'запуск контейнеров завершился с ошибкой' }

    Write-Host '3/3 Жду готовности сервисов (БД → API → web)...'
    $healthy = 0
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Seconds 3
        $status = & docker compose ps --format '{{.Service}} {{.Status}}'
        $healthy = ($status | Select-String -Pattern '\(healthy\)').Count
    } while ($healthy -lt 3 -and (Get-Date) -lt $deadline)

    Write-Host ''
    & docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
    Write-Host ''

    if ($healthy -lt 3) {
        Write-Host 'Не все сервисы стали healthy за отведённое время. Логи:'
        & docker compose logs --tail 40
        throw 'стек не поднялся полностью'
    }

    Write-Host "Карта:     http://localhost:$WebPort/?city=tomsk&category=cafe"
    Write-Host "API:       http://127.0.0.1:$ApiPort/docs"
    Write-Host 'Логи:      docker compose logs -f web'
    Write-Host 'Остановка: pwsh -File tools/docker-down.ps1'
}
finally {
    Pop-Location
}
