$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverDir = Join-Path $root 'server'
$backendPort = 3015
$backendBaseUrl = "http://localhost:$backendPort"
$mockBaseUrl = 'http://127.0.0.1:3108'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendLog = Join-Path $scriptDir 'tmp_recording_doc07_backend.log'
$backendErr = Join-Path $scriptDir 'tmp_recording_doc07_backend.err.log'
$mockLog = Join-Path $scriptDir 'tmp_recording_doc07_mock.log'
$mockErr = Join-Path $scriptDir 'tmp_recording_doc07_mock.err.log'

Remove-Item $backendLog, $backendErr, $mockLog, $mockErr -ErrorAction SilentlyContinue

$headers = @{}
if ($env:RECORDING_API_KEY) {
  $headers['x-recording-api-key'] = $env:RECORDING_API_KEY
}

$checkpoint = 'bootstrap'

function Stop-PortProcess([int]$Port) {
  try {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  } catch {
  }
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
    $params['Body'] = $Body | ConvertTo-Json -Depth 40
  }

  return Invoke-RestMethod @params
}

Stop-PortProcess -Port $backendPort
Stop-PortProcess -Port 3108

$mock = Start-Process -FilePath node `
  -ArgumentList 'tests/recording/smoke-tests/tmp_recording_doc07_mock_server.js' `
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
  $checkpoint = 'health-check'
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

  $checkpoint = 'create-environment'
  $environment = (Invoke-Api 'POST' "$backendBaseUrl/api/environments" @{
      name = "Doc07 Environment $(Get-Date -Format 'yyyyMMddHHmmss')"
      base_url = $mockBaseUrl
      description = 'doc07 smoke environment'
      is_active = $true
    }).data

  $checkpoint = 'create-account'
  $account = (Invoke-Api 'POST' "$backendBaseUrl/api/accounts" @{
      name = "Doc07 Account $(Get-Date -Format 'yyyyMMddHHmmss')"
      username = 'doc07-user'
      status = 'active'
      fields = @{}
      auth_profile = @{}
      variables = @{}
    }).data

  $checkpoint = 'create-session'
  $session = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions" @{
      name = "Doc07 Workflow Session $(Get-Date -Format 'yyyyMMddHHmmss')"
      mode = 'workflow'
      source_tool = 'burp_montoya'
      environment_id = $environment.id
      account_id = $account.id
      role = 'attacker'
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
    }).data

  $checkpoint = 'ingest-events'
  $null = Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/events/batch" @{
    events = @(
      @{
        sequence = 1
        method = 'POST'
        url = "$mockBaseUrl/auth/login"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          'content-type' = 'application/json'
        }
        requestBodyText = '{"username":"doc07-user","password":"secret123"}'
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
          'set-cookie' = 'JSESSIONID=sess-live-abc; Path=/; HttpOnly'
        }
        responseBodyText = '{"access_token":"token-live-xyz","userId":"user-live-001"}'
      },
      @{
        sequence = 2
        method = 'GET'
        url = "$mockBaseUrl/api/orders/ord-live-123?userId=user-live-001"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          Authorization = 'Bearer token-live-xyz'
          Cookie = 'JSESSIONID=sess-live-abc'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"orderId":"ord-live-123","userId":"user-live-001","status":"ready"}'
      },
      @{
        sequence = 3
        method = 'POST'
        url = "$mockBaseUrl/api/orders/ord-live-123/submit"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          Authorization = 'Bearer token-live-xyz'
          Cookie = 'JSESSIONID=sess-live-abc'
          'content-type' = 'application/json'
        }
        requestBodyText = '{"userId":"user-live-001","confirm":true}'
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"ok":true,"orderId":"ord-live-123","submitted":true}'
      }
    )
  }

  $checkpoint = 'finish-session'
  $detail = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/finish").data
  Assert-True ($detail.runtime_context_summary.values.access_token -eq 'token-live-xyz') 'Expected access_token to land in runtime context summary'
  Assert-True ($detail.runtime_context_summary.cookies.JSESSIONID -eq 'sess-live-abc') 'Expected JSESSIONID cookie to land in runtime context summary'
  Assert-True (@($detail.field_hits | Where-Object { $_.field_name -eq 'user_id' }).Count -ge 1) 'Expected user_id field hits'
  Assert-True (@($detail.field_hits | Where-Object { $_.field_name -eq 'order_id' -and $_.source_location -eq 'request.path' }).Count -ge 1) 'Expected order_id request.path field hit'

  $workflowDraft = @($detail.workflow_drafts)[0]
  Assert-True ($null -ne $workflowDraft) 'Expected workflow draft to be generated'
  $workflowContextCandidates = @($workflowDraft.variable_candidates | Where-Object { $_.data_source -eq 'workflow_context' })
  Assert-True (@($workflowContextCandidates | Where-Object { $_.runtime_context_key -eq 'access_token' }).Count -ge 1) 'Expected workflow_context access_token candidate'
  Assert-True (@($workflowContextCandidates | Where-Object { $_.runtime_context_key -eq 'authorization' -or $_.source_location -eq 'request.path' }).Count -ge 1) 'Expected downstream workflow context suggestions'

  $checkpoint = 'preview-session-only'
  $preview = (Invoke-Api 'GET' "$backendBaseUrl/api/recordings/sessions/$($session.id)/account-preview?account_id=$($account.id)&mode=session_only").data
  Assert-True ($preview.summary.total_changes -ge 4) 'Expected preview to include account linkage changes'
  Assert-True (@($preview.field_changes | Where-Object { $_.target_path -eq 'user_id' }).Count -ge 1) 'Expected preview field change for user_id'
  Assert-True (@($preview.auth_profile_changes | Where-Object { $_.target_path -eq 'access_token' }).Count -ge 1) 'Expected preview auth change for access_token'
  Assert-True (@($preview.auth_profile_changes | Where-Object { $_.target_path -eq 'cookies.JSESSIONID' }).Count -ge 1) 'Expected preview auth cookie change for JSESSIONID'

  $checkpoint = 'apply-session-only'
  $sessionOnlyApply = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/apply-account" @{
      account_id = $account.id
      mode = 'session_only'
      applied_by = 'doc07_smoke'
    }).data
  Assert-True ($sessionOnlyApply.persisted -eq $false) 'Expected session-only apply to avoid persistence'

  $accountAfterSessionOnly = (Invoke-Api 'GET' "$backendBaseUrl/api/accounts/$($account.id)").data
  Assert-True (-not $accountAfterSessionOnly.fields.user_id) 'Expected session-only apply to keep account fields unchanged'
  Assert-True (-not $accountAfterSessionOnly.auth_profile.access_token) 'Expected session-only apply to keep auth_profile unchanged'

  $detailAfterSessionOnly = (Invoke-Api 'GET' "$backendBaseUrl/api/recordings/sessions/$($session.id)").data
  Assert-True ($detailAfterSessionOnly.account_linkage.mode -eq 'session_only') 'Expected recording detail to keep session-only linkage summary'
  Assert-True (@($detailAfterSessionOnly.account_apply_logs).Count -ge 1) 'Expected recording detail to expose account apply logs'

  $checkpoint = 'apply-write-back'
  $writeBackApply = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/apply-account" @{
      account_id = $account.id
      mode = 'write_back'
      applied_by = 'doc07_smoke'
    }).data
  Assert-True ($writeBackApply.persisted -eq $true) 'Expected write-back apply to persist account changes'

  $accountAfterWriteBack = (Invoke-Api 'GET' "$backendBaseUrl/api/accounts/$($account.id)").data
  Assert-True ($accountAfterWriteBack.fields.user_id -eq 'user-live-001') 'Expected write-back to persist user_id field'
  Assert-True ($accountAfterWriteBack.fields.order_id -eq 'ord-live-123') 'Expected write-back to persist order_id field'
  Assert-True ($accountAfterWriteBack.auth_profile.access_token -eq 'token-live-xyz') 'Expected write-back to persist access_token in auth_profile'
  Assert-True ($accountAfterWriteBack.auth_profile.authorization -eq 'Bearer token-live-xyz') 'Expected write-back to persist authorization in auth_profile'
  Assert-True ($accountAfterWriteBack.auth_profile.session_id -eq 'sess-live-abc') 'Expected write-back to persist session_id alias in auth_profile'
  Assert-True ($accountAfterWriteBack.auth_profile.cookies.JSESSIONID -eq 'sess-live-abc') 'Expected write-back to persist raw cookie in auth_profile.cookies'
  Assert-True ($accountAfterWriteBack.variables.'recording.user_id' -eq 'user-live-001') 'Expected write-back to persist recording variable for user_id'

  $checkpoint = 'account-log-endpoint'
  $accountLogs = @((Invoke-Api 'GET' "$backendBaseUrl/api/accounts/recording-apply-logs?account_id=$($account.id)").data)
  Assert-True ($accountLogs.Count -ge 2) 'Expected account recording apply log endpoint to return both apply attempts'
  Assert-True (@($accountLogs | Where-Object { $_.mode -eq 'session_only' }).Count -ge 1) 'Expected session_only log entry'
  Assert-True (@($accountLogs | Where-Object { $_.mode -eq 'write_back' }).Count -ge 1) 'Expected write_back log entry'

  $checkpoint = 'execute-template-with-auth-profile'
  $template = (Invoke-Api 'POST' "$backendBaseUrl/api/api-templates" @{
      name = "Doc07 Account Linkage Template $(Get-Date -Format 'yyyyMMddHHmmss')"
      group_name = 'doc07'
      description = 'Verifies account linkage values can be consumed by template execution'
      raw_request = @"
GET /api/profile?userId=user-recorded HTTP/1.1
Host: 127.0.0.1:3108
Accept: application/json
Authorization: Bearer token-recorded
Cookie: JSESSIONID=sess-recorded

"@
      parsed_structure = @{
        method = 'GET'
        path = '/api/profile?userId=user-recorded'
        headers = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded'
          Cookie = 'JSESSIONID=sess-recorded'
        }
      }
      variables = @(
        @{
          name = 'user_id'
          json_path = 'query.userId'
          operation_type = 'replace'
          original_value = 'user-recorded'
          data_source = 'account_field'
          account_field_name = 'user_id'
        },
        @{
          name = 'authorization'
          json_path = 'headers.Authorization'
          operation_type = 'replace'
          original_value = 'Bearer token-recorded'
          data_source = 'account_field'
          account_field_name = 'authorization'
        },
        @{
          name = 'session_id'
          json_path = 'cookies.JSESSIONID'
          operation_type = 'replace'
          original_value = 'sess-recorded'
          data_source = 'account_field'
          account_field_name = 'session_id'
        }
      )
      failure_patterns = @(
        @{
          type = 'http_status'
          operator = 'not_equals'
          value = '200'
        }
      )
      failure_logic = 'OR'
      is_active = $true
      account_binding_strategy = 'per_account'
    }).data

  $null = Invoke-RestMethod -Uri "$mockBaseUrl/__reset" -Method Post -TimeoutSec 3
  try {
    $null = Invoke-RestMethod -Uri "$backendBaseUrl/api/debug/last/template" -Method Delete -TimeoutSec 3
  } catch {
  }
  $templateRun = (Invoke-Api 'POST' "$backendBaseUrl/api/run/template" @{
      template_ids = @($template.id)
      account_ids = @($account.id)
      environment_id = $environment.id
    }).data
  Assert-True ($templateRun.success -eq $true) 'Expected template execution with account linkage data to succeed'

  $templateTrace = (Invoke-Api 'GET' "$backendBaseUrl/api/debug/last/template").data
  Assert-True ($templateTrace.summary.total_requests -eq 1) 'Expected template debug trace to capture one outbound request'
  $profileRequest = @($templateTrace.records | Where-Object { $_.url -like '*/api/profile*' })[0]
  Assert-True ($null -ne $profileRequest) 'Expected template debug trace to include /api/profile request'
  Assert-True ($profileRequest.url -eq "$mockBaseUrl/api/profile?userId=user-live-001") 'Expected template execution to inject live user_id'
  Assert-True ($profileRequest.response.status -eq 200) 'Expected template execution to receive HTTP 200'
  Assert-True ($profileRequest.response.body -match '"userId":"user-live-001"') 'Expected template response to reflect live user_id'
  Assert-True ($profileRequest.response.body -match '"authorization":"Bearer token-live-xyz"') 'Expected template execution to read authorization from auth_profile'
  Assert-True ($profileRequest.response.body -match '"session":"sess-live-abc"') 'Expected template execution to read session cookie from auth_profile'

  $checkpoint = 'final-detail'
  $finalDetail = (Invoke-Api 'GET' "$backendBaseUrl/api/recordings/sessions/$($session.id)").data
  Assert-True (@($finalDetail.account_apply_logs | Where-Object { $_.mode -eq 'write_back' }).Count -ge 1) 'Expected final session detail to include write-back log'

  Write-Output ([pscustomobject]@{
    workflow_context_candidates = $workflowContextCandidates.Count
    preview_changes = $preview.summary.total_changes
    apply_logs = $accountLogs.Count
    template_run_success = $templateRun.success
    persisted_user_id = $accountAfterWriteBack.fields.user_id
    persisted_access_token = $accountAfterWriteBack.auth_profile.access_token
  } | ConvertTo-Json -Depth 6)
}
catch {
  Write-Error "Checkpoint '$checkpoint' failed: $($_.Exception.Message)"
  if (Test-Path $backendErr) {
    Write-Host "`n[backend stderr]" -ForegroundColor Yellow
    Get-Content $backendErr
  }
  if (Test-Path $mockErr) {
    Write-Host "`n[mock stderr]" -ForegroundColor Yellow
    Get-Content $mockErr
  }
  throw
}
finally {
  if ($backend -and -not $backend.HasExited) {
    Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
  }
  if ($mock -and -not $mock.HasExited) {
    Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue
  }
}
