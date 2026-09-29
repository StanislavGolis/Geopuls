# Проверка прода после деплоя: эндпоинты, числа слоя и браузерная проверка карты.
#
#   pwsh -File tools/prod-check.ps1                        # полный набор
#   pwsh -File tools/prod-check.ps1 -SkipBrowser           # без браузера (быстро, для частых проверок)
#   pwsh -File tools/prod-check.ps1 -ExpectedSha 4600aad   # заодно сверить развёрнутый коммит
#
# Печатает по строке на проверку и числа вместо полных ответов: тяжёлый JSON слоя разбирается,
# а браузерная проверка складывает свой отчёт в data/processed/prod-smoke.json.
[CmdletBinding()]
param(
    [string]$BaseUrl = $(if ($env:PROD_URL) { $env:PROD_URL } else { 'https://201.34.158.13.sslip.io' }),
    [switch]$SkipBrowser,
    [string]$ExpectedSha = '',
    [string]$City = 'tomsk',
    [string]$Category = 'cafe'
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $repoRoot 'frontend'
$logDir = Join-Path $repoRoot 'data\processed'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# `PROD_URL` может прийти со строкой запроса (его использует prod-smoke для карты): для запросов к API
# берём только origin, иначе вместо JSON прилетит HTML страницы
$BaseUrl = ([System.Uri]$BaseUrl).GetLeftPart([System.UriPartial]::Authority)

$script:failures = @()

function Get-Api {
    param([string]$Url)
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec 60 -UseBasicParsing
        $watch.Stop()
        return [pscustomobject]@{
            Status  = $response.StatusCode
            Seconds = [math]::Round($watch.Elapsed.TotalSeconds, 2)
            Bytes   = $response.RawContentLength
            Json    = ($response.Content | ConvertFrom-Json)
        }
    }
    catch {
        $watch.Stop()
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        return [pscustomobject]@{ Status = $status; Seconds = [math]::Round($watch.Elapsed.TotalSeconds, 2); Bytes = 0; Json = $null }
    }
}

function Report {
    param([string]$Line, [bool]$Ok)
    $mark = if ($Ok) { 'ок  ' } else { 'ПЛОХ' }
    $color = if ($Ok) { 'DarkGray' } else { 'Red' }
    Write-Host ("  {0} {1}" -f $mark, $Line) -ForegroundColor $color
    if (-not $Ok) { $script:failures += $Line }
}

Write-Host "Проверка прода: $BaseUrl" -ForegroundColor Cyan

$health = Get-Api "$BaseUrl/healthz"
Report ("/healthz — {0} за {1} с" -f $health.Status, $health.Seconds) ($health.Status -eq 200)

$ready = Get-Api "$BaseUrl/readyz"
Report ("/readyz — {0}" -f $ready.Status) ($ready.Status -eq 200)

$version = Get-Api "$BaseUrl/version"
$sha = if ($version.Json) { $version.Json.git_sha } else { '—' }
$shaOk = $true
if ($ExpectedSha) { $shaOk = ($sha -eq $ExpectedSha) }
Report ("/version — коммит {0}{1}" -f $sha, $(if ($ExpectedSha) { " (ожидался $ExpectedSha)" } else { '' })) $shaOk

$registry = Get-Api "$BaseUrl/api/v1/layers?city=$City"
$layers = @($registry.Json.layers)
$firstLayer = if ($layers.Count -gt 0) { $layers[0].slug } else { '—' }
Report ("слои — {0} шт, первый {1}, версия данных {2}" -f $layers.Count, $firstLayer, $registry.Json.data_version) ($registry.Status -eq 200 -and $layers.Count -gt 0)

$cells = Get-Api "$BaseUrl/api/v1/layers/competitors/cells?city=$City&category=$Category&res=9"
if ($cells.Json -and $cells.Json.meta) {
    $meta = $cells.Json.meta
    Report (
        "слой competitors/{0} — {1} ячеек, непустых {2}, максимум {3} {4}, версия {5} ({6} с, {7} КБ)" -f
        $Category, $meta.cell_count, $meta.non_empty_count, $meta.max_value, $meta.unit, $meta.data_version,
        $cells.Seconds, [math]::Round($cells.Bytes / 1024)
    ) ($cells.Status -eq 200 -and $meta.cell_count -gt 1000 -and $meta.non_empty_count -gt 0)
}
else {
    Report ("слой competitors/{0} — ответ {1} без данных" -f $Category, $cells.Status) $false
}

