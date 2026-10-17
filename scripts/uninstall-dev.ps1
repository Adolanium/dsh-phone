#requires -Version 7.0
<#
.SYNOPSIS
  Remove the development link and Loader entry for dsh-plugin-phone-bridge.

.DESCRIPTION
  Windows counterpart to scripts/uninstall-dev.sh. Removes only a junction or
  symlink that points at this checkout, and only this plugin's Loader block.
  A timestamped backup is written before the patch is edited.
#>
[CmdletBinding()]
param(
  [string]$ProfileRoot = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-plugin-phone-bridge'
$pluginId = 'phone-bridge'
$patchPath = Join-Path $ProfileRoot 'cordis.patch.yml'
$linkPath = Join-Path (Join-Path $ProfileRoot 'node_modules') $packageName

if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
    Remove-Item -LiteralPath $linkPath -Force
    Write-Host "Removed link $linkPath"
  } else {
    Write-Warning "$linkPath is a real directory; left it alone."
  }
} else {
  Write-Host "No link at $linkPath"
}

if (Test-Path -LiteralPath $patchPath) {
  $patch = Get-Content -LiteralPath $patchPath -Raw
  $commented = @"
# $packageName development link (scripts/install-dev.ps1)
- insert:
    - id: $pluginId
      name: $packageName
"@
  $bare = @"
- insert:
    - id: $pluginId
      name: $packageName
"@
  $updated = $patch.Replace($commented, '').Replace($bare, '')
  $updated = ($updated -replace "(\r?\n){3,}", "`n`n").TrimEnd()
  # A comments-only patch is not a YAML sequence; restore the template's [].
  if ($updated -notmatch '(?m)^\s*-\s+\S') {
    $updated += "`n[]"
  }
  $updated += "`n"
  if ($updated -ne $patch) {
    $stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
    Copy-Item -LiteralPath $patchPath -Destination "$patchPath.bak-$stamp"
    Set-Content -LiteralPath $patchPath -Value $updated -NoNewline
    Write-Host "Removed the Loader entry from $patchPath (backup: $patchPath.bak-$stamp)"
  } else {
    Write-Host 'No managed Loader block found in the profile patch'
  }
}

Write-Host 'Done. If 8787 remains, restart DeepSeek Harness when no turn or job is running.'
