[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9A-Fa-f]{40}$')]
    [string]$CertificateThumbprint,
    [ValidateNotNullOrEmpty()]
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [string]$SignFile
)

$ErrorActionPreference = 'Stop'

function Sign-AirBinary([string]$Path) {
    # These inputs are pinned by SHA-256 for the TUN installer.
    if ([IO.Path]::GetFileName($Path) -in @('mihomo.exe', 'WebView2Loader.dll', 'wintun.dll')) {
        return
    }
    $tool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
    if (-not $tool) {
        $tool = Get-ChildItem -Path "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/signtool.exe" -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $tool) { throw 'Install SignTool from the Windows SDK before signing.' }

    & $tool sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $Path
    if ($LASTEXITCODE -ne 0) { throw "SignTool failed for $Path ($LASTEXITCODE)." }
    $signature = Get-AuthenticodeSignature -FilePath $Path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $CertificateThumbprint -or
        $null -eq $signature.TimeStamperCertificate) {
        throw "Expected a valid, timestamped Authenticode signature on $Path."
    }
}

# Tauri invokes this entry point for the main executable and NSIS files.
if ($SignFile) {
    Sign-AirBinary $SignFile
    return
}

$certificate = Get-ChildItem Cert:/CurrentUser/My -CodeSigningCert |
    Where-Object Thumbprint -eq $CertificateThumbprint | Select-Object -First 1
$now = Get-Date
if (-not $certificate -or -not $certificate.HasPrivateKey -or $certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
    throw 'A valid code-signing certificate with its private key is required in Cert:/CurrentUser/My.'
}

$repo = Split-Path -Parent $PSScriptRoot
$config = Join-Path ([IO.Path]::GetTempPath()) ('air-signing-' + [Guid]::NewGuid().ToString('N') + '.json')
$signCommand = @{
    cmd = (Get-Process -Id $PID).Path
    args = @('-NoProfile', '-NonInteractive', '-File', $PSCommandPath, '-CertificateThumbprint', $CertificateThumbprint,
        '-TimestampUrl', $TimestampUrl, '-SignFile', '%1')
}
$overrides = @{ bundle = @{ windows = @{ signCommand = $signCommand } } }

Push-Location -LiteralPath $repo
try {
    & ./scripts/prepare-windows-kernel.ps1
    & ./scripts/prepare-windows-service.ps1
    Sign-AirBinary ((Resolve-Path -LiteralPath '.cache/air/windows-x64/air-tun-service.exe').Path)
    & ./scripts/prepare-mihomo-data.ps1
    [IO.File]::WriteAllText($config, ($overrides | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    pnpm tauri build --target x86_64-pc-windows-gnu --config src-tauri/tauri.windows-release.conf.json --config $config
    if ($LASTEXITCODE -ne 0) { throw "Signed Windows build failed ($LASTEXITCODE)." }
} finally {
    if (Test-Path -LiteralPath $config) { Remove-Item -LiteralPath $config }
    Pop-Location
}
