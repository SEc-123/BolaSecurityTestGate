param(
  [switch]$SkipHistoricalSmokes
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverDir = Join-Path $repoRoot 'server'
$serverDist = Join-Path $serverDir 'dist\index.js'
$runtimeRoot = Join-Path $repoRoot 'tmp_doc10_runtime'
$resultPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'tmp_recording_doc10_result.json'
$progressLog = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'tmp_recording_doc10_progress.log'

$port = 3016
$baseUrl = "http://127.0.0.1:$port"
$recordingApiKey = 'doc10-plugin-key'
$recordingAdminKey = 'doc10-admin-key'

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Write-Checkpoint {
  param([string]$Message)

  $line = "[{0}] {1}" -f (Get-Date -Format 's'), $Message
  Add-Content -Path $progressLog -Value $line -Encoding UTF8
}

function Invoke-CheckedProcess {
  param(
    [string]$Label,
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )

  Push-Location $WorkingDirectory
  try {
    Write-Checkpoint "${Label}: start"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$Label failed with exit code $LASTEXITCODE"
    }
    Write-Checkpoint "${Label}: completed"
  } finally {
    Pop-Location
  }
}

function Invoke-CheckedScriptFile {
  param(
    [string]$Label,
    [string]$ScriptPath,
    [string]$WorkingDirectory
  )

  Push-Location $WorkingDirectory
  try {
    Write-Checkpoint "${Label}: start"
    & $ScriptPath
  } finally {
    Pop-Location
  }

  Write-Checkpoint "${Label}: completed"
}

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers = @{},
    $Body = $null
  )

  $params = @{
    Method = $Method
    Uri = $Url
    Headers = $Headers
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
      raw = $response.Content
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

function Wait-ForServer {
  param([string]$Url)

  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ([int]$response.StatusCode -eq 200) {
        return
      }
    } catch {
    }
    Start-Sleep -Milliseconds 500
  }

  throw "Server did not become ready: $Url"
}

function Stop-PortProcess {
  param([int]$Port)

  try {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  } catch {
  }
}

