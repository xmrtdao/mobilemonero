# Restore the XMRT stack after the face-service dataset run.
#
# Nothing is deleted or reinstalled - the services are started exactly as the
# supervisor starts them. If the machine reboots, the supervisor comes back on
# its own via the logon scheduled task and this script is unnecessary.
#
# Usage (PowerShell):
#   .\relay\restore-stack.ps1
#   .\relay\restore-stack.ps1 -Verify   # report only, start nothing

param([switch]$Verify)

$ErrorActionPreference = 'Continue'
$root = 'C:\Users\PureTrek\Desktop\xmrtdao'
$supervisorCmd = '"C:\Program Files\nodejs\node.exe" ' + (Join-Path $root 'supervisor.mjs') + ' --serve'

$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'supervisor\.mjs' } | Select-Object -First 1

if ($existing) {
  Write-Host "  supervisor already running (pid $($existing.ProcessId)) - nothing to do"
  exit 0
}

if ($Verify) {
  Write-Host "  -Verify: supervisor is NOT running. Command would be:"
  Write-Host "    $supervisorCmd"
  exit 0
}

Write-Host "  starting supervisor..."
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList (Join-Path $root 'supervisor.mjs'), '--serve' `
  -WorkingDirectory $root -WindowStyle Hidden

# The supervisor adopts any already-running service rather than starting a
# second copy, so give it a few ticks to respawn the children.
$ok = $false
for ($i = 0; $i -lt 24; $i++) {
  Start-Sleep -Seconds 5
  try {
    $h = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 4 -UseBasicParsing
    if ($h.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
}

if ($ok) {
  Write-Host "  relay is back up"
} else {
  Write-Host "  relay did not answer within 120s - check the supervisor log"
}

Start-Sleep -Seconds 5
try {
  $s = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/api/supervisor/status' -TimeoutSec 8 -UseBasicParsing |
        Select-Object -ExpandProperty Content | ConvertFrom-Json
  $up = @($s.services | Where-Object { $_.healthy }).Count
  Write-Host "  services healthy: $up of $($s.services.Count)"
  $s.services | ForEach-Object {
    $mark = if ($_.healthy) { 'ok  ' } else { 'DOWN' }
    Write-Host ("    {0} {1,-24} pid {2}" -f $mark, $_.name, $_.pid)
  }
} catch {
  Write-Host "  could not read service status: $($_.Exception.Message)"
}