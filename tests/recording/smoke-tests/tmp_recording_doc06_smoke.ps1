$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverDir = Join-Path $root 'server'
$backendPort = 3014
$backendBaseUrl = "http://localhost:$backendPort"
$mockBaseUrl = 'http://127.0.0.1:3107'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendLog = Join-Path $scriptDir 'tmp_recording_doc06_backend.log'
$backendErr = Join-Path $scriptDir 'tmp_recording_doc06_backend.err.log'
$mockLog = Join-Path $scriptDir 'tmp_recording_doc06_mock.log'
$mockErr = Join-Path $scriptDir 'tmp_recording_doc06_mock.err.log'

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
    $params['Body'] = $Body | ConvertTo-Json -Depth 30
  }

  return Invoke-RestMethod @params
}

Stop-PortProcess -Port $backendPort
Stop-PortProcess -Port 3107

$mock = Start-Process -FilePath node `
  -ArgumentList 'tests/recording/smoke-tests/tmp_recording_doc06_mock_server.js' `
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
      name = "Doc06 Environment $(Get-Date -Format 'yyyyMMddHHmmss')"
      base_url = $mockBaseUrl
      description = 'doc06 smoke environment'
      is_active = $true
    }).data

  $checkpoint = 'create-account'
  $account = (Invoke-Api 'POST' "$backendBaseUrl/api/accounts" @{
      name = "Doc06 Account $(Get-Date -Format 'yyyyMMddHHmmss')"
      username = 'doc06-user'
      status = 'active'
      fields = @{
        user_id = 'user-live-001'
        order_id = 'order-live-001'
      }
      auth_profile = @{ }
      variables = @{ }
    }).data

  $checkpoint = 'create-session'
  $session = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions" @{
      name = "Doc06 API Session $(Get-Date -Format 'yyyyMMddHHmmss')"
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

  $checkpoint = 'ingest-events'
  $null = Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/events/batch" @{
    events = @(
      @{
        sequence = 1
        method = 'GET'
        url = "$mockBaseUrl/api/users?userId=user-live-001"
        requestHeaders = @{
          Host = '127.0.0.1:3107'
          Accept = 'application/json'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"userId":"user-live-001","displayName":"Recorded User"}'
      },
      @{
        sequence = 2
        method = 'GET'
        url = "$mockBaseUrl/api/orders/order-live-001"
        requestHeaders = @{
          Host = '127.0.0.1:3107'
          Accept = 'application/json'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"orderId":"order-live-001","state":"ready"}'
      },
      @{
        sequence = 3
        method = 'POST'
        url = "$mockBaseUrl/api/orders/order-live-001/submit"
        requestHeaders = @{
          Host = '127.0.0.1:3107'
          Accept = 'application/json'
          'content-type' = 'application/json'
        }
        requestBodyText = '{"userId":"user-live-001","confirm":true}'
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"ok":true,"orderId":"order-live-001","submitted":true}'
      }
    )
  }

  $checkpoint = 'finish-session'
  $finished = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/finish").data
  $sessionDrafts = @($finished.test_run_drafts)
  Assert-True ($sessionDrafts.Count -eq 3) "Expected 3 API drafts, received $($sessionDrafts.Count)"
  Assert-True (@($sessionDrafts | Where-Object { $_.status -eq 'preconfigured' }).Count -eq 3) 'Expected all generated drafts to be preconfigured'

  $checkpoint = 'list-drafts'
  $draftList = @((Invoke-Api 'GET' "$backendBaseUrl/api/recordings/test-run-drafts").data | Where-Object { $_.session_id -eq $session.id })
  Assert-True ($draftList.Count -eq 3) "Expected dedicated draft list endpoint to return 3 drafts for the session, received $($draftList.Count)"

  $allFieldCandidates = @(
    $draftList | ForEach-Object {
      @($_.draft_payload.template.field_candidates)
    }
  )
  $userCandidate = @($allFieldCandidates | Where-Object {
      ([string]$_.name -like '*user*') -or ([string]$_.field_name -like '*user*')
    } | Where-Object { [string]$_.json_path -like '*user*' })
  $orderCandidate = @($allFieldCandidates | Where-Object {
      ([string]$_.name -like '*order*') -or ([string]$_.field_name -like '*order*')
    } | Where-Object { ([string]$_.json_path -like '*order*') -or ([string]$_.source_location -like '*path*') })
  Assert-True ($userCandidate.Count -ge 1) 'Expected userId-related field candidates in API drafts'
  Assert-True ($orderCandidate.Count -ge 1) 'Expected orderId-related field candidates in API drafts'

  $editableDraft = $draftList | Where-Object { $_.summary.path -like '*/submit' } | Select-Object -First 1
  Assert-True ($null -ne $editableDraft) 'Expected submit draft to exist for editing'

  $checkpoint = 'update-draft'
  $null = (Invoke-Api 'PUT' "$backendBaseUrl/api/recordings/test-run-drafts/$($editableDraft.id)" @{
      name = "$($editableDraft.name) Reviewed"
      template = @{
        name = 'Reviewed Submit Template'
        description = 'Edited in the doc06 workspace'
        variables = @($editableDraft.draft_payload.template.variables)
        failure_patterns = @(
          @{
            type = 'http_status'
            operator = 'not_equals'
            value = '200'
          }
        )
        failure_logic = 'OR'
      }
      preset = @{
        name = 'Reviewed Submit Preset'
        description = 'Doc06 reviewed preset'
        environment_id = $environment.id
        default_account_id = $account.id
      }
    }).data

  $updatedDetail = (Invoke-Api 'GET' "$backendBaseUrl/api/recordings/sessions/$($session.id)").data
  $updatedDraft = @($updatedDetail.test_run_drafts | Where-Object { $_.id -eq $editableDraft.id })[0]
  Assert-True ($updatedDraft.name -like '*Reviewed') 'Expected API draft rename to persist after update'
  Assert-True ($updatedDraft.draft_payload.template.name -eq 'Reviewed Submit Template') 'Expected edited template name to persist'
  Assert-True (@($updatedDraft.draft_payload.template.failure_patterns).Count -eq 1) 'Expected failure pattern edit to persist'
  Assert-True ($updatedDraft.draft_payload.preset.default_account_id -eq $account.id) 'Expected draft preset account binding to persist'

  $checkpoint = 'publish-preset'
  $published = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/test-run-drafts/$($editableDraft.id)/publish" @{
      published_by = 'doc06_smoke'
    }).data
  Assert-True ($null -ne $published.preset.id) 'Expected preset publish to return a preset id'
  Assert-True ($null -ne $published.template.id) 'Expected preset publish to create a backing API template'

  $checkpoint = 'execute-preset'
  $null = Invoke-RestMethod -Uri "$mockBaseUrl/__reset" -Method Post -TimeoutSec 3
  $presetRun = (Invoke-Api 'POST' "$backendBaseUrl/api/run/preset" @{
      preset_id = $published.preset.id
      name = 'Doc06 Preset Execution'
    }).data
  Assert-True ($presetRun.success -eq $true) 'Expected published preset execution to succeed'

  $mockHistory = (Invoke-RestMethod -Uri "$mockBaseUrl/__history" -Method Get -TimeoutSec 3).requests
  $submitRequest = @($mockHistory | Where-Object { $_.path -eq '/api/orders/order-live-001/submit' })[0]
  Assert-True ($null -ne $submitRequest) 'Expected preset execution to hit the live submit endpoint'
  Assert-True ($submitRequest.body -like '*user-live-001*') 'Expected preset execution to inject live account user_id into the request body'

  $templateDraft = $draftList | Where-Object { $_.id -ne $editableDraft.id } | Select-Object -First 1
  Assert-True ($null -ne $templateDraft) 'Expected another API draft for direct template promotion'

  $checkpoint = 'create-template'
  $templateResult = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/test-run-drafts/$($templateDraft.id)/template" @{
      published_by = 'doc06_smoke'
    }).data
  Assert-True ($null -ne $templateResult.template.id) 'Expected direct template creation to return a template id'

  $draftListAfterTemplate = @((Invoke-Api 'GET' "$backendBaseUrl/api/recordings/test-run-drafts").data | Where-Object { $_.session_id -eq $session.id })
  $templateDraftAfterPromotion = @($draftListAfterTemplate | Where-Object { $_.id -eq $templateDraft.id })[0]
  Assert-True (($templateDraftAfterPromotion.summary.published_template_count -as [int]) -ge 1) 'Expected template promotion count to be reflected on the draft'

  $checkpoint = 'regenerate'
  $regenerated = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/regenerate").data
  $regeneratedDrafts = @($regenerated.test_run_drafts)
  Assert-True ($regeneratedDrafts.Count -eq 3) "Expected regenerate to keep the session at 3 API drafts, received $($regeneratedDrafts.Count)"
  Assert-True (@($regeneratedDrafts | Where-Object { $_.source_event_id } | Group-Object source_event_id | Where-Object { $_.Count -gt 1 }).Count -eq 0) 'Expected regenerate to avoid duplicate drafts for the same source event'
  Assert-True (@($regeneratedDrafts | Where-Object { $_.id -eq $templateDraft.id }).Count -eq 1) 'Expected template-promoted draft to survive regenerate without duplication'

  $result = [pscustomobject]@{
    health = $health.status
    session_id = $session.id
    generated_drafts = $sessionDrafts.Count
    listed_drafts = $draftList.Count
    edited_draft_id = $editableDraft.id
    published_preset_id = $published.preset.id
    preset_run_success = $presetRun.success
    direct_template_id = $templateResult.template.id
    regenerated_draft_count = $regeneratedDrafts.Count
  } | ConvertTo-Json -Depth 10

  Write-Output $result
}
catch {
  Write-Error "Checkpoint [$checkpoint] failed: $($_.Exception.Message)"
  throw
}
finally {
  if ($backend -and !$backend.HasExited) {
    Stop-Process -Id $backend.Id -Force
  }

  if ($mock -and !$mock.HasExited) {
    Stop-Process -Id $mock.Id -Force
  }

  Stop-PortProcess -Port $backendPort
  Stop-PortProcess -Port 3107
}
