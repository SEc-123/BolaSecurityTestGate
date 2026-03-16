$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverDist = Join-Path $repoRoot 'server\dist\index.js'
$runtimeRoot = Join-Path $repoRoot 'tmp_doc09_runtime'
$dataDir = Join-Path $runtimeRoot 'data'
$stdoutLog = Join-Path $runtimeRoot 'server.stdout.log'
$stderrLog = Join-Path $runtimeRoot 'server.stderr.log'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$resultPath = Join-Path $scriptDir 'tmp_recording_doc09_result.json'

$port = 3013
$baseUrl = "http://127.0.0.1:$port"
$recordingApiKey = 'doc09-plugin-key'
$recordingAdminKey = 'doc09-admin-key'

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers,
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
    $params['Body'] = ($Body | ConvertTo-Json -Depth 20 -Compress)
  }

  try {
    $response = Invoke-WebRequest @params
    $json = $null
    if ($response.Content) {
      $json = $response.Content | ConvertFrom-Json
    }
    return @{
      status = [int]$response.StatusCode
      json = $json
      raw = $response.Content
    }
  } catch {
    $status = 500
    $content = ''

    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode.value__
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $content = $reader.ReadToEnd()
      $reader.Close()
    } else {
      $content = $_.Exception.Message
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
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing
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

function New-RecordedEvent {
  param(
    [int]$Sequence,
    [string]$Method,
    [string]$Url,
    [hashtable]$RequestHeaders,
    [string]$RequestBodyText,
    [int]$ResponseStatus,
    [hashtable]$ResponseHeaders,
    [string]$ResponseBodyText
  )

  return @{
    sequence = $Sequence
    sourceTool = 'burp_montoya'
    method = $Method
    url = $Url
    requestHeaders = $RequestHeaders
    requestBodyText = $RequestBodyText
    responseStatus = $ResponseStatus
    responseHeaders = $ResponseHeaders
    responseBodyText = $ResponseBodyText
  }
}

if (Test-Path $runtimeRoot) {
  Remove-Item -Path $runtimeRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

Stop-PortProcess -Port $port

$env:PORT = "$port"
$env:RECORDING_API_KEY = $recordingApiKey
$env:RECORDING_ADMIN_API_KEY = $recordingAdminKey
$env:CLEANUP_INTERVAL_HOURS = '999999'

$serverProcess = Start-Process -FilePath 'node' `
  -ArgumentList "`"$serverDist`"" `
  -WorkingDirectory $runtimeRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

$result = [ordered]@{
  wrong_api_key_rejected = $false
  wrong_api_key_error = $null
  oversize_batch_rejected = $false
  oversize_batch_error = $null
  oversize_dead_letter_created = $false
  dead_letter_replay_status = $null
  dead_letter_replay_inserted = 0
  sensitive_password_masked = $false
  sensitive_authorization_masked = $false
  sensitive_cookie_masked = $false
  generation_failure_status = $null
  regeneration_status = $null
  workflow_draft_count_after_retry = 0
  publish_without_admin_status = $null
  publish_without_admin_error = $null
  publish_with_admin_succeeded = $false
  metrics = @{}
  runtime = @{
    port = $port
    stdout_log = $stdoutLog
    stderr_log = $stderrLog
  }
}

try {
  Wait-ForServer -Url "$baseUrl/health"

  $badKeyResponse = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/sessions" -Headers @{
    'X-API-Key' = 'wrong-key'
  } -Body @{
    name = 'Bad Key Session'
    mode = 'api'
  }
  $result.wrong_api_key_rejected = ($badKeyResponse.status -eq 401)
  $result.wrong_api_key_error = $badKeyResponse.json.error
  Assert-True $result.wrong_api_key_rejected 'Wrong API key should be rejected with HTTP 401'

  $batchSessionResponse = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/sessions" -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    name = 'Oversize Batch Session'
    mode = 'api'
    source_tool = 'burp_montoya'
  }
  Assert-True ($batchSessionResponse.status -eq 201) 'Failed to create oversize batch session'
  $batchSessionId = $batchSessionResponse.json.data.id

  $oversizeEvents = @()
  for ($index = 1; $index -le 51; $index++) {
    $oversizeEvents += New-RecordedEvent -Sequence $index `
      -Method 'GET' `
      -Url "http://app.test/api/items/$index" `
      -RequestHeaders @{ authorization = 'Bearer oversize-token'; cookie = 'JSESSIONID=sess-oversize'; accept = 'application/json' } `
      -RequestBodyText '' `
      -ResponseStatus 200 `
      -ResponseHeaders @{ 'content-type' = 'application/json' } `
      -ResponseBodyText "{""id"":""item-$index""}"
  }

  $oversizeResponse = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/sessions/$batchSessionId/events/batch" -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    events = $oversizeEvents
  }
  $result.oversize_batch_rejected = ($oversizeResponse.status -eq 413)
  $result.oversize_batch_error = if ($oversizeResponse.json -and $oversizeResponse.json.error) { $oversizeResponse.json.error } else { $oversizeResponse.raw }
  Assert-True $result.oversize_batch_rejected 'Oversize batch should be rejected with HTTP 413'

  $opsSummary = Invoke-JsonRequest -Method 'GET' -Url "$baseUrl/api/recordings/ops/summary" -Headers @{
    'X-Recording-Admin-Key' = $recordingAdminKey
  }
  Assert-True ($opsSummary.status -eq 200) 'Failed to read recording ops summary'
  $result.metrics = $opsSummary.json.data.metrics

  $deadLettersResponse = Invoke-JsonRequest -Method 'GET' -Url "$baseUrl/api/recordings/ops/dead-letters?status=pending" -Headers @{
    'X-Recording-Admin-Key' = $recordingAdminKey
  }
  Assert-True ($deadLettersResponse.status -eq 200) 'Failed to read pending dead letters'
  $batchDeadLetter = $deadLettersResponse.json.data | Where-Object {
    $_.session_id -eq $batchSessionId -and $_.failure_stage -eq 'ingest_batch'
  } | Select-Object -First 1
  $result.oversize_dead_letter_created = ($null -ne $batchDeadLetter)
  Assert-True $result.oversize_dead_letter_created 'Oversize batch should create a pending dead letter'

  $retryResponse = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/ops/dead-letters/$($batchDeadLetter.id)/retry" -Headers @{
    'X-Recording-Admin-Key' = $recordingAdminKey
  }
  Assert-True ($retryResponse.status -eq 200) 'Dead letter replay should succeed'
  $result.dead_letter_replay_status = $retryResponse.json.data.dead_letter.status
  $result.dead_letter_replay_inserted = $retryResponse.json.data.result.inserted
  Assert-True ($result.dead_letter_replay_status -eq 'replayed') 'Dead letter should become replayed after retry'

  $batchSessionDetail = Invoke-JsonRequest -Method 'GET' -Url "$baseUrl/api/recordings/sessions/$batchSessionId" -Headers @{}
  Assert-True ($batchSessionDetail.status -eq 200) 'Failed to load replayed batch session detail'
  Assert-True ($batchSessionDetail.json.data.session.event_count -eq 51) 'Dead letter replay should restore all oversize events'

  $sensitiveSessionResponse = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/sessions" -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    name = 'Sensitive Field Session'
    mode = 'api'
    source_tool = 'burp_montoya'
  }
  Assert-True ($sensitiveSessionResponse.status -eq 201) 'Failed to create sensitive field session'
  $sensitiveSessionId = $sensitiveSessionResponse.json.data.id

  $sensitiveEvent = New-RecordedEvent -Sequence 1 `
    -Method 'POST' `
    -Url 'http://app.test/api/login' `
    -RequestHeaders @{ authorization = 'Bearer super-secret'; cookie = 'JSESSIONID=sess-sensitive'; 'content-type' = 'application/json' } `
    -RequestBodyText '{"username":"alice","password":"pass-live-001"}' `
    -ResponseStatus 200 `
    -ResponseHeaders @{ 'set-cookie' = 'JSESSIONID=sess-sensitive; Path=/; HttpOnly'; 'content-type' = 'application/json' } `
    -ResponseBodyText '{"status":"ok","token":"token-sensitive"}'

  $sensitiveIngestResponse = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/sessions/$sensitiveSessionId/events/batch" -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    events = @($sensitiveEvent)
  }
  Assert-True ($sensitiveIngestResponse.status -eq 200) 'Failed to ingest sensitive event'

  $sensitiveEventsResponse = Invoke-JsonRequest -Method 'GET' -Url "$baseUrl/api/recordings/sessions/$sensitiveSessionId/events?limit=10&offset=0" -Headers @{}
  Assert-True ($sensitiveEventsResponse.status -eq 200) 'Failed to fetch sensitive event timeline'
  $storedEvent = $sensitiveEventsResponse.json.data.events[0]
  $result.sensitive_password_masked = ($storedEvent.request_body_text -like '*[REDACTED]*')
  $result.sensitive_authorization_masked = ($storedEvent.request_headers.authorization -eq '[REDACTED]')
  $result.sensitive_cookie_masked = ($storedEvent.request_cookies.JSESSIONID -eq '[REDACTED]')
  Assert-True $result.sensitive_password_masked 'Stored request body should mask password values'
  Assert-True $result.sensitive_authorization_masked 'Stored authorization header should be masked'
  Assert-True $result.sensitive_cookie_masked 'Stored session cookie should be masked'

  $workflowSessionResponse = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/sessions" -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    name = 'Workflow Retry Session'
    mode = 'workflow'
    source_tool = 'burp_montoya'
    target_fields = @(
      @{
        name = 'access_token'
        aliases = @('access_token', 'token')
        from_sources = @('response.body', 'request.header')
        bind_to_account_field = 'access_token'
        category = 'AUTH'
      },
      @{
        name = 'user_id'
        aliases = @('user_id')
        from_sources = @('request.query', 'response.body')
        bind_to_account_field = 'user_id'
        category = 'IDENTITY'
      }
    )
  }
  Assert-True ($workflowSessionResponse.status -eq 201) 'Failed to create workflow retry session'
  $workflowSessionId = $workflowSessionResponse.json.data.id

  $finishFailureResponse = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/sessions/$workflowSessionId/finish" -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{}
  Assert-True ($finishFailureResponse.status -eq 400) 'Finishing an empty workflow session should fail'

  $workflowFailedDetail = Invoke-JsonRequest -Method 'GET' -Url "$baseUrl/api/recordings/sessions/$workflowSessionId" -Headers @{}
  Assert-True ($workflowFailedDetail.status -eq 200) 'Failed to fetch workflow session after generation failure'
  $result.generation_failure_status = $workflowFailedDetail.json.data.session.status
  Assert-True ($result.generation_failure_status -eq 'failed') 'Workflow session should stay failed after generation error'

  $workflowEvents = @(
    (New-RecordedEvent -Sequence 1 `
      -Method 'POST' `
      -Url 'http://app.test/api/login' `
      -RequestHeaders @{ 'content-type' = 'application/json' } `
      -RequestBodyText '{"username":"alice","password":"pass-live-002"}' `
      -ResponseStatus 200 `
      -ResponseHeaders @{ 'content-type' = 'application/json' } `
      -ResponseBodyText '{"access_token":"token-live-09","user_id":"user-live-09"}'),
    (New-RecordedEvent -Sequence 2 `
      -Method 'GET' `
      -Url 'http://app.test/api/profile?user_id=user-live-09' `
      -RequestHeaders @{ authorization = 'Bearer token-live-09'; accept = 'application/json' } `
      -RequestBodyText '' `
      -ResponseStatus 200 `
      -ResponseHeaders @{ 'content-type' = 'application/json' } `
      -ResponseBodyText '{"status":"ok","profile":{"user_id":"user-live-09"}}')
  )

  $workflowIngestResponse = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/sessions/$workflowSessionId/events/batch" -Headers @{
    'X-API-Key' = $recordingApiKey
  } -Body @{
    events = $workflowEvents
  }
  Assert-True ($workflowIngestResponse.status -eq 200) 'Failed to ingest workflow retry events'

  $regenerateResponse = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/sessions/$workflowSessionId/regenerate" -Headers @{} -Body @{}
  Assert-True ($regenerateResponse.status -eq 200) 'Manual regenerate should recover the failed workflow session'
  $result.regeneration_status = $regenerateResponse.json.data.session.status
  $result.workflow_draft_count_after_retry = $regenerateResponse.json.data.generated.workflow_draft_count
  Assert-True ($result.regeneration_status -eq 'completed') 'Workflow session should recover to completed after manual regenerate'
  Assert-True ($result.workflow_draft_count_after_retry -ge 1) 'Recovered workflow session should generate at least one workflow draft'

  $workflowDraftId = $regenerateResponse.json.data.workflow_drafts[0].id
  $publishWithoutAdmin = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/workflow-drafts/$workflowDraftId/publish" -Headers @{} -Body @{
    published_by = 'doc09_smoke'
  }
  $result.publish_without_admin_status = $publishWithoutAdmin.status
  $result.publish_without_admin_error = $publishWithoutAdmin.json.error
  Assert-True ($publishWithoutAdmin.status -eq 403) 'Publishing without admin key should be rejected'

  $publishWithAdmin = Invoke-JsonRequest -Method 'POST' -Url "$baseUrl/api/recordings/workflow-drafts/$workflowDraftId/publish" -Headers @{
    'X-Recording-Admin-Key' = $recordingAdminKey
  } -Body @{
    published_by = 'doc09_smoke'
  }
  $result.publish_with_admin_succeeded = ($publishWithAdmin.status -eq 200)
  Assert-True $result.publish_with_admin_succeeded 'Publishing with admin key should succeed'

  $finalOpsSummary = Invoke-JsonRequest -Method 'GET' -Url "$baseUrl/api/recordings/ops/summary" -Headers @{
    'X-Recording-Admin-Key' = $recordingAdminKey
  }
  if ($finalOpsSummary.status -eq 200) {
    $result.metrics = $finalOpsSummary.json.data.metrics
  }
} finally {
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force
  }
}

$result | ConvertTo-Json -Depth 20 | Set-Content -Path $resultPath -Encoding UTF8
$result | ConvertTo-Json -Depth 20
