param(
    [Parameter(Mandatory = $true)][string]$Output,
    [string]$GoExe = 'go.exe'
)

$ErrorActionPreference = 'Stop'
$revision = '88dcbf7f1614a67c3b36b848ee3592dfa92ada36'
$sourceSha256 = '63ad2b98fb7a1067422af350a172e2c656c45a2564d0202b5181c6dc4cc7dd30'
$go = (Get-Command $GoExe -CommandType Application).Source
$outputPath = [IO.Path]::GetFullPath($Output)
$outputDir = Split-Path -Parent $outputPath
New-Item -Path $outputDir -ItemType Directory -Force | Out-Null
$work = Join-Path $outputDir ('.mihomo-' + [Guid]::NewGuid().ToString('N'))
New-Item -Path $work -ItemType Directory | Out-Null

$goOptions = @{
    GIT_CEILING_DIRECTORIES = $work
    GOTOOLCHAIN = 'local'
    GOENV = 'off'
    GOFLAGS = ''
    GOWORK = 'off'
    GOOS = 'windows'
    GOARCH = 'amd64'
    GOAMD64 = 'v2'
    CGO_ENABLED = '0'
}
$previous = @{}
try {
    foreach ($name in $goOptions.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $goOptions[$name], 'Process')
    }
    if ((& $go version) -ne 'go version go1.26.8 windows/amd64') {
        throw 'Building the Windows Mihomo binary requires Go 1.26.8 for Windows x64.'
    }

    $archive = Join-Path $work 'mihomo.zip'
    Invoke-WebRequest -Uri "https://codeload.github.com/MetaCubeX/mihomo/zip/$revision" -OutFile $archive -TimeoutSec 120 -UseBasicParsing
    if ((Get-FileHash -LiteralPath $archive).Hash -ne $sourceSha256) {
        throw 'Mihomo source archive SHA-256 mismatch.'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $work
    Push-Location (Join-Path $work "mihomo-$revision")
    try {
        $module = & $go mod download -json 'github.com/metacubex/sing-tun@v0.4.27'
        if ($LASTEXITCODE -ne 0) { throw 'Could not download the pinned sing-tun module.' }
        $source = ($module -join "`n" | ConvertFrom-Json).Dir
        $patchedModule = Join-Path (Get-Location).Path 'sing-tun-local'
        Copy-Item -LiteralPath $source -Destination $patchedModule -Recurse
        $patch = Join-Path $patchedModule 'tun_windows.go'
        $text = [IO.File]::ReadAllText($patch)
        $original = @'
	adapter, err := wintun.CreateAdapter(options.Name, TunnelType, generateGUIDByDeviceName(options.Name))
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		createErr := err
		adapter, err = wintun.OpenAdapter(options.Name)
		if err != nil {
			return nil, E.Errors(E.Cause(createErr, "create adapter"), E.Cause(err, "open existing adapter"))
		}
	}
'@
        $replacement = @'
	requestedGUID := generateGUIDByDeviceName(options.Name)
	var adapter *wintun.Adapter
	var err error
	if options.Name == "Air-TUN" {
		adapter, err = wintun.OpenAdapter(options.Name)
	}
	if adapter == nil {
		adapter, err = wintun.CreateAdapter(options.Name, TunnelType, requestedGUID)
		if err != nil {
			if !errors.Is(err, os.ErrExist) && !errors.Is(err, 0x80070000|windows.ERROR_ALREADY_EXISTS) {
				return nil, err
			}
			createErr := err
			adapter, err = wintun.OpenAdapter(options.Name)
			if err != nil {
				return nil, E.Errors(E.Cause(createErr, "create adapter"), E.Cause(err, "open existing adapter"))
			}
		}
	}
	if options.Name == "Air-TUN" {
		guid, err := winipcfg.LUID(adapter.LUID()).GUID()
		if err != nil || *guid != *requestedGUID {
			adapter.Close()
			return nil, fmt.Errorf("Wintun adapter %q does not match the requested interface GUID", options.Name)
		}
	}
'@
        $original = $original.Replace("`r`n", "`n")
        $replacement = $replacement.Replace("`r`n", "`n")
        if ([regex]::Matches($text, [regex]::Escape($original)).Count -ne 1) {
            throw 'The pinned sing-tun Windows adapter check did not match.'
        }
        # Air's TUN service already holds this adapter. Open it directly to skip driver installation work.
        $utf8 = [Text.UTF8Encoding]::new($false)
        (Get-Item -LiteralPath $patch).IsReadOnly = $false
        [IO.File]::WriteAllText($patch, $text.Replace($original, $replacement), $utf8)
        & $go mod edit '-replace=github.com/metacubex/sing-tun=./sing-tun-local'
        if ($LASTEXITCODE -ne 0) { throw 'Could not select the patched sing-tun module.' }

        $ipv6Patch = Join-Path $work 'ipv6.patch'
        $patchText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mihomo-windows-ipv6.patch'))
        [IO.File]::WriteAllText($ipv6Patch, $patchText.Replace("`r`n", "`n"), $utf8)
        & git apply --whitespace=error $ipv6Patch
        if ($LASTEXITCODE -ne 0) { throw 'The IPv6 patch did not apply to the pinned Mihomo source.' }

        $binary = Join-Path $work 'mihomo.exe'
        $ldflags = '-s -w -buildid= -X github.com/metacubex/mihomo/constant.Version=v1.19.32-air.3 -X github.com/metacubex/mihomo/constant.BuildTime=2026-09-30T17:00:11Z'
        & $go build -mod=readonly -buildvcs=false -trimpath -tags with_gvisor -ldflags $ldflags -o $binary .
        if ($LASTEXITCODE -ne 0) { throw 'Mihomo build failed.' }
        Move-Item -LiteralPath $binary -Destination $outputPath -Force
    } finally {
        Pop-Location
    }
} finally {
    foreach ($name in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
    $resolved = (Resolve-Path -LiteralPath $work).Path
    if ($resolved.StartsWith($outputDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
