$ErrorActionPreference = 'Stop'
$version = 'v1.19.32'
$asset = "mihomo-windows-amd64-v2-$version.zip"
$archiveHash = '1ee9e6a30c4ba3ba4eb6f0bc7027fe77016a4471eb851a03d44841e3313d4012'
$buildInfo = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../src-tauri/windows/Mihomo-build-info.txt') -Raw
if ($buildInfo -notmatch '(?m)^mihomo\.exe SHA-256: ([0-9a-f]{64})\s*$') { throw 'Invalid Mihomo build info' }
$exeHash = $Matches[1]
$cache = Join-Path $PSScriptRoot '../.cache/air/windows-x64'
$exe = Join-Path $cache 'mihomo.exe'
if ((Test-Path -LiteralPath $exe) -and (Get-FileHash -LiteralPath $exe).Hash -eq $exeHash) { return }
New-Item -Path $cache -ItemType Directory -Force | Out-Null
$id = [Guid]::NewGuid().ToString('N')
$archive = Join-Path $cache "$id.zip"
$partial = Join-Path $cache "$id.partial"
try {
    $url = "https://github.com/MetaCubeX/mihomo/releases/download/$version/$asset"
    Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 180 -UseBasicParsing
    if ((Get-FileHash -LiteralPath $archive).Hash -ne $archiveHash) { throw "SHA-256 mismatch for $asset" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $entry = $zip.GetEntry('mihomo-windows-amd64-v2.exe')
        if (!$entry) { throw 'Missing Mihomo executable in archive' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $partial)
    } finally {
        $zip.Dispose()
    }
    if ((Get-FileHash -LiteralPath $partial).Hash -ne $exeHash) { throw 'SHA-256 mismatch for mihomo.exe' }
    Move-Item -LiteralPath $partial -Destination $exe -Force
} finally {
    foreach ($file in @($archive, $partial)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
}
