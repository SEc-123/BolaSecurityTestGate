import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateStepAssertions} from '../../server/src/services/workflow-runner.ts';
import {rejectCapturedBaselineAssertions} from '../../server/src/routes/api.ts';

const response={status:200,headers:{},body:{state:'completed'}};

test('generic workflow evaluation fails closed for a persisted captured-baseline marker',()=>{
  const evaluated=evaluateStepAssertions([{
    op:'not_equals',left:{type:'response',path:'body.state'},
    right:{type:'captured_baseline'},missing_behavior:'fail',
  }],'all',response,{}, {extractedValues:{},cookies:{},sessionFields:{}});
  assert.equal(evaluated.passed,false);
  assert.equal(evaluated.results[0].passed,false);
  assert.equal(evaluated.results[0].right_value,'[private captured baseline unavailable]');
  assert.equal(evaluated.results[0].assertion.right.type,'captured_baseline');
});

test('generic workflow writes reject captured-baseline markers and transient tagged literals',()=>{
  for(const right of [
    {type:'captured_baseline'},
    {type:'literal',value:'private-value',captured_baseline:true},
  ]){
    assert.throws(
      ()=>rejectCapturedBaselineAssertions([{left:{type:'response',path:'body.state'},right}]),
      /only through scoped normal-business validation/,
    );
  }
  assert.doesNotThrow(()=>rejectCapturedBaselineAssertions([
    {left:{type:'response',path:'body.state'},right:{type:'literal',value:'completed'}},
  ]));
});
