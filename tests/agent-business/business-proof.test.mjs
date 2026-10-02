import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBusinessProof } from '../../server/src/services/ai-scan/business-proof.ts';

const identities={
  victim:{account_id:'account-victim',auth_context_generation:'victim-generation',auth_context_fingerprint:'victim-fingerprint',expected_subject_sha256:'victim-subject'},
  normal:{account_id:'account-normal',auth_context_generation:'normal-generation',auth_context_fingerprint:'normal-fingerprint',expected_subject_sha256:'normal-subject'},
};

function evidence(role,execution_kind,phase){
  return {role,execution_kind,phase,verified:true,...identities[role]};
}

function trace(role){
  const identity=identities[role];
  return {records:[{meta:{step_order:1,account_id:identity.account_id,auth_context_generation:identity.auth_context_generation},response:{status:200,headers:{},body:'{"ok":true}'}}]};
}

function input(identity_evidence){
  return {
    plan:{control_role:'victim',steps:[{id:'identity',source_step_order:1,role:'normal'}],assertions:[],control_assertions:[]},
    compilation:{control_role:'victim',role_account_ids:{victim:identities.victim.account_id,normal:identities.normal.account_id},
      identity_requirements:Object.entries(identities).map(([role,identity])=>({role,...identity})),object_handles:[]},
    sourceSteps:[{id:'identity',step_order:1,request_snapshot_raw:'GET /identity HTTP/1.1\r\n\r\n'}],
    controlAssertions:[{id:'control',step_order:1,purpose:'control',passed:true,left:{type:'response',path:'body.ok'}}],
    experimentAssertions:[{id:'impact',step_order:1,purpose:'impact',passed:true,left:{type:'response',path:'body.ok'}}],
    controlVerified:true,executionVerified:true,identity_evidence,control_trace:trace('victim'),experiment_trace:trace('normal'),
  };
}

test('a non-normal control identity cannot bypass trusted proof when selected steps are normal',()=>{
  const proof=evaluateBusinessProof(input([
    evidence('victim','control','pre'),evidence('victim','control','post'),
  ]));
  assert.equal(proof.authentication.required,true);
  assert.equal(proof.authentication.verified,false);
  assert.equal(proof.verified,false);
});

test('a non-normal control identity verifies only after both control and experiment bindings are proved',()=>{
  const proof=evaluateBusinessProof(input([
    evidence('victim','control','pre'),evidence('victim','control','post'),
    evidence('normal','experiment','pre'),evidence('normal','experiment','post'),
  ]));
  assert.equal(proof.authentication.required,true);
  assert.equal(proof.authentication.verified,true);
  assert.equal(proof.verified,true);
});
