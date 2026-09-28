# Останавливает стек, поднятый tools/docker-up.ps1.
#
# Запуск:              pwsh -File tools/docker-down.ps1
# С профилем prod:     pwsh -File tools/docker-down.ps1 -Prod
# Удалить и данные БД: pwsh -File tools/docker-down.ps1 -Purge   (том pgdata будет удалён)

[CmdletBinding()]
param(
    [switch]$Purge,
    [switch]$Prod
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

Push-Location $repoRoot
try {
    $profileArgs = if ($Prod) { @('--profile', 'prod') } else { @() }

    if ($Purge) {
        Write-Host 'Останавливаю контейнеры и удаляю тома (данные БД и TLS-сертификаты будут потеряны)...'
        & docker compose @profileArgs down --volumes --remove-orphans
    }
    else {
        Write-Host 'Останавливаю контейнеры (данные БД сохраняются в томе pgdata)...'
        & docker compose @profileArgs down --remove-orphans
    }

    if ($LASTEXITCODE -ne 0) { throw 'остановка завершилась с ошибкой' }
}
finally {
    Pop-Location
}
