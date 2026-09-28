# Создание тестовой БД и применение миграций.
#
# Тесты чистят таблицы (TRUNCATE), поэтому работают только с базой, в имени которой есть "test":
# conftest.py откажется запускать их против рабочей базы.
#
# Запуск (из корня репозитория):
#   pwsh -File tools/init-test-db.ps1
# Затем:
#   cd backend; $env:GEOPULS_CI_DB='1'; uv run pytest

[CmdletBinding()]
param(
    [string]$Container = 'geopuls-db-1',
    [string]$User = 'geopuls',
    [string]$MainDb = 'geopuls',
    [string]$TestDb = 'geopuls_test'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "Создаю базу $TestDb (если её ещё нет)..."
$exists = & docker exec $Container psql -U $User -d $MainDb -tAc "SELECT 1 FROM pg_database WHERE datname = '$TestDb'"
if ($exists -notcontains '1') {
    & docker exec $Container psql -U $User -d $MainDb -c "CREATE DATABASE $TestDb"
    Write-Host "База $TestDb создана"
}
else {
    Write-Host "База $TestDb уже существует"
}

$testUrl = "postgresql+asyncpg://$User`:$User@localhost:5432/$TestDb"
Write-Host "Применяю миграции к $TestDb..."
Push-Location (Join-Path $repoRoot 'backend')
try {
    $env:GEOPULS_DATABASE_URL = $testUrl
    & uv run alembic upgrade head
}
finally {
    Pop-Location
}

Write-Host "Готово. Тестовая БД: $TestDb"
Write-Host 'Запуск тестов: cd backend; $env:GEOPULS_CI_DB="1"; uv run pytest'
