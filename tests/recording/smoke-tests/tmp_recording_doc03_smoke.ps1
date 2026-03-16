$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverDir = Join-Path $root 'server'
$backendPort = 3011
$backendBaseUrl = "http://localhost:$backendPort"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendLog = Join-Path $scriptDir 'tmp_recording_doc03_backend.log'
$backendErr = Join-Path $scriptDir 'tmp_recording_doc03_backend.err.log'
$mockLog = Join-Path $scriptDir 'tmp_recording_doc03_mock.log'
$mockErr = Join-Path $scriptDir 'tmp_recording_doc03_mock.err.log'

Remove-Item $backendLog, $backendErr, $mockLog, $mockErr -ErrorAction SilentlyContinue

$headers = @{}
if ($env:RECORDING_API_KEY) {
  $headers['x-recording-api-key'] = $env:RECORDING_API_KEY
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw $Message
  }
}

function Invoke-Api([string]$Method, [string]$Url, $Body = $null) {
  $params = @{
    Uri = $Url
    Method = $Method
    Headers = $headers
  }

  if ($null -ne $Body) {
    $params['ContentType'] = 'application/json'
    $params['Body'] = $Body | ConvertTo-Json -Depth 20
  }

  return Invoke-RestMethod @params
}

$mock = Start-Process -FilePath node `
  -ArgumentList 'tests/recording/smoke-tests/tmp_recording_mock_server.js' `
  -WorkingDirectory $root `
  -PassThru `
  -RedirectStandardOutput $mockLog `
  -RedirectStandardError $mockErr

$backend = Start-Process -FilePath cmd.exe `
  -ArgumentList '/c', "set PORT=$backendPort&& npx tsx src/index.ts" `
  -WorkingDirectory $serverDir `
  -PassThru `
  -RedirectStandardOutput $backendLog `
  -RedirectStandardError $backendErr

