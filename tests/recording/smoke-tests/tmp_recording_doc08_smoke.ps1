$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverDir = Join-Path $root 'server'
$backendPort = 3015
$backendBaseUrl = "http://localhost:$backendPort"
$mockBaseUrl = 'http://127.0.0.1:3108'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendLog = Join-Path $scriptDir 'tmp_recording_doc08_backend.log'
$backendErr = Join-Path $scriptDir 'tmp_recording_doc08_backend.err.log'
$mockLog = Join-Path $scriptDir 'tmp_recording_doc08_mock.log'
$mockErr = Join-Path $scriptDir 'tmp_recording_doc08_mock.err.log'
$resultLog = Join-Path $root 'tmp_recording_doc08_result.json'

Remove-Item $backendLog, $backendErr, $mockLog, $mockErr, $resultLog -ErrorAction SilentlyContinue

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
  -ArgumentList 'tests/recording/smoke-tests/tmp_recording_doc08_mock_server.js' `
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

  $timestamp = Get-Date -Format 'yyyyMMddHHmmss'

  $checkpoint = 'create-environment'
  $environment = (Invoke-Api 'POST' "$backendBaseUrl/api/environments" @{
      name = "Doc08 Environment $timestamp"
      base_url = $mockBaseUrl
      description = 'doc08 smoke environment'
      is_active = $true
    }).data

  $checkpoint = 'create-account'
  $account = (Invoke-Api 'POST' "$backendBaseUrl/api/accounts" @{
      name = "Doc08 Account $timestamp"
      username = 'doc08-user'
      status = 'active'
      fields = @{
        user_id = 'user-live-08'
        order_id = 'order-live-08'
      }
      auth_profile = @{ }
      variables = @{ }
    }).data

  $checkpoint = 'create-workflow-session'
  $workflowSession = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions" @{
      name = "Doc08 Workflow Session $timestamp"
      mode = 'workflow'
      source_tool = 'burp_montoya'
      environment_id = $environment.id
      account_id = $account.id
      role = 'attacker'
      target_fields = @(
        @{
          name = 'token'
          aliases = @('access_token')
          from_sources = @('response.body', 'response.header')
          bind_to_account_field = 'access_token'
          category = 'IDENTITY'
        },
        @{
          name = 'order_id'
          aliases = @('orderId')
          from_sources = @('response.body', 'request.path')
          bind_to_account_field = 'order_id'
          category = 'OBJECT_ID'
        }
      )
    }).data

  $checkpoint = 'ingest-workflow-events'
  $null = Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($workflowSession.id)/events/batch" @{
    events = @(
      @{
        sequence = 1
        method = 'POST'
        url = "$mockBaseUrl/api/auth/login"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          'content-type' = 'application/json'
        }
        requestBodyText = '{"username":"demo","password":"secret"}'
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"token":"token-recorded-08"}'
      },
      @{
        sequence = 2
        method = 'GET'
        url = "$mockBaseUrl/api/orders"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded-08'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"orders":[{"orderId":"order-recorded-08"}]}'
      },
      @{
        sequence = 3
        method = 'GET'
        url = "$mockBaseUrl/api/orders/order-recorded-08"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded-08'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"orderId":"order-recorded-08","state":"draft"}'
      },
      @{
        sequence = 4
        method = 'GET'
        url = "$mockBaseUrl/api/orders/order-recorded-08/status"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded-08'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"state":"processing"}'
      },
      @{
        sequence = 5
        method = 'GET'
        url = "$mockBaseUrl/api/orders/order-recorded-08/status"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded-08'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"state":"processing"}'
      },
      @{
        sequence = 6
        method = 'POST'
        url = "$mockBaseUrl/api/orders/order-recorded-08/submit"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded-08'
          'content-type' = 'application/json'
        }
        requestBodyText = '{"confirm":true}'
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"ok":true,"orderId":"order-recorded-08"}'
      }
    )
  }

  $checkpoint = 'finish-workflow-session'
  $workflowFinished = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($workflowSession.id)/finish").data
  Assert-True ($workflowFinished.workflow_drafts.Count -eq 1) "Expected 1 workflow draft, received $($workflowFinished.workflow_drafts.Count)"
  $workflowDraft = $workflowFinished.workflow_drafts[0]

  $checkpoint = 'publish-workflow'
  $publishedWorkflow = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/workflow-drafts/$($workflowDraft.id)/publish" @{
      published_by = 'doc08_smoke'
    }).data.workflow
  Assert-True ($publishedWorkflow.source_recording_session_id -eq $workflowSession.id) 'Expected published workflow to retain source_recording_session_id'

  $workflowLogs = @((Invoke-Api 'GET' "$backendBaseUrl/api/recordings/publish-logs?target_asset_type=workflow&target_asset_id=$($publishedWorkflow.id)").data)
  Assert-True ($workflowLogs.Count -ge 1) 'Expected at least one workflow publish log'
  Assert-True ($workflowLogs[0].source_draft_id -eq $workflowDraft.id) 'Expected workflow publish log to point back to the source draft'
  Assert-True ($workflowLogs[0].source_recording_session_id -eq $workflowSession.id) 'Expected workflow publish log to point back to the source recording session'

  $workflowTemplateLogs = @((Invoke-Api 'GET' "$backendBaseUrl/api/recordings/publish-logs?source_draft_id=$($workflowDraft.id)&target_asset_type=api_template").data)
  Assert-True ($workflowTemplateLogs.Count -ge 1) 'Expected workflow publish to create traced API template assets'
  $workflowStepTemplate = (Invoke-Api 'GET' "$backendBaseUrl/api/api-templates/$($workflowTemplateLogs[0].target_asset_id)").data
  Assert-True ($workflowStepTemplate.source_recording_session_id -eq $workflowSession.id) 'Expected workflow-generated template to retain source_recording_session_id'

  $checkpoint = 'create-api-session'
  $apiSession = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions" @{
      name = "Doc08 API Session $timestamp"
      mode = 'api'
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
          from_sources = @('request.path', 'request.body', 'response.body')
          bind_to_account_field = 'order_id'
          category = 'OBJECT_ID'
        }
      )
    }).data

  $checkpoint = 'ingest-api-events'
  $null = Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($apiSession.id)/events/batch" @{
    events = @(
      @{
        sequence = 1
        method = 'GET'
        url = "$mockBaseUrl/api/users?userId=user-live-08"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"userId":"user-live-08","displayName":"Recorded User"}'
      },
      @{
        sequence = 2
        method = 'GET'
        url = "$mockBaseUrl/api/orders/order-live-08"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"orderId":"order-live-08","state":"ready"}'
      },
      @{
        sequence = 3
        method = 'POST'
        url = "$mockBaseUrl/api/orders/order-live-08/submit"
        requestHeaders = @{
          Host = '127.0.0.1:3108'
          Accept = 'application/json'
          'content-type' = 'application/json'
        }
        requestBodyText = '{"userId":"user-live-08","confirm":true}'
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"ok":true,"orderId":"order-live-08","submitted":true}'
      }
    )
  }

  $checkpoint = 'finish-api-session'
  $apiFinished = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($apiSession.id)/finish").data
  Assert-True ($apiFinished.test_run_drafts.Count -eq 3) "Expected 3 API drafts, received $($apiFinished.test_run_drafts.Count)"

  $apiDraft = @($apiFinished.test_run_drafts | Where-Object { $_.summary.path -like '*/submit' })[0]
  Assert-True ($null -ne $apiDraft) 'Expected submit draft to exist for doc08 API promotion'

  $checkpoint = 'create-api-template'
  $publishedTemplate = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/test-run-drafts/$($apiDraft.id)/template" @{
      published_by = 'doc08_smoke'
    }).data.template
  Assert-True ($publishedTemplate.source_recording_session_id -eq $apiSession.id) 'Expected API template to retain source_recording_session_id'

  $templateLogs = @((Invoke-Api 'GET' "$backendBaseUrl/api/recordings/publish-logs?target_asset_type=api_template&target_asset_id=$($publishedTemplate.id)").data)
  Assert-True ($templateLogs.Count -ge 1) 'Expected API template publish log to exist'
  Assert-True ($templateLogs[0].source_draft_id -eq $apiDraft.id) 'Expected API template publish log to point back to the draft'
  Assert-True ($templateLogs[0].source_recording_session_id -eq $apiSession.id) 'Expected API template publish log to point back to the source recording session'

  $checkpoint = 'promote-formal-test-run'
  $promotedRunResult = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/test-run-drafts/$($apiDraft.id)/test-run" @{
      published_by = 'doc08_smoke'
    }).data
  $promotedRun = $promotedRunResult.test_run
  Assert-True ($promotedRun.source_recording_session_id -eq $apiSession.id) 'Expected formal test run to retain source_recording_session_id'
  Assert-True ($promotedRun.execution_params.recording_promotion.source_draft_id -eq $apiDraft.id) 'Expected formal test run to retain source draft trace'

  $storedRun = (Invoke-Api 'GET' "$backendBaseUrl/api/test-runs/$($promotedRun.id)").data
  Assert-True ($storedRun.source_recording_session_id -eq $apiSession.id) 'Expected stored formal test run to expose source_recording_session_id'
  Assert-True ($storedRun.execution_params.recording_promotion.source_draft_id -eq $apiDraft.id) 'Expected stored formal test run to expose source draft trace'

  $testRunLogs = @((Invoke-Api 'GET' "$backendBaseUrl/api/recordings/publish-logs?target_asset_type=test_run&target_asset_id=$($promotedRun.id)").data)
  Assert-True ($testRunLogs.Count -ge 1) 'Expected formal test run publish log to exist'
  Assert-True ($testRunLogs[0].source_draft_id -eq $apiDraft.id) 'Expected formal test run log to point back to the draft'
  Assert-True ($testRunLogs[0].source_recording_session_id -eq $apiSession.id) 'Expected formal test run log to point back to the recording session'

  $checkpoint = 'execute-formal-test-run'
  $null = Invoke-RestMethod -Uri "$mockBaseUrl/__reset" -Method Post -TimeoutSec 3
  $executedRun = (Invoke-Api 'POST' "$backendBaseUrl/api/run/template" @{
      test_run_id = $promotedRun.id
      template_ids = @($storedRun.template_ids)
      account_ids = @($storedRun.account_ids)
      environment_id = $storedRun.environment_id
    }).data
  Assert-True ($executedRun.success -eq $true) 'Expected formal promoted test run execution to succeed'

  $mockHistory = (Invoke-RestMethod -Uri "$mockBaseUrl/__history" -Method Get -TimeoutSec 3).requests
  $submitRequest = @($mockHistory | Where-Object { $_.path -eq '/api/orders/order-live-08/submit' })[0]
  Assert-True ($null -ne $submitRequest) 'Expected promoted formal test run to hit the live submit endpoint'
  Assert-True ($submitRequest.body -like '*user-live-08*') 'Expected promoted formal test run to inject live account user_id into the request body'

  $result = @{
    workflow_session_id = $workflowSession.id
    workflow_id = $publishedWorkflow.id
    workflow_source_recording_session_id = $publishedWorkflow.source_recording_session_id
    workflow_publish_log_source_draft_id = $workflowLogs[0].source_draft_id
    workflow_step_template_count = $workflowTemplateLogs.Count
    api_session_id = $apiSession.id
    api_template_id = $publishedTemplate.id
    formal_test_run_id = $promotedRun.id
    formal_test_run_source_recording_session_id = $promotedRun.source_recording_session_id
    formal_test_run_source_draft_id = $promotedRun.execution_params.recording_promotion.source_draft_id
    formal_test_run_execution_success = $executedRun.success
    formal_test_run_submit_path = $submitRequest.path
  }

  $result | ConvertTo-Json -Depth 20 | Set-Content -Path $resultLog -Encoding UTF8
  Write-Output ($result | ConvertTo-Json -Depth 20)
}
catch {
  Write-Error "doc08 smoke failed at checkpoint: $checkpoint"
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
