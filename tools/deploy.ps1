# Развёртывание текущего коммита на прод одной командой.
#
#   $env:VPS_PASSWORD = '<пароль root>'        # берётся из окружения, в репозиторий не попадает
#   pwsh -File tools/deploy.ps1                # архив → сервер → update.sh → проверка прода
#   pwsh -File tools/deploy.ps1 -SkipCheck     # без финальной проверки (только выкат)
#   pwsh -File tools/deploy.ps1 -AllowDirty    # разрешить деплой с незакоммиченными правками
#
# Ожидание идёт по `/version`: если на сервер уехал не тот архив (например, собранный до коммита),
# проверка этого не пропустит — именно на таких граблях мы стояли.
#
# Пароль передаётся дочернему процессу tools/vps.py через окружение: скрипт его не печатает и никуда
# не сохраняет.
[CmdletBinding()]
param(
    [switch]$AllowDirty,
    [switch]$SkipCheck,
    [int]$TimeoutMinutes = 15,
    [string]$VpsHost = $(if ($env:VPS_HOST) { $env:VPS_HOST } else { '201.34.158.13' })
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $repoRoot 'data\processed\geopuls-src.tar.gz'
$vps = Join-Path $PSScriptRoot 'vps.py'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $env:VPS_PASSWORD) {
    Write-Host 'Нужен пароль: $env:VPS_PASSWORD = ''<пароль root>''' -ForegroundColor Red
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
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 15
        try {
            $version = Invoke-RestMethod -Uri "https://$VpsHost/version" -TimeoutSec 20
            if ($version.git_sha -eq $sha) { $deployed = $true; break }
            Write-Host '      .' -NoNewline -ForegroundColor DarkGray
        }
        catch { Write-Host '      .' -NoNewline -ForegroundColor DarkGray }
    }
    Write-Host ''

    if (-not $deployed) {
        Write-Host ('Сервер не переключился на {0} за {1} минут. Хвост /tmp/update.log:' -f $sha, $TimeoutMinutes) -ForegroundColor Red
        & uv run --with paramiko python $vps run "tail -20 /tmp/update.log" | Write-Host -ForegroundColor DarkGray
        exit 1
    }
    Write-Host ("      развёрнут {0}" -f $sha) -ForegroundColor DarkGray
}
finally {
    Pop-Location
}

if (-not $SkipCheck) {
    & (Join-Path $PSScriptRoot 'prod-check.ps1') -ExpectedSha $sha
    exit $LASTEXITCODE
}
Write-Host 'Выкат выполнен, проверка пропущена (-SkipCheck).' -ForegroundColor Yellow
exit 0
