[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$root = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
$separator = [IO.Path]::DirectorySeparatorChar
$prefix = $root.TrimEnd($separator) + $separator
$directories = @(
    'dist', 'src-tauri/gen/schemas',
    'src-tauri/target/debug', 'src-tauri/target/release', 'src-tauri/target/tmp',
    'src-tauri/target/doc', 'src-tauri/target/x86_64-pc-windows-gnu', 'src-tauri/target/x86_64-pc-windows-msvc',
    'android/.gradle', 'android/.kotlin', 'android/build', 'android/app/build',
    'node_modules/.vite', 'node_modules/.vite-temp', 'scripts/__pycache__'
)
$metadata = @('src-tauri/target/.rustc_info.json', 'src-tauri/target/CACHEDIR.TAG')

function Get-OutputSize([IO.DirectoryInfo]$Directory) {
    $pending = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
    $pending.Push($Directory)
    [long]$bytes = 0
    while ($pending.Count) {
        foreach ($item in $pending.Pop().EnumerateFileSystemInfos()) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Linked file or directory in build output: $($item.FullName)"
            }
            if ($item -is [IO.DirectoryInfo]) { $pending.Push($item) }
            else { $bytes += $item.Length }
        }
    }
    return $bytes
}

$targets = foreach ($relative in ($directories + $metadata)) {
    $path = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (!(Test-Path -LiteralPath $path)) { continue }
    $resolved = (Resolve-Path -LiteralPath $path).ProviderPath
    if (!$resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Build output is outside the workspace: $resolved"
    }
    $item = Get-Item -LiteralPath $resolved -Force
    $isDirectory = $item -is [IO.DirectoryInfo]
    if ($isDirectory -ne ($relative -in $directories) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Unexpected build output type: $resolved"
    }
    $ancestor = if ($isDirectory) { $item } else { $item.Directory }
    for ($parent = $ancestor; $null -ne $parent; $parent = $parent.Parent) {
        if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked directory: $parent" }
        if ($parent.FullName -eq $root) { break }
    }
    $size = if ($isDirectory) { Get-OutputSize $item } else { $item.Length }
    [PSCustomObject]@{ Path = $resolved; Bytes = $size; Directory = $isDirectory }
}

[long]$removed = 0
foreach ($target in $targets) {
    if ($PSCmdlet.ShouldProcess($target.Path, 'Remove generated build output')) {
        Remove-Item -LiteralPath $target.Path -Recurse:$target.Directory -Force
        $removed += $target.Bytes
    }
}
foreach ($relative in @('src-tauri/gen', 'src-tauri/target')) {
    $path = Join-Path $root $relative
    if (!(Test-Path -LiteralPath $path -PathType Container)) { continue }
    $dir = Get-Item -LiteralPath $path -Force
    if (($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($dir.Parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    if (!$dir.GetFileSystemInfos().Length -and $PSCmdlet.ShouldProcess($dir.FullName, 'Remove empty build directory')) {
        [IO.Directory]::Delete($dir.FullName, $false)
    }
}
if (!$WhatIfPreference) { Write-Output ('Removed {0:N1} MiB of generated build output.' -f ($removed / 1MB)) }
