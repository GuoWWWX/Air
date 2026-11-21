$ErrorActionPreference = 'Stop'
$destination = Join-Path $PSScriptRoot '../.cache/air/mihomo-data'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'mihomo-data.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $destination -Force | Out-Null

foreach ($entry in $manifest.sha256.PSObject.Properties) {
    $name = $entry.Name
    $file = Join-Path $destination $name
    $expected = $entry.Value
    if ((Test-Path -LiteralPath $file) -and (Get-FileHash -LiteralPath $file).Hash -eq $expected) {
        continue
    }
    $partial = "$file.$([Guid]::NewGuid().ToString('N')).partial"
    try {
        $url = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/$($manifest.revision)/$name"
        Invoke-WebRequest -Uri $url -OutFile $partial -TimeoutSec 60 -UseBasicParsing
        if ((Get-FileHash -LiteralPath $partial).Hash -ne $expected) {
            throw "SHA-256 mismatch for $name"
        }
        Move-Item -LiteralPath $partial -Destination $file -Force
    } finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
    }
    Write-Output "$name $expected"
}
