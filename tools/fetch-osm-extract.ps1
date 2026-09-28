# Загрузка выгрузки OSM (Geofabrik) параллельными диапазонами через один curl --parallel.
#
# Зачем: одиночное соединение к Geofabrik даёт ~0.35 МБ/с (проверено 28.09.2026),
# 16 параллельных диапазонов — в разы быстрее. Скрипт нужен и для разведки данных
# (Этап 0.5), и для регулярного импорта (Этап 2).
#
# Пример:
#   pwsh -File tools/fetch-osm-extract.ps1 -OutFile data/raw/siberian-fed-district-260927.osm.pbf

[CmdletBinding()]
param(
    [string]$Url = 'https://download.geofabrik.de/russia/siberian-fed-district-latest.osm.pbf',
    [Parameter(Mandatory = $true)][string]$OutFile,
    [int]$Parts = 6,
    [switch]$SkipChecksum
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$outPath = [System.IO.Path]::GetFullPath($OutFile)
$outDir = Split-Path -Parent $outPath
$partsDir = "$outPath.parts"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 1. Узнаём финальный URL (после редиректа на датированный файл) и размер
$head = Invoke-WebRequest -Uri $Url -Method Head -MaximumRedirection 5
$finalUrl = $head.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
$total = [int64]($head.Headers['Content-Length'] | Select-Object -Last 1)

Write-Host "Источник : $finalUrl"
Write-Host "Размер   : $([math]::Round($total / 1MB, 1)) МБ, частей: $Parts"

if ((Test-Path $outPath) -and ((Get-Item $outPath).Length -eq $total)) {
    Write-Host "Файл уже скачан и совпадает по размеру: $outPath"
    exit 0
}

# 2. Планируем части и качаем их одним curl с --parallel
New-Item -ItemType Directory -Force -Path $partsDir | Out-Null
$chunk = [int64][math]::Ceiling($total / [double]$Parts)
$plan = @()
# Глобальные опции curl должны идти ПЕРЕД группами передач, иначе они применяются
# только к последней группе и загрузка идёт последовательно.
$curlArgs = @('--parallel', '--parallel-max', "$Parts")
$groups = 0

for ($index = 0; $index -lt $Parts; $index++) {
    $start = [int64]($index * $chunk)
    if ($start -ge $total) { break }

    $end = [int64][math]::Min($start + $chunk - 1, $total - 1)
    $expected = [int64]($end - $start + 1)
    $partPath = Join-Path $partsDir ('part-{0:d3}' -f $index)
    $plan += [pscustomobject]@{ Path = $partPath; Expected = $expected }

    if (-not ((Test-Path $partPath) -and ((Get-Item $partPath).Length -eq $expected))) {
        if ($groups -gt 0) { $curlArgs += '--next' }
        # --speed-limit/--speed-time — детектор «залипания»: соединение, которое отдаёт меньше
        # 20 КБ/с в течение 20 с, обрывается и повторяется (наблюдали зависание 28.09.2026).
        $curlArgs += @(
            '-sL', '--connect-timeout', '20', '--max-time', '3600',
            '--speed-limit', '20000', '--speed-time', '20',
            '--retry', '8', '--retry-delay', '5', '--retry-all-errors',
            '-o', $partPath, '-r', "$start-$end", $finalUrl
        )
        $groups += 1
    }
}

if ($groups -eq 0) {
    Write-Host 'Все части уже скачаны.'
}
else {
    Write-Host "Качаю $groups частей в $Parts поток(ов)..."
    & curl.exe @curlArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "curl вернул код $LASTEXITCODE — проверяю размеры частей"
    }
}

# 3. Проверяем части: недокачанные удаляем и предлагаем повторить запуск
$incomplete = $plan | Where-Object {
    -not (Test-Path $_.Path) -or ((Get-Item $_.Path).Length -ne $_.Expected)
}
if ($incomplete) {
    $incomplete | ForEach-Object {
        $actualPart = (Get-Item $_.Path -ErrorAction SilentlyContinue).Length
        Write-Host "Часть не докачана: $(Split-Path $_.Path -Leaf) — $actualPart из $($_.Expected) байт"
        Remove-Item $_.Path -Force -ErrorAction SilentlyContinue
    }
    throw 'Загрузка неполная: запустите скрипт повторно, недостающие части докачаются.'
}

# 4. Сборка: потоковая конкатенация частей по порядку (без cmd и ограничений по длине пути)
if (Test-Path $outPath) { Remove-Item $outPath -Force }
$outStream = [System.IO.File]::Create($outPath)
try {
    foreach ($part in $plan) {
        $inStream = [System.IO.File]::OpenRead($part.Path)
        try { $inStream.CopyTo($outStream, 1MB) } finally { $inStream.Dispose() }
    }
}
finally { $outStream.Dispose() }

$actualSize = (Get-Item $outPath).Length
if ($actualSize -ne $total) {
    throw "Размер не совпал: ожидалось $total байт, получено $actualSize"
}

# 5. Контрольная сумма: Geofabrik публикует .md5 рядом с датированным файлом
if (-not $SkipChecksum) {
    $md5raw = & curl.exe -sL --max-time 60 "$finalUrl.md5" | Out-String
    $expectedMd5 = ($md5raw.Trim() -split '\s+')[0]
    if ($expectedMd5 -match '^[0-9a-fA-F]{32}$') {
        $actualMd5 = (Get-FileHash -Path $outPath -Algorithm MD5).Hash
        if ($actualMd5 -ne $expectedMd5.ToUpperInvariant()) {
            throw "MD5 не совпал: ожидался $expectedMd5, получен $actualMd5"
        }
        Write-Host "MD5 совпал: $actualMd5"
    }
    else {
        Write-Host 'MD5 недоступен — проверка контрольной суммы пропущена'
    }
}

Remove-Item -Recurse -Force $partsDir
Write-Host "Готово: $outPath ($([math]::Round($actualSize / 1MB, 1)) МБ)"
