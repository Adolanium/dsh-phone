#requires -Version 7.0
<#
.SYNOPSIS
  Link dsh-plugin-phone-bridge into a DSH Desktop profile for development.

.DESCRIPTION
  Windows counterpart to scripts/install-dev.sh. Creates a directory junction
  in the profile's node_modules and adds the plugin's Loader entry to the
  profile patch, replacing an empty `[]` patch instead of appending after it.
  Every edit is preceded by a timestamped backup.

  The desktop Host may hot-load the patch. If port 8787 does not appear,
  restart DeepSeek Harness when no turn or job is running.

  Pair from the iPhone app or Settings → Phone after the Host reloads.
#>
[CmdletBinding()]
param(
  [string]$ProfileRoot = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$PackagePath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'packages\dsh-plugin-phone-bridge')
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-plugin-phone-bridge'
$pluginId = 'phone-bridge'
$patchPath = Join-Path $ProfileRoot 'cordis.patch.yml'
$nodeModules = Join-Path $ProfileRoot 'node_modules'
$linkPath = Join-Path $nodeModules $packageName

foreach ($required in @(
  (Join-Path $PackagePath 'package.json'),
  (Join-Path $PackagePath 'lib\index.js'),
  (Join-Path $PackagePath 'lib\client.js'),
  (Join-Path $PackagePath 'cordis.patch.yml')
)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Not a complete plugin checkout: missing $required"
  }
}
if (-not (Test-Path -LiteralPath $patchPath)) {
  throw "No profile patch at $patchPath. Is '$ProfileRoot' a DSH Desktop profile?"
}

New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null

if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -in @('Junction', 'SymbolicLink') -and $item.Target -eq (Resolve-Path -LiteralPath $PackagePath).Path) {
    Write-Host "Link already present: $linkPath"
  } else {
    throw "Refusing to replace existing $linkPath (LinkType=$($item.LinkType)). Remove it manually if it is a stale link."
  }
} else {
  New-Item -ItemType Junction -Path $linkPath -Target (Resolve-Path -LiteralPath $PackagePath).Path | Out-Null
  Write-Host "Linked $linkPath -> $PackagePath"
}

$patch = Get-Content -LiteralPath $patchPath -Raw
if ($patch -match [regex]::Escape("name: $packageName")) {
  Write-Host "Loader entry already present in $patchPath"
} else {
  $stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
  Copy-Item -LiteralPath $patchPath -Destination "$patchPath.bak-$stamp"
  $block = @"
# $packageName development link (scripts/install-dev.ps1)
- insert:
    - id: $pluginId
      name: $packageName
"@
  if ($patch -match '(?m)^\[\]\s*$') {
    $updated = ($patch -replace '(?m)^\[\]\s*$', '').TrimEnd() + "`n`n" + $block
  } else {
    $updated = $patch.TrimEnd() + "`n`n" + $block
  }
  Set-Content -LiteralPath $patchPath -Value $updated -NoNewline
  Write-Host "Added the Loader entry to $patchPath (backup: $patchPath.bak-$stamp)"
}

Write-Host ''
Write-Host 'Next:'
Write-Host '  1. Watch the Host log for phone-bridge activation errors.'
Write-Host '  2. Check the listener: Get-NetTCPConnection -LocalPort 8787'
Write-Host '  3. Open Settings -> Phone for the QR, pairing code, devices, and diagnostics.'
Write-Host '     The listener returns 401 until a device is paired. The iPhone app lives in apps/ios.'
Write-Host '  4. Undo with scripts/uninstall-dev.ps1.'
