# Запуск локального стека разработки одной командой: БД в Docker + API + фронтенд.
#
# Запуск:  pwsh -File tools/dev-up.ps1
# Остановка: pwsh -File tools/dev-down.ps1
# Логи: data/processed/api.log, data/processed/web.log

[CmdletBinding()]
param(
    [int]$ApiPort = 8000,
    [int]$WebPort = 3000
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $repoRoot 'data\processed'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

Write-Host '1/3 Поднимаю PostgreSQL + PostGIS (docker compose)...'
Push-Location $repoRoot
try {
    & docker compose up -d db | Out-Null
    $deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Seconds 2
        $status = (& docker compose ps --format '{{.Service}} {{.Status}}' | Select-String -Pattern '^db ').Line
    } while ($status -notmatch 'healthy' -and (Get-Date) -lt $deadline)
    Write-Host "    $status"
}
finally {
    Pop-Location
}

Write-Host "2/3 Запускаю API на http://127.0.0.1:$ApiPort ..."
$api = Start-Process -FilePath pwsh -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-Command',
    "cd `"$repoRoot\backend`"; uv run uvicorn geopuls.main:app --host 127.0.0.1 --port $ApiPort"
) -RedirectStandardOutput (Join-Path $logs 'api.log') -RedirectStandardError (Join-Path $logs 'api.err.log')

Write-Host "3/3 Запускаю фронтенд на http://localhost:$WebPort ..."
$web = Start-Process -FilePath pwsh -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-Command',
    "cd `"$repoRoot\frontend`"; npm run dev"
) -RedirectStandardOutput (Join-Path $logs 'web.log') -RedirectStandardError (Join-Path $logs 'web.err.log')

# Ждём готовности обоих сервисов
$apiReady = $false
$webReady = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline -and -not ($apiReady -and $webReady)) {
    Start-Sleep -Seconds 3
    if (-not $apiReady) {
        $apiReady = (curl.exe -s -o nul -w '%{http_code}' --max-time 5 "http://127.0.0.1:$ApiPort/healthz") -eq '200'
    }
    if (-not $webReady) {
        $webReady = (curl.exe -s -o nul -w '%{http_code}' --max-time 10 "http://localhost:$WebPort/") -eq '200'
    }
}

$apiStatus = if ($apiReady) { 'готов' } else { 'не ответил (см. data/processed/api.err.log)' }
$webStatus = if ($webReady) { 'готов' } else { 'не ответил (см. data/processed/web.err.log)' }
Write-Host ''
Write-Host "API:      http://127.0.0.1:$ApiPort/docs — $apiStatus (pid $($api.Id))"
Write-Host "Карта:    http://localhost:$WebPort/?city=tomsk&category=cafe — $webStatus (pid $($web.Id))"
Write-Host 'Остановка: pwsh -File tools/dev-down.ps1'
