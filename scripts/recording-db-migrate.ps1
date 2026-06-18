param(
  [string]$BaseUrl = 'http://127.0.0.1:3001',
  [string]$SourceProfileId = '',
  [string]$TargetProfileId = '',
  [switch]$MigrateTarget,
  [switch]$SwitchToTarget,
  [string]$ExportPath = ''
)

$ErrorActionPreference = 'Stop'

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Url,
    $Body = $null
  )

  $params = @{
    Method = $Method
    Uri = $Url
    UseBasicParsing = $true
  }

  if ($null -ne $Body) {
    $params['ContentType'] = 'application/json'
    $params['Body'] = ($Body | ConvertTo-Json -Depth 50 -Compress)
  }

  try {
    $response = Invoke-WebRequest @params
    return @{
      status = [int]$response.StatusCode
      json = if ($response.Content) { $response.Content | ConvertFrom-Json } else { $null }
    }
  } catch {
    $status = 500
    $content = $_.Exception.Message

    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode.value__
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $content = $reader.ReadToEnd()
      $reader.Close()
    }

    $json = $null
    if ($content) {
      try {
        $json = $content | ConvertFrom-Json
      } catch {
      }
    }

    return @{
      status = $status
      json = $json
      raw = $content
    }
  }
}

function Assert-Status {
  param(
    $Response,
    [int[]]$AllowedStatus,
    [string]$Message
  )

  if ($AllowedStatus -notcontains [int]$Response.status) {
    $details = if ($Response.json -and $Response.json.error) { $Response.json.error } else { $Response.raw }
    throw "$Message (HTTP $($Response.status)): $details"
  }
}

$normalizedBaseUrl = $BaseUrl.TrimEnd('/')
$health = Invoke-JsonRequest -Method 'GET' -Url "$normalizedBaseUrl/health"
Assert-Status -Response $health -AllowedStatus @(200) -Message 'Server health check failed'

$initialStatusResponse = Invoke-JsonRequest -Method 'GET' -Url "$normalizedBaseUrl/admin/db/status"
Assert-Status -Response $initialStatusResponse -AllowedStatus @(200) -Message 'Failed to load initial DB status'
$initialStatus = $initialStatusResponse.json.data

if ($SourceProfileId -and $SourceProfileId -ne $initialStatus.activeProfileId) {
  $switchSource = Invoke-JsonRequest -Method 'POST' -Url "$normalizedBaseUrl/admin/db/switch" -Body @{
    profile_id = $SourceProfileId
  }
  Assert-Status -Response $switchSource -AllowedStatus @(200) -Message 'Failed to switch to source profile'
}

$exportResponse = Invoke-JsonRequest -Method 'POST' -Url "$normalizedBaseUrl/admin/db/export"
Assert-Status -Response $exportResponse -AllowedStatus @(200) -Message 'Failed to export database payload'
$exportData = $exportResponse.json.data

if ($ExportPath) {
  $exportDirectory = Split-Path -Parent $ExportPath
  if ($exportDirectory -and -not (Test-Path $exportDirectory)) {
    New-Item -ItemType Directory -Path $exportDirectory -Force | Out-Null
  }
  $exportData | ConvertTo-Json -Depth 50 | Set-Content -Path $ExportPath -Encoding UTF8
}

$importResponse = $null
$migrateResponse = $null
$switchTargetResponse = $null

if ($TargetProfileId) {
  if ($MigrateTarget) {
    $migrateResponse = Invoke-JsonRequest -Method 'POST' -Url "$normalizedBaseUrl/admin/db/migrate" -Body @{
      profile_id = $TargetProfileId
    }
    Assert-Status -Response $migrateResponse -AllowedStatus @(200) -Message 'Failed to migrate target profile'
  }

  $importResponse = Invoke-JsonRequest -Method 'POST' -Url "$normalizedBaseUrl/admin/db/import" -Body @{
    data = $exportData
    target_profile_id = $TargetProfileId
  }
  Assert-Status -Response $importResponse -AllowedStatus @(200) -Message 'Failed to import payload into target profile'

  if ($SwitchToTarget) {
    $switchTargetResponse = Invoke-JsonRequest -Method 'POST' -Url "$normalizedBaseUrl/admin/db/switch" -Body @{
      profile_id = $TargetProfileId
    }
    Assert-Status -Response $switchTargetResponse -AllowedStatus @(200) -Message 'Failed to switch to target profile'
  }
}

$finalStatusResponse = Invoke-JsonRequest -Method 'GET' -Url "$normalizedBaseUrl/admin/db/status"
Assert-Status -Response $finalStatusResponse -AllowedStatus @(200) -Message 'Failed to load final DB status'

$summary = [ordered]@{
  source_profile_id = if ($SourceProfileId) { $SourceProfileId } else { $initialStatus.activeProfileId }
  target_profile_id = $TargetProfileId
  exported_tables = @($exportData.PSObject.Properties | ForEach-Object { $_.Name })
  exported_counts = @{}
  migrate_target_schema_version = if ($migrateResponse -and $migrateResponse.json) { $migrateResponse.json.data.schemaVersion } else { $null }
  imported = if ($importResponse -and $importResponse.json) { $importResponse.json.data.success } else { $false }
  imported_counts = if ($importResponse -and $importResponse.json) { $importResponse.json.data.counts } else { @{} }
  switched_to_target = [bool]$SwitchToTarget
  final_status = $finalStatusResponse.json.data
}

foreach ($property in $exportData.PSObject.Properties) {
  $items = @($property.Value)
  $summary.exported_counts[$property.Name] = $items.Count
}

$summary | ConvertTo-Json -Depth 50
