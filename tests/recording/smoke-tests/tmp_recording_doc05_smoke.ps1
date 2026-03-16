$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverDir = Join-Path $root 'server'
$backendPort = 3013
$backendBaseUrl = "http://localhost:$backendPort"
$mockBaseUrl = 'http://127.0.0.1:3106'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendLog = Join-Path $scriptDir 'tmp_recording_doc05_backend.log'
$backendErr = Join-Path $scriptDir 'tmp_recording_doc05_backend.err.log'
$mockLog = Join-Path $scriptDir 'tmp_recording_doc05_mock.log'
$mockErr = Join-Path $scriptDir 'tmp_recording_doc05_mock.err.log'
$traceLog = Join-Path $root 'tmp_recording_doc05_trace.json'

Remove-Item $backendLog, $backendErr, $mockLog, $mockErr, $traceLog -ErrorAction SilentlyContinue

$headers = @{}
if ($env:RECORDING_API_KEY) {
  $headers['x-recording-api-key'] = $env:RECORDING_API_KEY
}

$checkpoint = 'bootstrap'

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

$mock = Start-Process -FilePath node `
  -ArgumentList 'tests/recording/smoke-tests/tmp_recording_doc05_mock_server.js' `
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
      name = "Doc05 Environment $(Get-Date -Format 'yyyyMMddHHmmss')"
      base_url = $mockBaseUrl
      description = 'doc05 smoke environment'
      is_active = $true
    }).data

  $checkpoint = 'create-account'
  $account = (Invoke-Api 'POST' "$backendBaseUrl/api/accounts" @{
      name = "Doc05 Account $(Get-Date -Format 'yyyyMMddHHmmss')"
      username = 'doc05-user'
      status = 'active'
      fields = @{ order_id = 'ord-account' }
      auth_profile = @{ }
      variables = @{ }
    }).data

  $checkpoint = 'create-session'
  $session = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions" @{
      name = "Doc05 Workflow Session $(Get-Date -Format 'yyyyMMddHHmmss')"
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
          from_sources = @('response.body')
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
        url = "$mockBaseUrl/api/auth/login"
        requestHeaders = @{
          Host = '127.0.0.1:3106'
          Accept = 'application/json'
          'content-type' = 'application/json'
        }
        requestBodyText = '{"username":"demo","password":"secret"}'
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"token":"token-recorded"}'
      },
      @{
        sequence = 2
        method = 'GET'
        url = "$mockBaseUrl/api/orders"
        requestHeaders = @{
          Host = '127.0.0.1:3106'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"orders":[{"orderId":"ord-recorded"}]}'
      },
      @{
        sequence = 3
        method = 'GET'
        url = "$mockBaseUrl/api/orders/ord-recorded"
        requestHeaders = @{
          Host = '127.0.0.1:3106'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded'
        }
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"orderId":"ord-recorded","state":"draft"}'
      },
      @{
        sequence = 4
        method = 'GET'
        url = "$mockBaseUrl/api/orders/ord-recorded/status"
        requestHeaders = @{
          Host = '127.0.0.1:3106'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded'
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
        url = "$mockBaseUrl/api/orders/ord-recorded/status"
        requestHeaders = @{
          Host = '127.0.0.1:3106'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded'
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
        url = "$mockBaseUrl/api/orders/ord-recorded/submit"
        requestHeaders = @{
          Host = '127.0.0.1:3106'
          Accept = 'application/json'
          Authorization = 'Bearer token-recorded'
          'content-type' = 'application/json'
        }
        requestBodyText = '{"confirm":true}'
        responseStatus = 200
        responseHeaders = @{
          'content-type' = 'application/json'
        }
        responseBodyText = '{"ok":true,"orderId":"ord-recorded"}'
      }
    )
  }

  $checkpoint = 'finish-session'
  $finished = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/sessions/$($session.id)/finish").data
  Assert-True ($finished.workflow_drafts.Count -eq 1) "Expected 1 workflow draft, received $($finished.workflow_drafts.Count)"

  $draft = $finished.workflow_drafts[0]
  Assert-True ($draft.steps.Count -eq 4) "Expected 4 generated workflow steps, received $($draft.steps.Count)"

  $stepSequences = @($draft.steps | ForEach-Object { [int]$_.sequence })
  Assert-True (($stepSequences -join ',') -eq '1,2,3,4') "Expected contiguous draft sequences 1,2,3,4 but received $($stepSequences -join ',')"

  $tokenInjection = @($draft.variable_candidates | Where-Object {
      $_.data_source -eq 'workflow_context' -and $_.json_path -eq 'headers.authorization'
    })
  Assert-True ($tokenInjection.Count -ge 1) 'Expected a workflow_context header injection candidate for Authorization'
  Assert-True ($tokenInjection[0].advanced_config.value_template -eq 'Bearer {{value}}') 'Expected Authorization injection to preserve Bearer prefix'

  $pathInjection = @($draft.variable_candidates | Where-Object {
      $_.data_source -eq 'workflow_context' -and $_.json_path -eq 'path.order_id'
    })
  Assert-True ($pathInjection.Count -ge 1) 'Expected a workflow_context request.path injection candidate for order_id'
  Assert-True ($pathInjection[0].advanced_config.path_replacement_mode -eq 'segment_index') 'Expected request.path injection to use segment_index replacement'

  $loginStep = $draft.steps | Where-Object { $_.path -eq '/api/auth/login' } | Select-Object -First 1
  $listStep = $draft.steps | Where-Object { $_.path -eq '/api/orders' } | Select-Object -First 1
  $detailStep = $draft.steps | Where-Object { $_.path -eq '/api/orders/ord-recorded' } | Select-Object -First 1
  $submitStep = $draft.steps | Where-Object { $_.path -eq '/api/orders/ord-recorded/submit' } | Select-Object -First 1

  Assert-True ($null -ne $loginStep) 'Expected login step in workflow draft'
  Assert-True ($null -ne $listStep) 'Expected list step in workflow draft'
  Assert-True ($null -ne $detailStep) 'Expected detail step in workflow draft'
  Assert-True ($null -ne $submitStep) 'Expected submit step in workflow draft'

  $checkpoint = 'edit-draft'
  $updated = (Invoke-Api 'PUT' "$backendBaseUrl/api/recordings/workflow-drafts/$($draft.id)" @{
      name = "$($draft.name) Reviewed"
      steps = @(
        @{
          id = $loginStep.id
          sequence = 1
          enabled = $true
          name = 'Login Request'
          description = 'Keep login as the first workflow step.'
        },
        @{
          id = $listStep.id
          sequence = 2
          enabled = $true
          name = 'Orders List'
          description = 'Extract the live order id from the list response.'
        },
        @{
          id = $submitStep.id
          sequence = 3
          enabled = $true
          name = 'Submit Order'
          description = 'Publish with the renamed submit step.'
        },
        @{
          id = $detailStep.id
          sequence = 4
          enabled = $false
          name = 'Order Detail'
          description = 'Disabled before publish to validate editor closure.'
        }
      )
      extractor_candidates = $draft.extractor_candidates
      variable_candidates = $draft.variable_candidates
    }).data

  $updated = (Invoke-Api 'GET' "$backendBaseUrl/api/recordings/sessions/$($session.id)").data
  $updatedDraft = $updated.workflow_drafts | Where-Object { $_.id -eq $draft.id } | Select-Object -First 1
  Assert-True ($updatedDraft.name -like '*Reviewed') 'Expected workflow draft rename to persist'
  Assert-True (@($updatedDraft.steps | Where-Object { $_.enabled -eq $false }).Count -eq 1) 'Expected exactly one disabled step after edit'
  Assert-True ((($updatedDraft.steps | Sort-Object sequence | Select-Object -ExpandProperty sequence) -join ',') -eq '1,2,3,4') 'Expected edited step order to persist'

  $checkpoint = 'publish-draft'
  $published = (Invoke-Api 'POST' "$backendBaseUrl/api/recordings/workflow-drafts/$($draft.id)/publish" @{
      published_by = 'doc05_smoke'
    }).data

  $workflowFull = (Invoke-Api 'GET' "$backendBaseUrl/api/workflows/$($published.workflow.id)/full").data
  Assert-True ($workflowFull.steps.Count -eq 3) "Expected 3 published workflow steps after disabling one step, received $($workflowFull.steps.Count)"
  Assert-True (@($workflowFull.steps | Where-Object { $_.snapshot_template_name -eq 'Submit Order' }).Count -eq 1) 'Expected renamed submit step to be published'
  Assert-True (@($workflowFull.steps | Where-Object { $_.snapshot_template_name -eq 'Order Detail' }).Count -eq 0) 'Disabled step should not be published'

  $workflowPathConfig = $workflowFull.variable_configs | Where-Object {
    $_.name -eq 'order_id' -and (@($_.step_variable_mappings | Where-Object { $_.json_path -eq 'path.order_id' }).Count -ge 1)
  } | Select-Object -First 1
  Assert-True ($null -ne $workflowPathConfig) 'Expected published workflow variable config for request.path order_id injection'
  Assert-True ($workflowPathConfig.advanced_config.path_replacement_mode -eq 'segment_index') 'Expected published request.path config to preserve segment_index replacement'

  $workflowHeaderConfig = $workflowFull.variable_configs | Where-Object {
    $_.name -eq 'access_token' -and (@($_.step_variable_mappings | Where-Object { $_.json_path -eq 'headers.authorization' }).Count -ge 1)
  } | Select-Object -First 1
  Assert-True ($null -ne $workflowHeaderConfig) 'Expected published workflow variable config for Authorization injection'

  $publishedExtractorNames = @($workflowFull.extractors | ForEach-Object { $_.name })
  Assert-True ($publishedExtractorNames -contains 'access_token') 'Expected published extractor for access_token'
  Assert-True ($publishedExtractorNames -contains 'order_id') 'Expected published extractor for order_id'

  $checkpoint = 'reset-mock'
  $null = Invoke-RestMethod -Uri "$mockBaseUrl/__reset" -Method Post -TimeoutSec 3

  $checkpoint = 'run-workflow'
  $run = (Invoke-Api 'POST' "$backendBaseUrl/api/run/workflow" @{
      workflow_id = $published.workflow.id
      environment_id = $environment.id
      account_ids = @()
    }).data

  Assert-True ($run.success -eq $true) 'Expected published workflow run to succeed'
  Assert-True ($run.has_execution_error -eq $false) 'Expected workflow run without execution errors'

  $historyResponse = Invoke-RestMethod -Uri "$mockBaseUrl/__history" -Method Get -TimeoutSec 3
  $history = @($historyResponse.requests)

  $runtimeList = $history | Where-Object { $_.method -eq 'GET' -and $_.path -eq '/api/orders' } | Select-Object -First 1
  $runtimeSubmit = $history | Where-Object { $_.method -eq 'POST' -and $_.path -eq '/api/orders/ord-live/submit' } | Select-Object -First 1
  $runtimeDisabledDetail = @($history | Where-Object { $_.path -eq '/api/orders/ord-live' })

  Assert-True ($null -ne $runtimeList) 'Expected runtime to call the live orders list endpoint'
  Assert-True ($runtimeList.headers.authorization -eq 'Bearer token-live') 'Expected runtime Authorization header to use extracted live token'
  Assert-True ($null -ne $runtimeSubmit) 'Expected runtime submit call to use the extracted live order id in request.path'
  Assert-True ($runtimeSubmit.headers.authorization -eq 'Bearer token-live') 'Expected runtime submit call to reuse extracted live token'
  Assert-True ($runtimeDisabledDetail.Count -eq 0) 'Disabled detail step should not execute at runtime'

  $checkpoint = 'complete'
  $result = [pscustomobject]@{
    health = $health.status
    workflow_draft_id = $draft.id
    generated_step_count = $draft.steps.Count
    generated_sequences = $stepSequences
    has_header_injection = $tokenInjection.Count -ge 1
    has_path_injection = $pathInjection.Count -ge 1
    published_workflow_id = $published.workflow.id
    published_step_names = @($workflowFull.steps | ForEach-Object { $_.snapshot_template_name })
    workflow_run_success = $run.success
    runtime_paths = @($history | ForEach-Object { $_.path })
    runtime_submit_auth = $runtimeSubmit.headers.authorization
  } | ConvertTo-Json -Depth 20

  Write-Output $result
}
catch {
  $trace = [pscustomobject]@{
    checkpoint = $checkpoint
    error = $_.Exception.Message
    workflow_draft_id = $draft.id
    draft_step_count = $draft.steps.Count
    draft_sequences = @($draft.steps | ForEach-Object { $_.sequence })
    draft_paths = @($draft.steps | ForEach-Object { $_.path })
    published_workflow_id = $published.workflow.id
    workflow_run_success = $run.success
  } | ConvertTo-Json -Depth 20
  Set-Content -Path $traceLog -Value $trace -Encoding UTF8
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
