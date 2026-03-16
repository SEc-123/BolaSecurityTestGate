$ErrorActionPreference = 'Stop'

$root = 'c:\Users\Administrator\Documents\BSTG'
$serverDir = Join-Path $root 'server'
$backendPort = 3012
$backendBaseUrl = "http://localhost:$backendPort"
$backendLog = Join-Path $root 'tmp_recording_backend.log'
$backendErr = Join-Path $root 'tmp_recording_backend.err.log'
$mockLog = Join-Path $root 'tmp_recording_mock.log'
$mockErr = Join-Path $root 'tmp_recording_mock.err.log'

Remove-Item $backendLog, $backendErr, $mockLog, $mockErr -ErrorAction SilentlyContinue

$headers = @{}
if ($env:RECORDING_API_KEY) {
  $headers['x-recording-api-key'] = $env:RECORDING_API_KEY
}

$mock = Start-Process -FilePath node `
  -ArgumentList 'tmp_recording_mock_server.js' `
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

  $environment = (Invoke-Api 'POST' "$backendBaseUrl/api/environments" @{
      name = 'Recording Mock'
      base_url = 'http://127.0.0.1:3105'
      description = 'mock env'
      is_active = $true
    }).data

  $account = (Invoke-Api 'POST' "$backendBaseUrl/api/accounts" @{
      name = 'Recorded User'
      username = 'user123'
      status = 'active'
      fields = @{ user_id = 'user-123' }
      auth_profile = @{}
      variables = @{}
    }).data

  $workflowSession = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions" @{
      name = 'Workflow Recording Smoke'
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

  $null = Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($workflowSession.id)/events/batch" @{
    events = @(
      @{
        sequence = 1
        method = 'GET'
        url = 'http://127.0.0.1:3105/workflow/profile?user_id=user-123'
        requestHeaders = @{
          Host = '127.0.0.1:3105'
          Accept = 'application/json'
          Cookie = 'session_id=session-abc'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
          'set-cookie' = 'session_id=session-abc; Path=/; HttpOnly'
          'x-access-token' = 'token-xyz'
        }
        responseBodyText = '{"user_id":"user-123","token":"token-xyz"}'
      }
    )
  }

  $workflowDetail = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($workflowSession.id)/finish").data
  $workflowDraftId = $workflowDetail.workflow_drafts[0].id
  $publishedWorkflow = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/workflow-drafts/$workflowDraftId/publish" @{
      published_by = 'smoke_test'
    }).data
  $appliedAccount = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($workflowSession.id)/apply-account" @{
      account_id = $account.id
    }).data

  $apiSession = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions" @{
      name = 'API Recording Smoke'
      mode = 'api'
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
        }
      )
    }).data

  $null = Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($apiSession.id)/events/batch" @{
    events = @(
      @{
        sequence = 1
        method = 'POST'
        url = 'http://127.0.0.1:3105/api/orders?user_id=user-123'
        requestHeaders = @{
          Host = '127.0.0.1:3105'
          Accept = 'application/json'
          'content-type' = 'application/json'
        }
        requestBodyText = '{"user_id":"user-123","action":"create"}'
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"ok":true,"user_id":"user-123"}'
      }
    )
  }

  $apiDetail = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($apiSession.id)/finish").data
  $apiDraftId = $apiDetail.test_run_drafts[0].id
  $publishedPreset = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/test-run-drafts/$apiDraftId/publish" @{
      published_by = 'smoke_test'
    }).data
  $presetList = (Invoke-RestMethod -Uri "$backendBaseUrl/api/test-run-presets" -Method Get).data
  $presetRun = (Invoke-Api 'POST' "$backendBaseUrl/api/run/preset" @{
      preset_id = $publishedPreset.preset.id
      name = 'Preset Smoke Run'
    }).data

  $result = [pscustomobject]@{
    health = $health.status
    workflow_session = $workflowSession.id
    workflow_drafts = $workflowDetail.workflow_drafts.Count
    published_workflow = $publishedWorkflow.workflow.id
    applied_account_access_token = $appliedAccount.auth_profile.access_token
    api_session = $apiSession.id
    api_drafts = $apiDetail.test_run_drafts.Count
    preset_id = $publishedPreset.preset.id
    preset_count = $presetList.Count
    preset_run_test_run_id = $presetRun.test_run_id
    preset_run_success = $presetRun.success
  } | ConvertTo-Json -Depth 10

  Write-Output $result
}
finally {
  if ($backend -and !$backend.HasExited) {
    Stop-Process -Id $backend.Id -Force
  }

  if ($mock -and !$mock.HasExited) {
    Stop-Process -Id $mock.Id -Force
  }
}
