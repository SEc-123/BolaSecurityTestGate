import test from 'node:test';
import assert from 'node:assert/strict';
import {compactModelEvidence} from '../../server/src/agent/model-evidence-context.ts';
import {sanitizeForAIModel} from '../../server/src/agent/model-context-sanitizer.ts';
import {buildAutonomousAgentContext} from '../../server/src/agent/context-builder.ts';

test('bulky browser results retain status, failures and evidence references without base64 duplication',()=>{
 const original={network_events:Array.from({length:100},(_,i)=>({id:'event-'+i,response_body:'html'.repeat(10000)})),screenshot_base64:'A'.repeat(150000),ok:false,error:'Selector must identify exactly one visible control',error_code:'selector_ambiguous',match_count:2,source_ref:'stored-browser-record'};
 const before=JSON.stringify(original),compact=compactModelEvidence(original,6000);
 assert.ok(JSON.stringify(compact).length<=6000);assert.equal(compact.ok,false);assert.equal(compact.error_code,'selector_ambiguous');assert.equal(compact.match_count,2);assert.equal(compact.source_ref,'stored-browser-record');assert.equal(compact._model_context.truncated,true);
 assert.ok(!JSON.stringify(compact).includes('A'.repeat(1000)));assert.equal(JSON.stringify(original),before);
});
test('large learning results retain useful outcome while full workflow bytes remain in canonical evidence',()=>{
 const original={applied:{workflow:{steps:Array.from({length:30},()=>({response_body:'body'.repeat(6000)}))}},summary:'Repair produced a workflow; execution has not passed.',ok:true,suggestion_id:'original-suggestion'};
 const result=compactModelEvidence(original,4000);assert.ok(JSON.stringify(result).length<=4000);assert.equal(result.summary,original.summary);assert.equal(result.ok,true);assert.equal(result.suggestion_id,original.suggestion_id);assert.ok(result._model_context.original_characters>600000);
});
test('a long repeated browser history fits the text transport without changing prompt instructions',()=>{
 const evidence={ok:true,screenshot_base64:'A'.repeat(150000),network_events:Array.from({length:100},()=>({response_body:'HTML'.repeat(150)}))};
 const prompt='Unchanged operator test prompt';
 const context={user_prompt:prompt,task_artifacts:Array.from({length:30},(_,i)=>({id:`artifact-${i}`,content_json:compactModelEvidence(evidence,4000)})),task_tool_invocations:Array.from({length:30},(_,i)=>({id:`invocation-${i}`,output_json:compactModelEvidence(evidence,6000)}))};
 const envelope=JSON.stringify({conversation:[{role:'user',content:JSON.stringify(context)}]});
 assert.ok(envelope.length<500000);assert.equal(context.user_prompt,prompt);
});
test('secret sanitization precedes evidence projection and compaction remains bounded for escaped strings',()=>{
 const source={ok:false,error:'retained failure',password:'PRIVATE_VALUE',body:'"\\\n'.repeat(10000)};
 const projected=compactModelEvidence(sanitizeForAIModel(source),1000);
 assert.ok(JSON.stringify(projected).length<=1000);assert.equal(projected.error,source.error);assert.ok(!JSON.stringify(projected).includes('PRIVATE_VALUE'));
});

test('generic runner result preserves nested judgement and native prerequisites after bulky assets',()=>{
 const value={endpoint:{id:'endpoint-1',method:'POST',path:'/orders',response_body:'HTML'.repeat(10000)},vuln_type:'business_logic',
  targets:Array(40).fill({name:'quantity',payload:'x'.repeat(1000)}),assets:{workflow_mapping_ids:Array.from({length:700},(_,i)=>`mapping-${i}`)},
  native_bstg:{assets:{template_ids:Array.from({length:700},(_,i)=>`template-${i}`)},
   template_run:{success:false,test_run_id:'native-run',has_execution_error:true,missing_preconditions:['authenticated_identity']},
   advanced_mutation:{plan:{workflow_dependency_plan:{access_phase:'authenticated',missing_preconditions:['object_ownership']}},profile:{workflow_dependency_plan:{missing_preconditions:['login_session']}}},
   missing_preconditions:['object_ownership'],native_counts:{templates:1}},baseline:{body:'B'.repeat(100000),status:403},
  attempts:Array(4).fill({mutated:{body:'M'.repeat(10000),status:403}}),
  judge:{verdict:'inconclusive',confidence:0.2,reason:'Ownership and authentication evidence are missing.',source:'ai_provider',provider_id:'provider',model:'contract-model'},
  native_evidence_gate:{verdict:'insufficient_native_evidence',missing_evidence:['baseline_workflow_not_verified']},finding_id:null};
 const projected=compactModelEvidence(value,6000);
 assert.ok(JSON.stringify(projected).length<=6000);
 assert.equal(projected.judge.verdict,'inconclusive');assert.equal(projected.judge.reason,value.judge.reason);
 assert.equal(projected.native_evidence_gate.verdict,'insufficient_native_evidence');
 assert.deepEqual(projected.native_bstg.missing_preconditions,['object_ownership']);
 assert.equal(projected.native_bstg.template_run.success,false);
 assert.deepEqual(projected.native_bstg.template_run.missing_preconditions,['authenticated_identity']);
 assert.deepEqual(projected.native_bstg.advanced_mutation.plan.workflow_dependency_plan.missing_preconditions,['object_ownership']);
 assert.deepEqual(projected.native_bstg.advanced_mutation.profile.workflow_dependency_plan.missing_preconditions,['login_session']);
 assert.equal(projected.attempts[0].mutated.status,403);
});

