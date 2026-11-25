param([string]$Target = 'x86_64-pc-windows-gnu')

$ErrorActionPreference = 'Stop'
$manifest = Join-Path $PSScriptRoot '../src-tauri/tun-service/Cargo.toml'
$cache = Join-Path $PSScriptRoot '../.cache/air/windows-x64'
$destination = Join-Path $cache 'air-tun-service.exe'
$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (-not (Test-Path -LiteralPath $cargo)) {
    $cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
}

if ($Target -like '*-gnu' -and (Test-Path -LiteralPath 'C:\msys64\mingw64\bin')) {
    $env:PATH = "C:\msys64\mingw64\bin;$env:PATH"
}
if ($Target -eq 'x86_64-pc-windows-gnu' -and -not $env:RUSTUP_TOOLCHAIN) {
    $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
}

$targetDir = if ($env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR
} else {
    Join-Path $PSScriptRoot '../src-tauri/tun-service/target'
}

& $cargo build --manifest-path $manifest --release --target $Target --target-dir $targetDir
if ($LASTEXITCODE -ne 0) {
    throw "cargo build for air-tun-service failed with exit code $LASTEXITCODE"
}

$built = Join-Path $targetDir "$Target\release\air-tun-service.exe"
if (-not (Test-Path -LiteralPath $built)) {
    throw "Missing built binary at $built"
}

New-Item -Path $cache -ItemType Directory -Force | Out-Null
$partial = Join-Path $cache "$([Guid]::NewGuid().ToString('N')).partial"
try {
    Copy-Item -LiteralPath $built -Destination $partial -Force
    Move-Item -LiteralPath $partial -Destination $destination -Force
} finally {
    if (Test-Path -LiteralPath $partial) {
        Remove-Item -LiteralPath $partial
    }
}
