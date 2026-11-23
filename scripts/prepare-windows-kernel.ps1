param([string]$GoExe = 'go.exe')

$ErrorActionPreference = 'Stop'
$buildInfo = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../src-tauri/windows/Mihomo-build-info.txt') -Raw
if ($buildInfo -notmatch '(?m)^mihomo\.exe SHA-256: ([0-9a-f]{64})\s*$') { throw 'Invalid Mihomo build info' }
$exeHash = $Matches[1]
$cache = Join-Path $PSScriptRoot '../.cache/air/windows-x64'
$wintun = @(
    @{
        Name = 'wintun.dll'
        Url = 'https://raw.githubusercontent.com/MetaCubeX/sing-tun/v0.4.27/internal/wintun/amd64/wintun.dll'
        Sha256 = 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce'
    },
    @{
        Name = 'Wintun-LICENSE.txt'
        Url = 'https://raw.githubusercontent.com/WireGuard/wintun/0.14.1/prebuilt-binaries-license.txt'
        Sha256 = '9aaf948856ce8845a762121306039ef09d0eeb4d9e4f4c355647d4081e818087'
    }
)
New-Item -Path $cache -ItemType Directory -Force | Out-Null
foreach ($item in $wintun) {
    $destination = Join-Path $cache $item.Name
    if ((Test-Path -LiteralPath $destination) -and (Get-FileHash -LiteralPath $destination).Hash -eq $item.Sha256) { continue }
    $download = Join-Path $cache "$([Guid]::NewGuid().ToString('N')).partial"
    try {
        Invoke-WebRequest -Uri $item.Url -OutFile $download -TimeoutSec 60 -UseBasicParsing
        if ((Get-FileHash -LiteralPath $download).Hash -ne $item.Sha256) { throw "SHA-256 mismatch for $($item.Name)" }
        Move-Item -LiteralPath $download -Destination $destination -Force
    } finally {
        if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download }
    }
}
$exe = Join-Path $cache 'mihomo.exe'
if ((Test-Path -LiteralPath $exe) -and (Get-FileHash -LiteralPath $exe).Hash -eq $exeHash) { return }
$partial = Join-Path $cache "$([Guid]::NewGuid().ToString('N')).partial"
try {
    & (Join-Path $PSScriptRoot 'build-windows-mihomo.ps1') -GoExe $GoExe -Output $partial
    if ((Get-FileHash -LiteralPath $partial).Hash -ne $exeHash) { throw 'SHA-256 mismatch for mihomo.exe' }
    Move-Item -LiteralPath $partial -Destination $exe -Force
} finally {
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
}
