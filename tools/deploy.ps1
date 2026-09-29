# Развёртывание текущего коммита на прод одной командой.
#
#   pwsh -File tools/deploy.ps1                # архив → сервер → update.sh → проверка прода
#   pwsh -File tools/deploy.ps1 -SkipCheck     # без финальной проверки (только выкат)
#   pwsh -File tools/deploy.ps1 -AllowDirty    # разрешить деплой с незакоммиченными правками
#
# Доступ к серверу — по ключу (``~/.ssh/id_ed25519``, путь переопределяется ``VPS_KEY``): на проде
# вход по паролю выключен. Пароль (``VPS_PASSWORD``) остаётся резервным путём для серверов, где ключ
# ещё не заведён.
#
# Ожидание идёт по `/version`: если на сервер уехал не тот архив (например, собранный до коммита),
# проверка этого не пропустит — именно на таких граблях мы стояли.
#
# Адрес проверки задаётся доменом (`-BaseUrl`), а не IP: сертификат выписан на `*.sslip.io`, и запрос к
# голому IP падает на TLS — ожидание в этом случае молча крутится до таймаута. Поэтому ошибки запроса и
# увиденный коммит не глушатся, а печатаются при неудаче.
#
# Пароль передаётся дочернему процессу tools/vps.py через окружение: скрипт его не печатает и никуда
# не сохраняет.
[CmdletBinding()]
param(
    [switch]$AllowDirty,
    [switch]$SkipCheck,
    [int]$TimeoutMinutes = 15,
    [string]$BaseUrl = $(if ($env:PROD_URL) { $env:PROD_URL } else { 'https://201.34.158.13.sslip.io' }),
    [string]$VpsHost = $(if ($env:VPS_HOST) { $env:VPS_HOST } else { '201.34.158.13' })
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $repoRoot 'data\processed\geopuls-src.tar.gz'
$vps = Join-Path $PSScriptRoot 'vps.py'
# Ключ доступа к серверу: на проде вход по паролю выключен, поэтому ключ — основной путь
$keyPath = if ($env:VPS_KEY) { $env:VPS_KEY } else { Join-Path $HOME '.ssh\id_ed25519' }

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# `PROD_URL` может прийти со строкой запроса — его же использует prod-smoke для карты. Для запросов к
# API нужен только origin: иначе `/version` вернёт HTML страницы, и опрос будет видеть «пустой коммит»
# (ровно эта ловушка стоила 15 минут ожидания на выкате Этапа 9)
$BaseUrl = ([System.Uri]$BaseUrl).GetLeftPart([System.UriPartial]::Authority)

if (-not (Test-Path $keyPath) -and -not $env:VPS_PASSWORD) {
    Write-Host 'Нужен доступ к серверу: положите ключ в ~/.ssh/id_ed25519' -ForegroundColor Red
    Write-Host '(или задайте $env:VPS_KEY) — на проде вход по паролю выключен.' -ForegroundColor Red
    Write-Host 'Резервный путь: $env:VPS_PASSWORD = ''<пароль root>''' -ForegroundColor Red
    exit 2
}
$env:VPS_HOST = $VpsHost

Push-Location $repoRoot
try {
    $sha = (git rev-parse --short HEAD).Trim()
    $dirty = @(git status --porcelain)
    if ($dirty.Count -gt 0 -and -not $AllowDirty) {
        Write-Host 'Дерево не чистое — в архив попадёт только закоммиченное состояние.' -ForegroundColor Red
        $dirty | Select-Object -First 5 | ForEach-Object { "  $_" } | Write-Host
        Write-Host 'Закоммитьте изменения или запустите с -AllowDirty.' -ForegroundColor Red
        exit 2
    }

    Write-Host ("1/3 Архив коммита {0}" -f $sha) -ForegroundColor Cyan
    git archive --format=tar.gz -o $archive HEAD
    $sizeMb = [math]::Round((Get-Item $archive).Length / 1KB, 1)
    Write-Host ("      {0} КБ" -f $sizeMb) -ForegroundColor DarkGray

    Write-Host '2/3 Загрузка и запуск update.sh на сервере' -ForegroundColor Cyan
    & uv run --with paramiko python $vps put $archive /tmp/geopuls-src.tar.gz | Write-Host -ForegroundColor DarkGray
    $launch = "cd /opt/geopuls && tar -xzf /tmp/geopuls-src.tar.gz && chmod +x infra/ops/*.sh && " +
        "(nohup env ARCHIVE=/tmp/geopuls-src.tar.gz bash infra/ops/update.sh > /tmp/update.log 2>&1 &) ; echo started"
    & uv run --with paramiko python $vps run $launch | Write-Host -ForegroundColor DarkGray

    Write-Host ("3/3 Ожидание /version = {0}" -f $sha) -ForegroundColor Cyan
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $deployed = $false
    $lastSeen = ''
    $lastError = ''
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 15
        try {
            $version = Invoke-RestMethod -Uri "$BaseUrl/version" -TimeoutSec 20
            if ($version.git_sha -eq $sha) { $deployed = $true; break }
            if (-not $version.git_sha) {
                # Ответ не похож на `/version` (например, HTML страницы) — это ошибка запроса, а не
                # «сервер ещё на старом коммите»: показываем как провал, чтобы не ждать 15 минут молча
                $lastError = "ответ без git_sha — проверьте адрес: $BaseUrl"
                Write-Host '.' -NoNewline -ForegroundColor DarkGray
                continue
            }
            $lastSeen = $version.git_sha
            Write-Host (".[{0}]" -f $lastSeen) -NoNewline -ForegroundColor DarkGray
        }
        catch {
            $lastError = $_.Exception.Message
            Write-Host '.' -NoNewline -ForegroundColor DarkGray
        }
    }
    Write-Host ''

    if (-not $deployed) {
        Write-Host ('Сервер не переключился на {0} за {1} минут.' -f $sha, $TimeoutMinutes) -ForegroundColor Red
        if ($lastSeen) { Write-Host ("      на /version пока {0}" -f $lastSeen) -ForegroundColor Red }
        if ($lastError) { Write-Host ("      ошибка запроса: {0}" -f $lastError) -ForegroundColor Red }
        Write-Host 'Хвост /tmp/update.log:' -ForegroundColor Red
        & uv run --with paramiko python $vps run "tail -20 /tmp/update.log" | Write-Host -ForegroundColor DarkGray
        exit 1
    }
    Write-Host ("      развёрнут {0}" -f $sha) -ForegroundColor DarkGray
}
finally {
    Pop-Location
}

if (-not $SkipCheck) {
    & (Join-Path $PSScriptRoot 'prod-check.ps1') -ExpectedSha $sha -BaseUrl $BaseUrl
    exit $LASTEXITCODE
}
Write-Host 'Выкат выполнен, проверка пропущена (-SkipCheck).' -ForegroundColor Yellow
exit 0