function Start-RecordingServer {
  param(
    [string]$Phase,
    [string]$RuntimeName,
    [string]$AllowedAccountIds = ''
  )

  $runtimeDir = Join-Path $runtimeRoot $RuntimeName
  $dataDir = Join-Path $runtimeDir 'data'
  $stdoutLog = Join-Path $runtimeDir 'server.stdout.log'
  $stderrLog = Join-Path $runtimeDir 'server.stderr.log'

  if (Test-Path $runtimeDir) {
    Remove-Item -Path $runtimeDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

  $env:PORT = "$port"
  $env:RECORDING_API_KEY = $recordingApiKey
  $env:RECORDING_ADMIN_API_KEY = $recordingAdminKey
  $env:CLEANUP_INTERVAL_HOURS = '999999'
  $env:RECORDING_ROLLOUT_PHASE = $Phase
  $env:RECORDING_ALLOWED_ACCOUNT_IDS = $AllowedAccountIds

  Stop-PortProcess -Port $port

  $process = Start-Process -FilePath 'node' `
    -ArgumentList "`"$serverDist`"" `
    -WorkingDirectory $runtimeDir `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  Wait-ForServer -Url "$baseUrl/health"

  return @{
    process = $process
    runtimeDir = $runtimeDir
    stdoutLog = $stdoutLog
    stderrLog = $stderrLog
  }
}

function Stop-RecordingServer {
  param($State)

  if ($State -and $State.process -and -not $State.process.HasExited) {
    Stop-Process -Id $State.process.Id -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-RecordingApi {
  param(
    [string]$Method,
    [string]$Path,
    $Body = $null,
    [hashtable]$Headers = @{}
  )

  return Invoke-JsonRequest -Method $Method -Url "$baseUrl$Path" -Headers $Headers -Body $Body
}

if (Test-Path $runtimeRoot) {
  Remove-Item -Path $runtimeRoot -Recurse -Force
}
if (Test-Path $resultPath) {
  Remove-Item -Path $resultPath -Force
}
if (Test-Path $progressLog) {
  Remove-Item -Path $progressLog -Force
}
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Write-Checkpoint "doc10 smoke: start"

$result = [ordered]@{
  build = [ordered]@{
    server_build = $false
    server_typecheck = $false
    frontend_typecheck = $false
    frontend_build = $false
    unit_check = $null
  }
  regression_smokes = [ordered]@{
    doc03 = $false
    doc05 = $false
    doc06 = $false
    doc07 = $false
    doc08 = $false
    doc09 = $false
  }
  rollout = [ordered]@{
    hidden_phase = $null
    hidden_create_status = $null
    workflow_only_phase = $null
    blocked_account_status = $null
    allowed_workflow_status = $null
    blocked_api_status = $null
    blocked_publish_status = $null
    formal_phase = $null
  }
  performance = [ordered]@{
    event_count = 0
    batch_count = 0
    ingest_duration_ms = 0
    finish_duration_ms = 0
    draft_count = 0
    session_status = $null
  }
  migration = [ordered]@{
    target_profile_id = $null
    exported_counts = @{}
    imported_counts = @{}
    final_active_profile_id = $null
    final_active_profile_name = $null
    account_preserved = $false
    workflow_preserved = $false
    workflow_step_count = 0
    test_run_preserved = $false
  }
  regression_after_migration = [ordered]@{
    accounts_status = $null
    workflows_status = $null
    test_runs_status = $null
    workflow_steps_status = $null
  }
  runtime = [ordered]@{
    port = $port
    formal_stdout_log = $null
    formal_stderr_log = $null
    progress_log = $progressLog
  }
}

$serverState = $null

try {
  Invoke-CheckedProcess -Label 'server build' -FilePath 'npm' -Arguments @('run', 'build') -WorkingDirectory $serverDir
  $result.build.server_build = $true

  Invoke-CheckedProcess -Label 'server typecheck' -FilePath 'npm' -Arguments @('run', 'typecheck') -WorkingDirectory $serverDir
  $result.build.server_typecheck = $true

  Invoke-CheckedProcess -Label 'frontend typecheck' -FilePath 'npm' -Arguments @('run', 'typecheck') -WorkingDirectory $repoRoot
  $result.build.frontend_typecheck = $true

  Invoke-CheckedProcess -Label 'frontend build' -FilePath 'npm' -Arguments @('run', 'build') -WorkingDirectory $repoRoot
  $result.build.frontend_build = $true

  $unitCheckOutput = & node (Join-Path $repoRoot 'scripts\recording-unit-check.mjs') | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "recording unit check failed with exit code $LASTEXITCODE"
  }
  $result.build.unit_check = $unitCheckOutput | ConvertFrom-Json
  Write-Checkpoint 'recording unit check: completed'

  if (-not $SkipHistoricalSmokes) {
    $smokeScripts = [ordered]@{
      doc03 = 'tests/recording/smoke-tests/tmp_recording_doc03_smoke.ps1'
      doc05 = 'tests/recording/smoke-tests/tmp_recording_doc05_smoke.ps1'
      doc06 = 'tests/recording/smoke-tests/tmp_recording_doc06_smoke.ps1'
      doc07 = 'tests/recording/smoke-tests/tmp_recording_doc07_smoke.ps1'
      doc08 = 'tests/recording/smoke-tests/tmp_recording_doc08_smoke.ps1'
      doc09 = 'tests/recording/smoke-tests/tmp_recording_doc09_smoke.ps1'
    }

    foreach ($smoke in $smokeScripts.GetEnumerator()) {
      Invoke-CheckedScriptFile `
        -Label $smoke.Key `
        -ScriptPath (Join-Path $repoRoot $smoke.Value) `
        -WorkingDirectory $repoRoot
      $result.regression_smokes[$smoke.Key] = $true
    }
  } else {
    Write-Checkpoint 'historical smokes: skipped'
  }

  Write-Checkpoint 'rollout hidden: start'
  $serverState = Start-RecordingServer -Phase 'hidden' -RuntimeName 'hidden'
  $hiddenConfig = Invoke-RecordingApi -Method 'GET' -Path '/api/recordings/config'
  Assert-True ($hiddenConfig.status -eq 200) 'Failed to fetch hidden rollout config'
  $result.rollout.hidden_phase = $hiddenConfig.json.data.phase

  $hiddenCreate = Invoke-RecordingApi -Method 'POST' -Path '/api/recordings/sessions' -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    name = 'Doc10 Hidden Session'
    mode = 'workflow'
  }
  $result.rollout.hidden_create_status = $hiddenCreate.status
  Assert-True ($hiddenCreate.status -eq 403) 'Hidden phase should reject recording session creation'
  Stop-RecordingServer -State $serverState
  $serverState = $null
  Write-Checkpoint 'rollout hidden: completed'

  Write-Checkpoint 'rollout workflow_only: start'
  $serverState = Start-RecordingServer -Phase 'workflow_only' -RuntimeName 'workflow_only' -AllowedAccountIds 'allowed-doc10-account'
  $workflowOnlyConfig = Invoke-RecordingApi -Method 'GET' -Path '/api/recordings/config'
  Assert-True ($workflowOnlyConfig.status -eq 200) 'Failed to fetch workflow_only rollout config'
  $result.rollout.workflow_only_phase = $workflowOnlyConfig.json.data.phase

  $allowlistedAccountImport = Invoke-RecordingApi -Method 'POST' -Path '/admin/db/import' -Body @{
    data = @{
      accounts = @(
        @{
          id = 'allowed-doc10-account'
          name = 'Workflow Only Allowlisted Account'
          status = 'active'
          fields = @{
            user_id = 'user-allowlisted-doc10'
          }
          auth_profile = @{}
          variables = @{}
          created_at = (Get-Date).ToString('o')
          updated_at = (Get-Date).ToString('o')
        }
      )
    }
  }
  Assert-True ($allowlistedAccountImport.status -eq 200) 'Failed to seed allowlisted account for workflow_only rollout test'

  $blockedAccount = Invoke-RecordingApi -Method 'POST' -Path '/api/recordings/sessions' -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    name = 'Doc10 Blocked Account'
    mode = 'workflow'
    account_id = 'blocked-doc10-account'
  }
  $result.rollout.blocked_account_status = $blockedAccount.status
  Assert-True ($blockedAccount.status -eq 403) 'workflow_only phase should reject blocked accounts'

  $allowedWorkflow = Invoke-RecordingApi -Method 'POST' -Path '/api/recordings/sessions' -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    name = 'Doc10 Allowed Workflow'
    mode = 'workflow'
    account_id = 'allowed-doc10-account'
  }
  $result.rollout.allowed_workflow_status = $allowedWorkflow.status
  Assert-True ($allowedWorkflow.status -eq 201) 'workflow_only phase should allow workflow recording for the allowlisted account'

  $blockedApi = Invoke-RecordingApi -Method 'POST' -Path '/api/recordings/sessions' -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    name = 'Doc10 Blocked API'
    mode = 'api'
    account_id = 'allowed-doc10-account'
  }
  $result.rollout.blocked_api_status = $blockedApi.status
  Assert-True ($blockedApi.status -eq 403) 'workflow_only phase should keep API recording disabled'

  $blockedPublish = Invoke-RecordingApi -Method 'POST' -Path '/api/recordings/workflow-drafts/nonexistent/publish' -Body @{
    published_by = 'doc10_smoke'
  }
  $result.rollout.blocked_publish_status = $blockedPublish.status
  Assert-True ($blockedPublish.status -eq 403) 'workflow_only phase should block draft publish actions before asset lookup'
  Stop-RecordingServer -State $serverState
  $serverState = $null
  Write-Checkpoint 'rollout workflow_only: completed'

  Write-Checkpoint 'formal rollout and performance: start'
  $serverState = Start-RecordingServer -Phase 'formal' -RuntimeName 'formal'
  $result.runtime.formal_stdout_log = $serverState.stdoutLog
  $result.runtime.formal_stderr_log = $serverState.stderrLog

  $formalConfig = Invoke-RecordingApi -Method 'GET' -Path '/api/recordings/config'
  Assert-True ($formalConfig.status -eq 200) 'Failed to fetch formal rollout config'
  $result.rollout.formal_phase = $formalConfig.json.data.phase

  $environmentResponse = Invoke-RecordingApi -Method 'POST' -Path '/api/environments' -Body @{
    name = 'Doc10 Migration Environment'
    base_url = 'http://example.test'
    description = 'doc10 migration environment'
    is_active = $true
  }
  Assert-True ($environmentResponse.status -eq 201) 'Failed to create migration environment'
  $environment = $environmentResponse.json.data

  $accountResponse = Invoke-RecordingApi -Method 'POST' -Path '/api/accounts' -Body @{
    name = 'Doc10 Migration Account'
    status = 'active'
    fields = @{
      user_id = 'user-live-doc10'
      order_id = 'order-live-doc10'
    }
    auth_profile = @{
      authorization = 'Bearer token-doc10'
    }
    variables = @{}
  }
  Assert-True ($accountResponse.status -eq 201) 'Failed to create migration account'
  $account = $accountResponse.json.data

  $performanceSessionResponse = Invoke-RecordingApi -Method 'POST' -Path '/api/recordings/sessions' -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    name = 'Doc10 Performance Session'
    mode = 'api'
    environment_id = $environment.id
    account_id = $account.id
    target_fields = @(
      @{
        name = 'user_id'
        aliases = @('userId')
        from_sources = @('request.query', 'request.body', 'response.body')
        bind_to_account_field = 'user_id'
        category = 'OBJECT_ID'
      },
      @{
        name = 'order_id'
        aliases = @('orderId')
        from_sources = @('request.path', 'response.body')
        bind_to_account_field = 'order_id'
        category = 'OBJECT_ID'
      }
    )
  }
  Assert-True ($performanceSessionResponse.status -eq 201) 'Failed to create performance recording session'
  $performanceSession = $performanceSessionResponse.json.data

  $performanceEvents = @()
  for ($index = 1; $index -le 100; $index++) {
    $orderId = 'order-' + $index.ToString('000')
    $performanceEvents += @{
      sequence = $index
      sourceTool = 'burp_montoya'
      method = if ($index % 5 -eq 0) { 'POST' } else { 'GET' }
      url = if ($index % 5 -eq 0) {
        "http://app.test/api/orders/$orderId/submit"
      } else {
        "http://app.test/api/orders/$orderId?userId=user-live-doc10"
      }
      requestHeaders = @{
        accept = 'application/json'
        authorization = 'Bearer token-doc10'
        'content-type' = 'application/json'
      }
      requestBodyText = if ($index % 5 -eq 0) { '{"userId":"user-live-doc10","confirm":true}' } else { '' }
      responseStatus = 200
      responseHeaders = @{
        'content-type' = 'application/json'
      }
      responseBodyText = "{""orderId"":""$orderId"",""userId"":""user-live-doc10"",""ok"":true}"
    }
  }

  $ingestStarted = Get-Date
  foreach ($chunk in 0..1) {
    $startIndex = $chunk * 50
    $chunkEvents = @($performanceEvents[$startIndex..($startIndex + 49)])
    $ingestResponse = Invoke-RecordingApi -Method 'POST' -Path "/api/recordings/sessions/$($performanceSession.id)/events/batch" -Headers @{
      'X-API-Key' = $recordingApiKey
    } -Body @{
      events = $chunkEvents
    }
    Assert-True ($ingestResponse.status -eq 200) "Failed to ingest performance batch $chunk"
  }
  $result.performance.ingest_duration_ms = [int]((Get-Date) - $ingestStarted).TotalMilliseconds
  $result.performance.event_count = 100
  $result.performance.batch_count = 2

  $finishStarted = Get-Date
  $finishResponse = Invoke-RecordingApi -Method 'POST' -Path "/api/recordings/sessions/$($performanceSession.id)/finish" -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{}
  Assert-True ($finishResponse.status -eq 200) 'Failed to finish the 100-event performance session'
  $result.performance.finish_duration_ms = [int]((Get-Date) - $finishStarted).TotalMilliseconds
  $result.performance.draft_count = @($finishResponse.json.data.test_run_drafts).Count
  $result.performance.session_status = $finishResponse.json.data.session.status
  Assert-True ($result.performance.draft_count -eq 100) '100-event performance session should generate 100 API drafts'
  Assert-True ($result.performance.session_status -eq 'completed') '100-event performance session should complete successfully'
  Write-Checkpoint 'formal rollout and performance: completed'

  Write-Checkpoint 'migration: start'
  $template1Response = Invoke-RecordingApi -Method 'POST' -Path '/api/api-templates' -Body @{
    name = 'Doc10 Template Users'
    description = 'migration regression template 1'
    raw_request = "GET /api/users?userId={{user_id}} HTTP/1.1`nHost: example.test`nAccept: application/json"
    parsed_structure = @{
      method = 'GET'
      path = '/api/users?userId={{user_id}}'
      headers = @{
        Host = 'example.test'
        Accept = 'application/json'
      }
      body = ''
    }
    variables = @(
      @{
        name = 'user_id'
        json_path = 'query.userId'
        operation_type = 'replace'
        original_value = 'user-live-doc10'
        data_source = 'account_field'
        account_field_name = 'user_id'
      }
    )
    failure_patterns = @()
    failure_logic = 'OR'
    is_active = $true
  }
  Assert-True ($template1Response.status -eq 201) 'Failed to create first migration template'
  $template1 = $template1Response.json.data

  $template2Response = Invoke-RecordingApi -Method 'POST' -Path '/api/api-templates' -Body @{
    name = 'Doc10 Template Orders'
    description = 'migration regression template 2'
    raw_request = "POST /api/orders/{{order_id}}/submit HTTP/1.1`nHost: example.test`nContent-Type: application/json`n`n{""userId"":""{{user_id}}"",""confirm"":true}"
    parsed_structure = @{
      method = 'POST'
      path = '/api/orders/{{order_id}}/submit'
      headers = @{
        Host = 'example.test'
        'Content-Type' = 'application/json'
      }
      body = @{
        userId = '{{user_id}}'
        confirm = $true
      }
    }
    variables = @(
      @{
        name = 'order_id'
        json_path = 'path.order_id'
        operation_type = 'replace'
        original_value = 'order-live-doc10'
        data_source = 'account_field'
        account_field_name = 'order_id'
        path_replacement_mode = 'segment_index'
        path_segment_index = 2
      },
      @{
        name = 'user_id'
        json_path = 'body.userId'
        operation_type = 'replace'
        original_value = 'user-live-doc10'
        data_source = 'account_field'
        account_field_name = 'user_id'
      }
    )
    failure_patterns = @()
    failure_logic = 'OR'
    is_active = $true
  }
  Assert-True ($template2Response.status -eq 201) 'Failed to create second migration template'
  $template2 = $template2Response.json.data

  $workflowResponse = Invoke-RecordingApi -Method 'POST' -Path '/api/workflows' -Body @{
    name = 'Doc10 Regression Workflow'
    description = 'migration regression workflow'
    is_active = $true
  }
  Assert-True ($workflowResponse.status -eq 201) 'Failed to create migration workflow'
  $workflow = $workflowResponse.json.data

  $workflowStepsResponse = Invoke-RecordingApi -Method 'PUT' -Path "/api/workflows/$($workflow.id)/steps" -Body @{
    template_ids = @($template1.id, $template2.id)
  }
  Assert-True ($workflowStepsResponse.status -eq 200) 'Failed to configure workflow steps before migration'

  $testRunResponse = Invoke-RecordingApi -Method 'POST' -Path '/api/test-runs' -Body @{
    name = 'Doc10 Migration Test Run'
    status = 'pending'
    execution_type = 'template'
    template_ids = @($template1.id)
    account_ids = @($account.id)
    environment_id = $environment.id
    execution_params = @{
      source = 'doc10_smoke'
    }
    progress_percent = 0
    progress = @{
      total = 0
      completed = 0
      findings = 0
    }
  }
  Assert-True ($testRunResponse.status -eq 201) 'Failed to create migration test run'
  $testRun = $testRunResponse.json.data

  $targetDbDir = Join-Path $serverState.runtimeDir 'target-db'
  New-Item -ItemType Directory -Path $targetDbDir -Force | Out-Null
  $targetDbFile = Join-Path $targetDbDir 'doc10-migrated.db'
  $profileResponse = Invoke-RecordingApi -Method 'POST' -Path '/admin/db/profiles' -Body @{
    name = 'Doc10 Migrated SQLite'
    kind = 'sqlite'
    config = @{
      file = $targetDbFile
    }
  }
  Assert-True ($profileResponse.status -eq 201) 'Failed to create migration target profile'
  $targetProfile = $profileResponse.json.data
  $result.migration.target_profile_id = $targetProfile.id

  $migrationOutput = & powershell.exe -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts\recording-db-migrate.ps1') `
    -BaseUrl $baseUrl `
    -TargetProfileId $targetProfile.id `
    -MigrateTarget `
    -SwitchToTarget `
    -ExportPath (Join-Path $serverState.runtimeDir 'doc10-export.json') | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "recording-db-migrate.ps1 failed with exit code $LASTEXITCODE"
  }
  $migrationResult = $migrationOutput | ConvertFrom-Json

  $result.migration.exported_counts = $migrationResult.exported_counts
  $result.migration.imported_counts = $migrationResult.imported_counts
  $result.migration.final_active_profile_id = $migrationResult.final_status.activeProfileId
  $result.migration.final_active_profile_name = $migrationResult.final_status.activeProfileName

  $migratedAccount = Invoke-RecordingApi -Method 'GET' -Path "/api/accounts/$($account.id)"
  $result.regression_after_migration.accounts_status = $migratedAccount.status
  $result.migration.account_preserved = ($migratedAccount.status -eq 200 -and $migratedAccount.json.data.id -eq $account.id)
  Assert-True $result.migration.account_preserved 'Migrated account should retain its original ID'

  $migratedWorkflow = Invoke-RecordingApi -Method 'GET' -Path "/api/workflows/$($workflow.id)"
  $result.regression_after_migration.workflows_status = $migratedWorkflow.status
  $result.migration.workflow_preserved = ($migratedWorkflow.status -eq 200 -and $migratedWorkflow.json.data.id -eq $workflow.id)
  Assert-True $result.migration.workflow_preserved 'Migrated workflow should retain its original ID'

  $migratedWorkflowSteps = Invoke-RecordingApi -Method 'GET' -Path "/api/workflows/$($workflow.id)/steps"
  $result.regression_after_migration.workflow_steps_status = $migratedWorkflowSteps.status
  $result.migration.workflow_step_count = @($migratedWorkflowSteps.json.data).Count
  Assert-True ($migratedWorkflowSteps.status -eq 200) 'Migrated workflow steps should remain readable'
  Assert-True ($result.migration.workflow_step_count -eq 2) 'Migrated workflow should retain both configured steps'

  $migratedTestRun = Invoke-RecordingApi -Method 'GET' -Path "/api/test-runs/$($testRun.id)"
  $result.regression_after_migration.test_runs_status = $migratedTestRun.status
  $result.migration.test_run_preserved = ($migratedTestRun.status -eq 200 -and $migratedTestRun.json.data.id -eq $testRun.id)
  Assert-True $result.migration.test_run_preserved 'Migrated test run should retain its original ID'

  Assert-True (
    $result.migration.final_active_profile_id -eq $targetProfile.id
  ) 'Target profile should be active after migration switch'
  Write-Checkpoint 'migration: completed'
} finally {
  Stop-RecordingServer -State $serverState
}

$result | ConvertTo-Json -Depth 50 | Set-Content -Path $resultPath -Encoding UTF8
Write-Checkpoint 'doc10 smoke: completed'
$result | ConvertTo-Json -Depth 50