$legacy = Get-Api "$BaseUrl/api/v1/cells?city=$City&category=$Category&res=9"
Report ("старый /cells — {0} ({1} с); контракт совместим" -f $legacy.Status, $legacy.Seconds) ($legacy.Status -eq 200)

# Остальные слои (Этап 9): проверяем, что данные дошли до каждого. Пустой слой — предупреждение, а не
# провал: сразу после выката слои есть в реестре, а метрик у них нет, пока не прошёл переимпорт
$empty = @()
foreach ($layer in $layers) {
    if ($layer.slug -eq 'competitors') { continue }
    $response = Get-Api "$BaseUrl/api/v1/layers/$($layer.slug)/cells?city=$City&res=9"
    if ($response.Status -ne 200) {
        $empty += $layer.slug
        Write-Host ("  --   слой {0} — метрик нет ({1})" -f $layer.slug, $response.Status) -ForegroundColor Yellow
        continue
    }
    $layerMeta = $response.Json.meta
    Report (
        "слой {0} — непустых {1}, максимум {2} {3}" -f
        $layer.slug, $layerMeta.non_empty_count, $layerMeta.max_value, $layerMeta.unit
    ) ($layerMeta.non_empty_count -gt 0)
}
if ($empty.Count -gt 0) {
    Write-Host ("  --   без данных: {0} (нужен переимпорт выгрузки)" -f ($empty -join ', ')) -ForegroundColor Yellow
}

if (-not $SkipBrowser) {
    $smokeJson = Join-Path $logDir 'prod-smoke.json'
    $smokeErr = Join-Path $logDir 'prod-smoke.err.log'
    Push-Location $frontend
    try {
        $env:PROD_URL = "$BaseUrl/?city=$City&category=$Category&debug=1"
        & node 'scripts/prod-smoke.mjs' 1> $smokeJson 2> $smokeErr
        $code = $LASTEXITCODE
    }
    finally {
        Remove-Item Env:\PROD_URL -ErrorAction SilentlyContinue
        Pop-Location
    }
    $smoke = $null
    try { $smoke = Get-Content $smokeJson -Raw | ConvertFrom-Json } catch { $smoke = $null }

    # Сразу после деплоя web-контейнер ещё прогревается (Next тянет стили и воркер карты), и браузерная
    # проверка успевает упасть по таймауту — через минуту тот же прогон проходит. Поэтому одна повторная
    # попытка: иначе выкат «падает» на ровном месте и перестаёт быть сигналом о реальной проблеме
    if ($code -ne 0 -or -not $smoke) {
        Write-Host '  ..   браузерная проверка не прошла, повтор через 20 с (прогрев после деплоя)' -ForegroundColor Yellow
        Start-Sleep -Seconds 20
        Push-Location $frontend
        try {
            $env:PROD_URL = "$BaseUrl/?city=$City&category=$Category&debug=1"
            & node 'scripts/prod-smoke.mjs' 1> $smokeJson 2> $smokeErr
            $code = $LASTEXITCODE
        }
        finally {
            Remove-Item Env:\PROD_URL -ErrorAction SilentlyContinue
            Pop-Location
        }
        try { $smoke = Get-Content $smokeJson -Raw | ConvertFrom-Json } catch { $smoke = $null }
    }

    if ($smoke) {
        $problems = @($smoke.problems)
        Report (
            "браузер — ячеек в источнике {0}, отрисовано {1}, проблем {2}" -f
            $smoke.cellsInSource, $smoke.renderedCells, $problems.Count
        ) ($code -eq 0 -and $problems.Count -eq 0 -and $smoke.renderedCells -gt 0)
        if ($problems.Count -gt 0) { $problems | ForEach-Object { "      $_" } | Write-Host -ForegroundColor Red }
    }
    else {
        Report "браузер — не удалось разобрать отчёт (см. data\processed\prod-smoke.json)" $false
    }
}
else {
    Write-Host '  --   браузерная проверка пропущена (-SkipBrowser)' -ForegroundColor Yellow
}

Write-Host ''
if ($script:failures.Count -gt 0) {
    Write-Host ("ИТОГ: проблем — {0}" -f $script:failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'ИТОГ: прод отвечает, числа на месте.' -ForegroundColor Green
exit 0
