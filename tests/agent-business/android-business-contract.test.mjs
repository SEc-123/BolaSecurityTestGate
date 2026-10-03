import test from 'node:test';
import assert from 'node:assert/strict';
import { androidBusinessAllowedTools, assertAndroidBusinessExperimentExecutorReady, assertAndroidBusinessToolBoundary, verifiedAndroidBusinessAssets, ANDROID_BUSINESS_EXPERIMENT_INTENT, ANDROID_BUSINESS_LEARNING_INTENT } from '../../server/src/services/ai-scan/android-business-contract.ts';
import { buildAndroidBusinessToolSpecs } from '../../server/src/agent/tools/android-business-tools.ts';

const run={scan_config:{surface:'android'}};
const session={capture_status:'imported',recording_session_id:'recording-1',health_json:{capture_import:{result:{evidence_level:'session_bound_device_capture',verified_target_flows:2,explicitly_decrypted_https_flows:2,target_contract:{require_explicit_tls_evidence:true}}}}};
const workflow={id:'workflow-1',source_recording_session_id:'recording-1',baseline_config:{capture_replay_only:true}};
const testRun={id:'run-1',workflow_id:'workflow-1',source_recording_session_id:'recording-1',status:'completed',has_execution_error:false};

test('Android business contract accepts only imported Appium/decrypted HTTPS evidence and native assets',()=>{
  assert.deepEqual(verifiedAndroidBusinessAssets(run,{session,workflows:[workflow],testRuns:[testRun]}),{recording_session_id:'recording-1',workflow_ids:['workflow-1'],completed_test_run_ids:['run-1'],explicitly_decrypted_https_flows:2});
});

test('Android business contract fails closed for fixture/plain/import-only evidence and cannot fall back to a Web capture',()=>{
  for(const change of [
    {capture_status:'recording'},
    {health_json:{capture_import:{result:{...session.health_json.capture_import.result,evidence_level:'simulated'}}}},
    {health_json:{capture_import:{result:{...session.health_json.capture_import.result,explicitly_decrypted_https_flows:0}}}},
  ]) assert.throws(()=>verifiedAndroidBusinessAssets(run,{session:{...session,...change},workflows:[workflow],testRuns:[testRun]}),/Android business learning requires/);
  assert.throws(()=>assertAndroidBusinessToolBoundary('normal_replay','browser.navigate'),/never use Web browser capture/);
  assert.throws(()=>assertAndroidBusinessToolBoundary('normal_replay','bstg.business.capture.start'),/never use Web browser capture/);
  assert.deepEqual(androidBusinessAllowedTools('normal_replay'),['android.business.assets.inspect','android.business.normal.replay']);
});

test('registered Android business tools expose no browser capture capability',()=>{
  const names=buildAndroidBusinessToolSpecs().map(tool=>tool.name);
  assert.deepEqual(names,['android.business.assets.inspect','android.business.normal.replay','android.business.experiment.ready']);
  assert.ok(!names.some(name=>name.startsWith('browser.')||name.startsWith('bstg.business.capture.')));
  assert.equal(ANDROID_BUSINESS_LEARNING_INTENT,'learn_android_business_flow');
});

test('Android generic execution is blocked until this experiment task has its readiness receipt',()=>{
  const task={id:'android-experiment-task',task_type:'model_android_business_experiment',execution_plan:{intent:ANDROID_BUSINESS_EXPERIMENT_INTENT}};
  assert.throws(()=>assertAndroidBusinessExperimentExecutorReady(task,[]),/readiness receipt first/);
  assert.throws(()=>assertAndroidBusinessExperimentExecutorReady(task,[{
    task_id:'other-task',artifact_type:'android_business_experiment_ready',
    content_json:{recording_session_id:'recording-1',workflow_ids:['workflow-1'],completed_test_run_ids:['run-1']},
  }]),/readiness receipt first/,'a readiness receipt cannot be borrowed from another task');
  assert.doesNotThrow(()=>assertAndroidBusinessExperimentExecutorReady(task,[{
    task_id:task.id,artifact_type:'android_business_experiment_ready',
    content_json:{recording_session_id:'recording-1',workflow_ids:['workflow-1'],completed_test_run_ids:['run-1']},
  }]));
});