try {
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $health = Invoke-RestMethod -Uri "$backendBaseUrl/health" -Method Get -TimeoutSec 2
      if ($health.status -eq 'ok') {
        break
      }
    } catch {
    }

    Start-Sleep -Seconds 1
  }

  $health = Invoke-RestMethod -Uri "$backendBaseUrl/health" -Method Get -TimeoutSec 3
  Assert-True ($health.status -eq 'ok') 'Backend health check failed'

  $environment = (Invoke-Api 'POST' "$backendBaseUrl/api/environments" @{
      name = "Doc03 Environment $(Get-Date -Format 'yyyyMMddHHmmss')"
      base_url = 'http://127.0.0.1:3105'
      description = 'doc03 smoke environment'
      is_active = $true
    }).data

  $account = (Invoke-Api 'POST' "$backendBaseUrl/api/accounts" @{
      name = "Doc03 Account $(Get-Date -Format 'yyyyMMddHHmmss')"
      username = 'doc03-user'
      status = 'active'
      fields = @{ user_id = 'user-123' }
      auth_profile = @{ }
      variables = @{ }
    }).data

  $session = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions" @{
      name = "Doc03 Workflow Session $(Get-Date -Format 'yyyyMMddHHmmss')"
      mode = 'workflow'
      source_tool = 'burp_montoya'
      environment_id = $environment.id
      account_id = $account.id
      role = 'attacker'
      target_fields = @(
        @{
          name = 'user_id'
          aliases = @('uid')
          from_sources = @('request.query', 'response.body')
          bind_to_account_field = 'user_id'
          category = 'OBJECT_ID'
        },
        @{
          name = 'token'
          aliases = @('access_token')
          from_sources = @('response.body', 'response.header')
          bind_to_account_field = 'access_token'
          category = 'IDENTITY'
        }
      )
    }).data

  $ingest = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/events/batch" @{
      events = @(
        @{
          sequence = 1
          method = 'GET'
          url = 'http://127.0.0.1:3105/workflow/profile?user_id=user-123'
          requestHeaders = @{
            Host = '127.0.0.1:3105'
            Accept = 'application/json'
            Cookie = 'session_id=session-abc'
            Authorization = 'Bearer token-xyz'
          }
          responseStatus = 200
          responseHeaders = @{
            'content-type' = 'application/json'
            'set-cookie' = 'session_id=session-abc; Path=/; HttpOnly'
            'x-access-token' = 'token-xyz'
          }
          responseBodyText = '{"user_id":"user-123","token":"token-xyz"}'
        },
        @{
          sequence = 1
          method = 'GET'
          url = 'http://127.0.0.1:3105/workflow/profile?user_id=user-123'
          requestHeaders = @{
            Host = '127.0.0.1:3105'
            Accept = 'application/json'
            Cookie = 'session_id=session-abc'
            Authorization = 'Bearer token-xyz'
          }
          responseStatus = 200
          responseHeaders = @{
            'content-type' = 'application/json'
            'set-cookie' = 'session_id=session-abc; Path=/; HttpOnly'
            'x-access-token' = 'token-xyz'
          }
          responseBodyText = '{"user_id":"user-123","token":"token-xyz"}'
        },
        @{
          sequence = 2
          method = 'POST'
          url = 'http://127.0.0.1:3105/workflow/orders?user_id=user-123'
          requestHeaders = @{
            Host = '127.0.0.1:3105'
            Accept = 'application/json'
            'content-type' = 'application/json'
            Cookie = 'session_id=session-abc'
            Authorization = 'Bearer token-xyz'
          }
          requestBodyText = '{"user_id":"user-123","action":"checkout"}'
          responseStatus = 200
          responseHeaders = @{
            'content-type' = 'application/json'
            'set-cookie' = 'session_id=session-abc; Path=/; HttpOnly'
          }
          responseBodyText = '{"ok":true,"user_id":"user-123"}'
        }
      )
    }).data

  Assert-True ($ingest.inserted -eq 2) "Expected 2 inserted events, received $($ingest.inserted)"
  Assert-True ($ingest.skipped -eq 1) "Expected 1 skipped event, received $($ingest.skipped)"
  Assert-True ($ingest.accepted -eq 2) "Expected 2 accepted events, received $($ingest.accepted)"
  Assert-True ($ingest.deduplicated -eq 1) "Expected 1 deduplicated event, received $($ingest.deduplicated)"

  $pagedEvents = (Invoke-Api 'GET' "$backendBaseUrl/api/recordings/sessions/$($session.id)/events?limit=1&offset=1").data
  Assert-True ($pagedEvents.pagination.total -eq 2) "Expected 2 total events, received $($pagedEvents.pagination.total)"
  Assert-True ($pagedEvents.pagination.limit -eq 1) "Expected pagination limit 1, received $($pagedEvents.pagination.limit)"
  Assert-True ($pagedEvents.pagination.offset -eq 1) "Expected pagination offset 1, received $($pagedEvents.pagination.offset)"
  Assert-True ($pagedEvents.events.Count -eq 1) "Expected a single paged event, received $($pagedEvents.events.Count)"
  Assert-True ($pagedEvents.events[0].sequence -eq 2) "Expected paged event sequence 2, received $($pagedEvents.events[0].sequence)"

  $firstFinish = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/finish").data
  $secondFinish = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/finish").data

  Assert-True ($firstFinish.session.status -eq 'completed') "Expected first finish status completed, received $($firstFinish.session.status)"
  Assert-True ($secondFinish.session.status -eq 'completed') "Expected second finish status completed, received $($secondFinish.session.status)"
  Assert-True ($firstFinish.workflow_drafts.Count -eq 1) "Expected 1 workflow draft after first finish, received $($firstFinish.workflow_drafts.Count)"
  Assert-True ($secondFinish.workflow_drafts.Count -eq 1) "Expected finish to stay idempotent with 1 workflow draft, received $($secondFinish.workflow_drafts.Count)"
  Assert-True ($firstFinish.workflow_drafts[0].id -eq $secondFinish.workflow_drafts[0].id) 'Finish created a duplicate workflow draft'

  $candidates = (Invoke-Api 'GET' "$backendBaseUrl/api/recordings/sessions/$($session.id)/candidates").data
  Assert-True ($null -ne $candidates.runtime_context_summary) 'Expected runtime_context_summary to be present'
  Assert-True ($candidates.runtime_context_summary.cookies.session_id -eq 'session-abc') 'Expected cookie runtime context summary to preserve session_id'
  Assert-True ($candidates.runtime_context_summary.headers.authorization -eq 'Bearer token-xyz') 'Expected header runtime context summary to preserve authorization'

  $detail = (Invoke-Api 'GET' "$backendBaseUrl/api/recordings/sessions/$($session.id)").data
  Assert-True ($detail.session.summary.last_ingest_result.deduplicated -eq 1) 'Expected session summary to persist deduplicated count'

  $result = [pscustomobject]@{
    health = $health.status
    recording_session = $session.id
    inserted = $ingest.inserted
    deduplicated = $ingest.deduplicated
    event_page_total = $pagedEvents.pagination.total
    event_page_size = $pagedEvents.events.Count
    finish_status = $secondFinish.session.status
    workflow_draft_id = $secondFinish.workflow_drafts[0].id
    runtime_cookie_keys = @($candidates.runtime_context_summary.cookies.psobject.Properties.Name)
    runtime_header_keys = @($candidates.runtime_context_summary.headers.psobject.Properties.Name)
    summary_deduplicated = $detail.session.summary.last_ingest_result.deduplicated
  } | ConvertTo-Json -Depth 20

  Write-Output $result
}
catch {
  Write-Error $_
  exit 1
}
finally {
  if ($backend -and !$backend.HasExited) {
    Stop-Process -Id $backend.Id -Force
  }

  if ($mock -and !$mock.HasExited) {
    Stop-Process -Id $mock.Id -Force
  }
}