test('large upload history keeps false verification and impact proof distinct from acceptance or missing fields',()=>{
 const value={field_name:'file',endpoint:{id:'upload',method:'POST',path:'/upload'},
  attempts:[{label:'normal_control',accepted:true,status:200,response_body_preview:'large'.repeat(10000),request_artifact_id:'req',
   uploaded_bytes_verified:false,impact_verified:false,impact_proof:{kind:'unique_marker',artifact_id:'proof'}},
   {label:'mutation',accepted:true,status:200}],
  judge:{verdict:'inconclusive',source:'ai_provider',reason:'Readback is unverified'},
  upload_evidence_gate:{verdict:'inconclusive',baseline_verified:false,mutation_executed:true,missing_evidence:['readback']}};
 const projected=compactModelEvidence(value,12000);
 assert.equal(projected.attempts[0].uploaded_bytes_verified,false);assert.equal(projected.attempts[0].impact_verified,false);
 assert.deepEqual(projected.attempts[0].impact_proof,value.attempts[0].impact_proof);
 assert.equal(Object.hasOwn(projected.attempts[1],'impact_verified'),false);
 assert.deepEqual(projected.upload_evidence_gate,value.upload_evidence_gate);
});

test('required evidence that cannot fit fails explicitly instead of dropping a middle failure or proof',()=>{
 const value={judge:{verdict:'inconclusive'},attempts:Array.from({length:60},(_,i)=>({label:`attempt-${i}`,status:i===30?500:200,
  error:i===30?'Failed request':undefined,comparison:{changed:false,reasons:['reason'.repeat(100)]},body_preview:'X'.repeat(3000)}))};
 assert.throws(()=>compactModelEvidence(value,12000),/Required runner evidence exceeds/);
 assert.equal(value.attempts[30].status,500);
});

test('browser samples retain identity, form input names and usable control labels instead of only hashes',()=>{
 const controls=Array.from({length:100},(_,i)=>({tag:'button',id:`button-${i}`,name:`action-${i}`,role:'button',label:`Action ${i}`,text:`Action ${i}`,placeholder:null,type:'button'}));
 const value={ok:true,context_key:'identity:tester',identity_key:'tester',current_url:'https://authorized.example.test/orders',
  screenshot_base64:'A'.repeat(200000),network_events:Array(300).fill({method:'GET',url:'https://authorized.example.test/orders',body:'H'.repeat(10000)}),
  observation:{title:'Orders',url:'https://authorized.example.test/orders',visible_text:'page'.repeat(3000),controls},
  dom_summary:{forms:[{method:'post',action:'/orders',inputs:[{name:'quantity',type:'number'}]}]}};
 const result=compactModelEvidence(value,6000);
 assert.ok(JSON.stringify(result).length<=6000);assert.equal(result.identity_key,'tester');
 assert.ok(result.observation.controls.some(c=>c.id==='button-0'&&c.label==='Action 0'));
 assert.equal(result.dom_summary.forms[0].inputs[0].name,'quantity');
});

test('context builder bounds a persisted long history, leaves small evidence and current task parameters intact',async()=>{
 const prompt='Keep the saved prompt unchanged';
 const task={id:'task',scan_run_id:'scan',title:'File upload',task_type:'test_file_upload',endpoint_ids:['ep'],execution_plan:{target_endpoint_id:'ep',precondition_policy:'require_verified'},created_assets_json:{account_ids:['tester']}};
 const body={ok:true,context_key:'identity:tester',identity_key:'tester',screenshot_base64:'A'.repeat(180000),network_events:Array.from({length:100},()=>({method:'POST',url:'https://authorized.example.test/upload',body:'HTML'.repeat(2000)}))};
 const snapshot={run:{id:'scan',user_prompt:prompt,base_url:'https://authorized.example.test',scan_config:{},selected_vuln_types:['file_upload']},tasks:[task],
  endpoints:[],features:[],candidates:[],shared_resources:[],agent_memories:[],browser_contexts:[],planner_decisions:[],
  artifacts:Array.from({length:30},(_,i)=>({id:`evidence-${i}`,task_id:'task',artifact_type:'browser_state',content_json:body})),
  tool_invocations:Array.from({length:30},(_,i)=>({id:`call-${i}`,task_id:'task',tool_name:'browser.navigate',input_json:{url:'https://authorized.example.test/upload'},output_json:body}))};
 const before=JSON.stringify(snapshot),repo={getSnapshot:async()=>snapshot,listAgentMemories:async()=>[],touchAgentMemories:async()=>{}};
 const context=await buildAutonomousAgentContext({repo,scanRunId:'scan',task,tools:[]});
 const wire=JSON.stringify({conversation:[{role:'user',content:JSON.stringify({context})}]});
 assert.ok(before.length>1048576);assert.ok(wire.length<500000);
 assert.equal(context.scan.user_prompt,prompt);assert.deepEqual(context.task.execution_plan,task.execution_plan);
 assert.equal(context.task_tool_invocations[0].id,'call-0');assert.equal(context.task_tool_invocations.at(-1).id,'call-29');
 assert.equal(context.task_tool_invocations[0].output_json.identity_key,'tester');assert.equal(JSON.stringify(snapshot),before);
 const small={ok:false,error_code:'selector_ambiguous',match_count:2,context_key:'identity:tester'};
 assert.deepEqual(compactModelEvidence(small),small);
});
