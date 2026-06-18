$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$pidFile = Join-Path $PSScriptRoot '.bstg-server.pid'
if (-not (Test-Path $pidFile)) {
  Write-Host 'No PID file found. Nothing to stop.'
  exit 0
}
$pid = [int](Get-Content $pidFile | Select-Object -First 1)
if (-not $pid) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'PID file was invalid and has been removed.'
  exit 0
}
try {
  Stop-Process -Id $pid -Force -ErrorAction Stop
  Write-Host "Stopped BSTG server pid=$pid"
} catch {
  Write-Warning "Could not stop pid=$pid. It may already be gone."
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
