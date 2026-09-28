# Остановка локального стека разработки (API, фронтенд, БД).
#
# Запуск: pwsh -File tools/dev-down.ps1
# Параметр -KeepDb оставляет контейнер базы данных запущенным.

[CmdletBinding()]
param(
    [switch]$KeepDb
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot

# Останавливаем только процессы, запущенные из этого репозитория (по командной строке)
$targets = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'python.exe' OR Name = 'pwsh.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$repoRoot*" }

foreach ($process in $targets) {
    Write-Host "Останавливаю $($process.Name) (pid $($process.ProcessId))"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

if (-not $KeepDb) {
    Write-Host 'Останавливаю контейнеры docker compose...'
    Push-Location $repoRoot
    try { & docker compose down | Out-Null } finally { Pop-Location }
}

Write-Host 'Готово.'
