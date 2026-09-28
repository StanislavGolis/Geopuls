# Восстановление БД из дампа + автоматическая сверка (проверка, что копия действительно рабочая).
#
# По умолчанию восстанавливаем в отдельную базу и сверяем с рабочей — рабочую не трогаем:
#   pwsh -File tools\db-restore.ps1 -Dump data\backups\geopuls-geopuls-2026-09-28-2140.dump
#
# Восстановить поверх рабочей базы (осторожно, данные будут перезаписаны):
#   pwsh -File tools\db-restore.ps1 -Dump <файл> -Database geopuls -Force
#
# Проверка восстановления — обязательный пункт DoD (docs/tz.md, §11.1): скрипт сравнивает число строк
# ключевых таблиц в источнике и в восстановленной базе и падает, если цифры разошлись.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Dump,
    [string]$Database = 'geopuls_restore_check',
    [string]$VerifyAgainst = 'geopuls',
    [string]$User = 'geopuls',
    [switch]$Force,
    [switch]$KeepRestored
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$tables = @('pois', 'city_cells', 'cell_stats', 'cities', 'categories', 'data_versions')

function Get-TableCounts([string]$dbName) {
    $query = ($tables | ForEach-Object { "SELECT '$_' AS t, count(*) FROM $_" }) -join ' UNION ALL '
    $output = & docker compose exec -T db psql -U $User -d $dbName -t -A -F',' -c "$query ORDER BY 1"
    if ($LASTEXITCODE -ne 0) { throw "не удалось прочитать таблицы базы $dbName" }
    return @($output | Where-Object { $_ -match ',' })
}

Push-Location $repoRoot
try {
    $dumpPath = (Resolve-Path $Dump).Path
    if ($Database -eq $VerifyAgainst -and -not $Force) {
        throw "восстановление поверх рабочей базы $Database требует -Force"
    }

    $insideContainer = "/tmp/$([System.IO.Path]::GetFileName($dumpPath))"

    Write-Host "1/4 Копирую дамп в контейнер..."
    & docker compose cp $dumpPath "db:$insideContainer"
    if ($LASTEXITCODE -ne 0) { throw 'не удалось скопировать дамп в контейнер' }

    Write-Host "2/4 Пересоздаю базу $Database..."
    & docker compose exec -T db dropdb -U $User --if-exists $Database
    & docker compose exec -T db createdb -U $User $Database
    if ($LASTEXITCODE -ne 0) { throw "не удалось пересоздать базу $Database" }

    Write-Host "3/4 Восстанавливаю из дампа..."
    & docker compose exec -T db pg_restore -U $User -d $Database --no-owner --exit-on-error $insideContainer
    if ($LASTEXITCODE -ne 0) { throw 'pg_restore завершился с ошибкой' }
    & docker compose exec -T db rm -f $insideContainer | Out-Null

    Write-Host '4/4 Сверяю число строк с источником...'
    $restored = Get-TableCounts $Database
    $expected = Get-TableCounts $VerifyAgainst

    Write-Host ''
    Write-Host ('{0,-16} {1,10} {2,10}' -f 'таблица', 'источник', 'восстановлено')
    foreach ($line in $expected) {
        $name = $line.Split(',')[0]
        $sourceCount = $line.Split(',')[1]
        $restoredCount = ($restored | Where-Object { $_.Split(',')[0] -eq $name } | Select-Object -First 1).Split(',')[1]
        Write-Host ('{0,-16} {1,10} {2,10}' -f $name, $sourceCount, $restoredCount)
    }

    $mismatch = $expected | Where-Object {
        $name = $_.Split(',')[0]
        $sourceCount = $_.Split(',')[1]
        $restoredCount = ($restored | Where-Object { $_.Split(',')[0] -eq $name } | Select-Object -First 1).Split(',')[1]
        $restoredCount -ne $sourceCount
    }

    if ($mismatch) {
        throw 'восстановленная копия отличается от источника — бэкап считать непроверенным'
    }

    Write-Host ''
    Write-Host "Восстановление проверено: цифры совпадают (база $Database)."

    if (-not $KeepRestored -and $Database -ne $VerifyAgainst) {
        & docker compose exec -T db dropdb -U $User --if-exists $Database | Out-Null
        Write-Host "Проверочная база $Database удалена (нужна — запустите с -KeepRestored)."
    }
}
finally {
    Pop-Location
}
