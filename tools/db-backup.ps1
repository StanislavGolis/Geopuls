# Резервная копия БД ГЕОПУЛЬС: pg_dump в каталог data/backups с ротацией.
#
# Запуск:            pwsh -File tools/db-backup.ps1
# Другая база:       pwsh -File tools/db-backup.ps1 -Database geopuls
# Хранить 30 дней:   pwsh -File tools/db-backup.ps1 -KeepDays 30
#
# Дамп снимается внутри контейнера `db` и копируется на хост (`docker compose cp`), потому что
# перенаправление бинарного потока через PowerShell портит файл. Восстановление — tools/db-restore.ps1,
# он же проверяет, что копия восстанавливается и цифры совпадают.

[CmdletBinding()]
param(
    [string]$Database = 'geopuls',
    [string]$User = 'geopuls',
    [string]$OutDir,
    [int]$KeepDays = 14
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'data\backups' }

Push-Location $repoRoot
try {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

    $stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
    $fileName = "geopuls-$Database-$stamp.dump"
    $target = Join-Path $OutDir $fileName
    $insideContainer = "/tmp/$fileName"

    Write-Host "1/3 Снимаю дамп базы $Database внутри контейнера..."
    & docker compose exec -T db pg_dump -U $User -d $Database -Fc -f $insideContainer
    if ($LASTEXITCODE -ne 0) { throw 'pg_dump завершился с ошибкой' }

    Write-Host '2/3 Копирую дамп на хост...'
    & docker compose cp "db:$insideContainer" $target
    if ($LASTEXITCODE -ne 0) { throw 'не удалось скопировать дамп из контейнера' }
    & docker compose exec -T db rm -f $insideContainer | Out-Null

    Write-Host '3/3 Убираю копии старше срока хранения...'
    $deadline = (Get-Date).AddDays(-$KeepDays)
    $removed = 0
    Get-ChildItem -Path $OutDir -Filter "geopuls-$Database-*.dump" |
        Where-Object { $_.LastWriteTime -lt $deadline } |
        ForEach-Object { Remove-Item $_.FullName -Force; $removed += 1 }

    $size = [math]::Round((Get-Item $target).Length / 1MB, 1)
    Write-Host ''
    Write-Host "Бэкап: $target ($size МБ)"
    Write-Host "Удалено старых копий: $removed (храним $KeepDays дней)"
    Write-Host "Проверка восстановления: pwsh -File tools/db-restore.ps1 -Dump `"$target`""
}
finally {
    Pop-Location
}
