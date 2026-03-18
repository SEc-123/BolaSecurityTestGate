param(
  [switch]$Foreground,
  [switch]$NoClean,
  [string]$BaseUrl = $(if ($env:BSTG_BASE_URL) { $env:BSTG_BASE_URL } else { 'http://127.0.0.1:3001' }),
  [int]$HealthRetries = 30,
  [int]$HealthDelaySeconds = 2
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$npmPath = (Get-Command npm -ErrorAction Stop).Source
$nodePath = (Get-Command node -ErrorAction Stop).Source
$pidFile = Join-Path $PSScriptRoot '.bstg-server.pid'
$logDir = Join-Path $PSScriptRoot 'logs'
$outLog = Join-Path $logDir 'server.out.log'
$errLog = Join-Path $logDir 'server.err.log'

function Invoke-Step([string]$Name, [scriptblock]$Action) {
  Write-Host "==> $Name" -ForegroundColor Cyan
  $global:LASTEXITCODE = 0
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

function Remove-IfExists([string]$PathValue) {
  if (Test-Path $PathValue) {
    Remove-Item -Recurse -Force $PathValue
  }
}

function Stop-BstgIfRunning {
  if (-not (Test-Path $pidFile)) { return }
  try {
    $existingPid = [int](Get-Content $pidFile | Select-Object -First 1)
    if ($existingPid) {
      Stop-Process -Id $existingPid -Force -ErrorAction Stop
      Write-Host "Stopped stale BSTG server pid=$existingPid" -ForegroundColor Yellow
    }
  } catch {
    Write-Warning "Could not stop stale pid from $pidFile. It may already be gone."
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Stop-BstgIfRunning

if (-not $NoClean) {
  Write-Host '==> Cleaning bundled dependencies and build output' -ForegroundColor Cyan
  Remove-IfExists (Join-Path $PSScriptRoot 'node_modules')
  Remove-IfExists (Join-Path $PSScriptRoot 'server\node_modules')
  Remove-IfExists (Join-Path $PSScriptRoot 'dist')
  Remove-IfExists (Join-Path $PSScriptRoot 'server\dist')
}

Invoke-Step 'Installing root dependencies' { & $npmPath 'ci' '--ignore-scripts' '--no-audit' '--fund=false' }
Invoke-Step 'Installing server dependencies' {
  Push-Location (Join-Path $PSScriptRoot 'server')
  try {
    & $npmPath 'ci' '--no-audit' '--fund=false'
  } finally {
    Pop-Location
  }
}
Invoke-Step 'Verifying native runtime dependencies' { & $nodePath '.\scripts\verify-runtime.mjs' }
Invoke-Step 'Building frontend and backend' { & $npmPath 'run' 'build' }
Invoke-Step 'Auditing frontend/backend routes' { & $nodePath '.\scripts\route-audit.mjs' }

if ($Foreground) {
  Invoke-Step 'Starting server in foreground' { & $nodePath '.\scripts\start-server.mjs' }
  exit 0
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$serverEntry = Join-Path $PSScriptRoot 'scripts\start-server.mjs'
if (-not (Test-Path $serverEntry)) {
  throw "Server entry not found: $serverEntry"
}

Write-Host '==> Starting server in background' -ForegroundColor Cyan
$proc = Start-Process -FilePath $nodePath -ArgumentList @($serverEntry) -WorkingDirectory $PSScriptRoot -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
Write-Host "Started BSTG server pid=$($proc.Id)" -ForegroundColor Green
Write-Host "Logs: $outLog / $errLog"

try {
  Invoke-Step 'Running post-deploy checks' { & $nodePath '.\scripts\post-deploy-check.mjs' '--base-url' $BaseUrl '--retries' $HealthRetries '--delay-ms' ($HealthDelaySeconds * 1000) }
  Write-Host 'Deployment finished successfully.' -ForegroundColor Green
} catch {
  Write-Warning 'Post-deploy checks failed. Showing recent server logs:'
  if (Test-Path $errLog) { Get-Content $errLog -Tail 80 }
  if (Test-Path $outLog) { Get-Content $outLog -Tail 80 }
  try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  throw
}
