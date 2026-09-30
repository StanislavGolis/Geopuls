# Локальная проверка перед коммитом: одна команда вместо пяти.
#
#   pwsh -File tools/check.ps1                 # всё: бэкенд, фронтенд, E2E
#   pwsh -File tools/check.ps1 -SkipE2E         # без браузерных проверок (быстрее)
#   pwsh -File tools/check.ps1 -Only backend    # только бэкенд
#
# Вывод сознательно короткий: полный лог каждого шага пишется в data/processed/check-<шаг>.log,
# в консоль попадает одна строка на шаг, а при падении — хвост лога. Так большие логи ruff, pytest
# и Playwright не засоряют разбор, но остаются доступны для чтения при ошибке.
#
# Почему именно такие флаги: ruff -q печатает только проблемы, pytest -p no:warnings убирает блок
# предупреждений (он одинаков в каждом прогоне), vitest --reporter=dot даёт одну строку на файл,
# Playwright --reporter=line — одну строку на тест.
[CmdletBinding()]
param(
    [ValidateSet('all', 'backend', 'frontend')][string]$Only = 'all',
    [switch]$SkipE2E,
    [string]$TestDatabaseUrl = 'postgresql+asyncpg://geopuls:geopuls@localhost:5432/geopuls_test',
    [int]$TailLines = 12
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $repoRoot 'backend'
$frontend = Join-Path $repoRoot 'frontend'
$logDir = Join-Path $repoRoot 'data\processed'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# UTF-8 в консоли и для дочерних Python-процессов: иначе русский текст превращается в кашу
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$script:results = @()

function Invoke-Step {
    param(
        [string]$Name,
        [string]$Exe,
        [string[]]$Arguments,
        [string]$WorkDir,
        [hashtable]$Environment = @{}
    )
    $log = Join-Path $logDir "check-$Name.log"
    $saved = @{}
    foreach ($key in $Environment.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key)
        Set-Item -Path "Env:$key" -Value $Environment[$key]
    }
    $started = Get-Date
    Push-Location $WorkDir
    try {
        & $Exe @Arguments *> $log
        $code = $LASTEXITCODE
    }
    finally {
        Pop-Location
        foreach ($key in $Environment.Keys) {
            if ($null -eq $saved[$key]) { Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue }
            else { Set-Item -Path "Env:$key" -Value $saved[$key] }
        }
    }
    $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $state = if ($code -eq 0) { 'ок' } else { "ОШИБКА (код $code)" }
    $script:results += [pscustomobject]@{ Шаг = $Name; Результат = $state; Секунд = $seconds }
    if ($code -eq 0) {
        Write-Host ("  {0,-16} {1,-16} {2,6} с" -f $Name, 'ок', $seconds) -ForegroundColor DarkGray
    }
    else {
        Write-Host ("  {0,-16} {1,-16} {2,6} с" -f $Name, $state, $seconds) -ForegroundColor Red
        Write-Host "    хвост ${log}:" -ForegroundColor DarkGray
        Get-Content $log -Tail $TailLines | ForEach-Object { "      $_" } | Write-Host -ForegroundColor DarkGray
    }
    return $code
}

Write-Host 'Локальная проверка ГЕОПУЛЬС' -ForegroundColor Cyan

if ($Only -ne 'frontend') {
    Invoke-Step 'ruff' 'uv' @('run', 'ruff', 'check', '-q', '.') $backend | Out-Null
    Invoke-Step 'ruff-format' 'uv' @('run', 'ruff', 'format', '--check', '-q', '.') $backend | Out-Null
    Invoke-Step 'pytest' 'uv' @('run', 'pytest', '-q', '--no-header', '-p', 'no:warnings') $backend @{
        GEOPULS_CI_DB        = '1'
        GEOPULS_DATABASE_URL = $TestDatabaseUrl
    } | Out-Null
}

if ($Only -ne 'backend') {
    Invoke-Step 'typecheck' 'npm' @('run', '--silent', 'typecheck') $frontend | Out-Null
    Invoke-Step 'unit' 'npx' @('vitest', 'run', '--reporter=dot') $frontend | Out-Null

    if (-not $SkipE2E) {
        # E2E идут против собранного фронтенда в контейнере: если стек не поднят, это не ошибка кода
        $webUp = $false
        try {
            $probe = Invoke-WebRequest -Uri 'http://localhost:3000/' -TimeoutSec 5 -UseBasicParsing
            $webUp = $probe.StatusCode -eq 200
        }
        catch { $webUp = $false }

        if ($webUp) {
            # Адреса задаём явно: переменные GEOPULS_WEB_URL/GEOPULS_API_URL остаются в сессии от
            # прогонов против прода, и без этого «локальная» проверка незаметно уезжает на прод.
            Invoke-Step 'e2e' 'npx' @('playwright', 'test', '--reporter=line') $frontend @{
                GEOPULS_WEB_URL = 'http://localhost:3000'
                GEOPULS_API_URL = 'http://127.0.0.1:8000'
            } | Out-Null
        }
        else {
            Write-Host '  e2e              ПРОПУЩЕН (стек не поднят: pwsh -File tools/docker-up.ps1)' -ForegroundColor Yellow
        }
    }
}

$failed = @($script:results | Where-Object { $_.Результат -ne 'ок' })
Write-Host ''
$script:results | Format-Table -AutoSize | Out-String | Write-Host
if ($failed.Count -gt 0) {
    Write-Host ("ИТОГ: провалено шагов — {0}. Логи: data\processed\check-*.log" -f $failed.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'ИТОГ: всё зелёное.' -ForegroundColor Green
exit 0
