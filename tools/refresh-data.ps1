# Обновление данных города одной командой: справочники → POI → агрегация.
#
# Запуск:            pwsh -File tools/refresh-data.ps1 -Pbf data\raw\siberian-fed-district-260927.osm.pbf
# Из готового дампа: pwsh -File tools/refresh-data.ps1 -FromDump data\raw\....poi-candidates.jsonl
# Только агрегаты:   pwsh -File tools/refresh-data.ps1 -SkipImport
#
# Работает через контейнер API (`docker compose run`), поэтому подходит и для cron/systemd на VPS:
#   docker compose run --rm api python -m geopuls.refresh --city tomsk --pbf /data/raw/<выгрузка>.pbf
# Ненулевой код возврата означает, что обновление упало — по нему отправляется уведомление (§9.3 ТЗ).

[CmdletBinding()]
param(
    [string]$City = 'tomsk',
    [string]$Pbf,
    [string]$FromDump,
    [switch]$SkipImport,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

Push-Location $repoRoot
try {
    $arguments = @('compose', 'run', '--rm', 'api', 'python', '-m', 'geopuls.refresh', '--city', $City)

    if ($Pbf) {
        # Путь на хосте превращаем в путь внутри контейнера: каталог data/ смонтирован в /data
        $relative = (Resolve-Path $Pbf).Path.Substring($repoRoot.Length).Replace('\', '/').TrimStart('/')
        $arguments += @('--pbf', "/$relative")
    }
    elseif ($FromDump) {
        $relative = (Resolve-Path $FromDump).Path.Substring($repoRoot.Length).Replace('\', '/').TrimStart('/')
        $arguments += @('--from-dump', "/$relative")
    }
    elseif ($SkipImport) {
        $arguments += '--skip-import'
    }
    else {
        throw 'Укажите -Pbf, -FromDump или -SkipImport'
    }

    if ($DryRun) { $arguments += '--dry-run' }

    & docker @arguments
    if ($LASTEXITCODE -ne 0) { throw "обновление данных завершилось с кодом $LASTEXITCODE" }

    Write-Host ''
    Write-Host 'Данные обновлены. Проверить: curl http://127.0.0.1:8000/api/v1/meta/cities'
}
finally {
    Pop-Location
}
