import test from 'node:test';
import assert from 'node:assert/strict';
import {compactModelEvidence} from '../../server/src/agent/model-evidence-context.ts';
import {sanitizeForAIModel} from '../../server/src/agent/model-context-sanitizer.ts';
import {buildAutonomousAgentContext} from '../../server/src/agent/context-builder.ts';
import {buildModelContextScope,projectContextForModel} from '../../server/src/agent/model-context-profile.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';
import {buildAIScanToolSpecs} from '../../server/src/agent/tools/ai-scan-tools.ts';

test('tool registry persists only the structured browser projection',async()=>{
 const stored=[];const registry=new AgentToolRegistry();
 registry.register({name:'browser.interact',description:'fixture',input_schema:{},handler:async()=>({ok:true,data:{ok:true,current_url:'https://authorized.example.test/orders/tenant-42?nonce=private',
   screenshot_base64:'PRIVATE_SCREENSHOT',observation:{visible_text:'PRIVATE_PAGE_BODY',controls:[{control_ref:'control_00000000-0000-4000-8000-000000000001',tag:'a',label:'Private checkout',text:'Private checkout',href:'/profile/private-member',intent:'navigation',navigation_target:'profile'}]}}})});
 await registry.call('browser.interact',{operation:{action:'click',control_ref:'control_00000000-0000-4000-8000-000000000001',value:'PRIVATE_FORM_VALUE'}},{scanRunId:'scan',repo:{createToolInvocation:async value=>stored.push(value)},db:{}});
 const wire=JSON.stringify(stored[0]);
 for(const privateValue of ['PRIVATE_SCREENSHOT','PRIVATE_PAGE_BODY','Private checkout','PRIVATE_FORM_VALUE','tenant-42','nonce=private','/profile/private-member'])assert.equal(wire.includes(privateValue),false);
 assert.deepEqual(stored[0].input_json,{operation:{action:'click',control_ref:'control_00000000-0000-4000-8000-000000000001',value_provided:true}});
 assert.deepEqual(stored[0].output_json.observation.controls[0],{control_ref:'control_00000000-0000-4000-8000-000000000001',tag:'a',intent:'navigation',navigation_target:'profile'});
});

test('tool registry replaces browser renderer errors before persistence',async()=>{
 const stored=[];const registry=new AgentToolRegistry();
 registry.register({name:'browser.navigate',description:'fixture',input_schema:{},handler:async()=>({ok:false,error:'Renderer exposed PRIVATE_PAGE_BODY at #private-selector',data:{ok:false,error_code:'browser_navigation_failed',current_url:'https://authorized.example.test/private-order'}})});
 await registry.call('browser.navigate',{url:'https://authorized.example.test/private-order'},{scanRunId:'scan',repo:{createToolInvocation:async value=>stored.push(value)},db:{}});
 const wire=JSON.stringify(stored[0]);
 for(const privateValue of ['PRIVATE_PAGE_BODY','#private-selector','private-order'])assert.equal(wire.includes(privateValue),false);
 assert.equal(stored[0].error_message,'browser_error:browser_navigation_failed');
});

test('tool registry rejects model-provided raw selectors before a browser handler runs',async()=>{
 const stored=[];let handlerCalls=0;const registry=new AgentToolRegistry();
 registry.register({name:'browser.interact',description:'fixture',input_schema:{},handler:async()=>{
   handlerCalls+=1;return {ok:true,data:{ok:true}};
 }});
 const result=await registry.call('browser.interact',{operation:{action:'click',selector:'#private-model-selector'}},{scanRunId:'scan',repo:{createToolInvocation:async value=>stored.push(value)},db:{}});
 assert.equal(result.ok,false);assert.equal(handlerCalls,0,'only trusted direct browser-runtime callers may use selectors');
 assert.deepEqual(result.data,{ok:false,error_code:'opaque_reference_required',failure_phase:'pre_action',action_performed:false,retryable:true});
 assert.deepEqual(stored[0].input_json,{operation:{action:'click'}});
 assert.deepEqual(stored[0].output_json,result.data);
 assert.equal(stored[0].error_message,'browser_error:opaque_reference_required');
 assert.equal(JSON.stringify(stored[0]).includes('#private-model-selector'),false);
});

test('browser interaction model schema exposes only opaque references',()=>{
 const interact=buildAIScanToolSpecs().find(tool=>tool.name==='browser.interact');
 const properties=interact.input_schema.properties.operation.properties;
 assert.equal(Object.hasOwn(properties,'selector'),false);
 assert.ok(Object.hasOwn(properties,'control_ref'));
 assert.ok(Object.hasOwn(properties,'assertion_ref'));
});

test('bulky browser results retain only action-state fields without base64 duplication',()=>{
 const original={network_events:Array.from({length:100},(_,i)=>({id:'event-'+i,response_body:'html'.repeat(10000)})),screenshot_base64:'A'.repeat(150000),ok:false,error:'Selector must identify exactly one visible control',error_code:'selector_ambiguous',match_count:2,source_ref:'stored-browser-record'};
 const before=JSON.stringify(original),compact=compactModelEvidence(original,6000);
 assert.ok(JSON.stringify(compact).length<=6000);assert.equal(compact.ok,false);assert.equal(compact.error_code,'selector_ambiguous');assert.equal(compact.match_count,2);assert.equal(Object.hasOwn(compact,'source_ref'),false);
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

test('browser samples retain opaque control references and finite intent without page-derived text',()=>{
 const controls=Array.from({length:100},(_,i)=>({control_ref:`control_00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,tag:'button',id:`button-${i}`,name:`action-${i}`,role:'button',label:`Action ${i}`,text:`Action ${i}`,intent:'submit',type:'button'}));
 const value={ok:true,context_key:'identity:tester',identity_key:'tester',current_url:'https://authorized.example.test/orders',
  screenshot_base64:'A'.repeat(200000),network_events:Array(300).fill({method:'GET',url:'https://authorized.example.test/orders',body:'H'.repeat(10000)}),
  observation:{title:'Orders',url:'https://authorized.example.test/orders',visible_text:'page'.repeat(3000),controls},
  dom_summary:{forms:[{method:'post',action:'/orders',inputs:[{name:'quantity',type:'number'}]}]}};
 const result=compactModelEvidence(value,6000);
 const wire=JSON.stringify(result);assert.ok(wire.length<=6000);assert.equal(Object.hasOwn(result,'identity_key'),false);
 assert.ok(result.observation.controls.some(c=>c.control_ref==='control_00000000-0000-4000-8000-000000000000'&&c.intent==='submit'));
 for(const forbidden of ['button-0','action-0','Action 0','pagepage','quantity','Orders'])assert.equal(wire.includes(forbidden),false);
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
 assert.equal(context.task_tool_invocations[0].output_json.ok,true);assert.equal(Object.hasOwn(context.task_tool_invocations[0].output_json,'identity_key'),false);assert.equal(JSON.stringify(snapshot),before);
 const small={ok:false,error_code:'selector_ambiguous',match_count:2,context_key:'identity:tester'};
 assert.deepEqual(compactModelEvidence(small),small);
});

test('capture recording handles remain callable after private evidence redaction',async()=>{
 const recordingId='owned-recording-reference';
 const privateCookie='private-auth-cookie-material';
 const task={id:'task',scan_run_id:'scan',title:'Record normal flow',task_type:'learn_business_flow',endpoint_ids:[],execution_plan:{intent:'learn_business_flow'}};
 const snapshot={run:{id:'scan',user_prompt:'Capture a normal flow',base_url:'https://authorized.example.test',scan_config:{},selected_vuln_types:[]},tasks:[task],
  endpoints:[],features:[],candidates:[],shared_resources:[],agent_memories:[],browser_contexts:[],planner_decisions:[],
  artifacts:[{id:'event',task_id:'task',artifact_type:'business_capture_event',content_json:{private:true,recording_session_id:recordingId,
    request_headers:{cookie:`sid=${privateCookie}`},response_body_text:'{"session_id":"private-response-session"}'}}],
  tool_invocations:[{id:'start',task_id:'task',tool_name:'bstg.business.capture.start',input_json:{flow_id:'flow'},output_json:{
    recording_session_id:recordingId,flow_id:'flow',capture_status:'recording',summary:`Unexpected echo ${privateCookie}`}}]};
 const repo={getSnapshot:async()=>snapshot,listAgentMemories:async()=>[],touchAgentMemories:async()=>{}};
 const context=await buildAutonomousAgentContext({repo,scanRunId:'scan',task,tools:[]});
 const capture=context.task_tool_invocations[0].output_json;
 assert.equal(capture.recording_session_id,recordingId,'the next model turn must be able to call capture.stop/inspect/prepare');
 const wire=JSON.stringify(context);
 assert.ok(wire.includes(recordingId));
 assert.ok(!wire.includes(privateCookie),'private cookie material remains globally redacted');
 assert.ok(!wire.includes('private-response-session'));
});

test('workflow inspection retains retry assertion requirements while excluding captured values from the provider envelope',async()=>{
 const privateValue='PRIVATE_RETRY_CAPTURE_VALUE';
 const task={id:'retry-task',scan_run_id:'retry-scan',title:'Prove retry targets',task_type:'learn_business_flow',endpoint_ids:[],execution_plan:{intent:'learn_business_flow',flow_id:'retry-flow',coverage_retry:{
   targets:[{key:'operation:target-a',target_type:'operation',target_id:'target-a'},{key:'feature:target-b',target_type:'feature',target_id:'target-b'}],
 }}};
 const snapshot={run:{id:'retry-scan',user_prompt:'Prove scheduled retry targets',base_url:'https://authorized.example.test',scan_config:{authorization_acknowledged:true},selected_vuln_types:[]},tasks:[task],
  endpoints:[],features:[],candidates:[],shared_resources:[],agent_memories:[],browser_contexts:[],planner_decisions:[],artifacts:[],
  tool_invocations:[
   {id:'capture-inspect',task_id:'retry-task',tool_name:'bstg.business.capture.inspect',status:'completed',input_json:{recording_session_id:'retry-recording'},output_json:{
    recording_session_id:'retry-recording',status:'recording',retry_target_event_candidates:[
      {target_type:'operation',target_id:'target-a',event_ids:['event-a']},
      {target_type:'feature',target_id:'target-b',event_ids:['event-b']},
    ],response_body:privateValue,
   }},
   {id:'workflow-inspect',task_id:'retry-task',tool_name:'bstg.business.workflow.inspect',status:'completed',input_json:{workflow_id:'retry-workflow'},output_json:{
    flow_id:'retry-flow',workflow_id:'retry-workflow',recording_session_id:'retry-recording',steps:[{step_id:'step-a',step_order:3,assertion_paths:[{path:'body.state',semantic:true}]}],
    retry_target_assertion_requirements:[
      {target_type:'operation',target_id:'target-a',source_step_orders:[3],semantic_body_assertion_required:true,response_body:privateValue},
      {target_type:'feature',target_id:'target-b',source_step_orders:[5,7],semantic_body_assertion_required:true,response_body:privateValue},
    ],response_body:privateValue,
   }},
  ]};
 const repo={getSnapshot:async()=>snapshot,listAgentMemories:async()=>[],touchAgentMemories:async()=>{}};
 const canonical=await buildAutonomousAgentContext({repo,scanRunId:'retry-scan',task,tools:[]});
 const scope=buildModelContextScope({task,scanConfig:snapshot.run.scan_config,tools:[]});
 const projected=sanitizeForAIModel(projectContextForModel(canonical,scope));
 const capture=projected.task_tool_invocations.find(item=>item.tool_name==='bstg.business.capture.inspect');
 const workflow=projected.task_tool_invocations.find(item=>item.tool_name==='bstg.business.workflow.inspect');
 assert.deepEqual(capture?.output_json.retry_target_event_candidates,[
  {target_type:'operation',target_id:'target-a',event_ids:['event-a']},
  {target_type:'feature',target_id:'target-b',event_ids:['event-b']},
 ]);
 assert.deepEqual(workflow?.output_json.retry_target_assertion_requirements,[
  {target_type:'operation',target_id:'target-a',source_step_orders:[3],semantic_body_assertion_required:true},
  {target_type:'feature',target_id:'target-b',source_step_orders:[5,7],semantic_body_assertion_required:true},
 ]);
 assert.equal(JSON.stringify(projected).includes(privateValue),false,'the actual builder-to-provider path carries no captured response values');
});

test('final private-value redaction never mutates executor protocol identifiers',async()=>{
 const collidingPrivateValue='browser.navigate';
 const task={id:'task',scan_run_id:'scan',title:'Record a protected normal flow',task_type:'learn_business_flow',endpoint_ids:[],execution_plan:{intent:'learn_business_flow'}};
 const snapshot={run:{id:'scan',user_prompt:'Record a normal flow',base_url:'https://authorized.example.test',scan_config:{},selected_vuln_types:[]},tasks:[task],
  endpoints:[],features:[],candidates:[],shared_resources:[],agent_memories:[],browser_contexts:[],planner_decisions:[],
  artifacts:[{id:'private-event',task_id:'task',artifact_type:'business_capture_event',content_json:{private:true,
    response_body_text:JSON.stringify({session_id:collidingPrivateValue,token:'private-cookie-material'})}}],
  tool_invocations:[{id:'navigate',task_id:'task',tool_name:'browser.navigate',status:'completed',input_json:{url:'https://authorized.example.test'},
    output_json:{action:'navigate',status:'completed',summary:'Private transport retained separately'}}]};
 const repo={getSnapshot:async()=>snapshot,listAgentMemories:async()=>[],touchAgentMemories:async()=>{}};
 const context=await buildAutonomousAgentContext({repo,scanRunId:'scan',task,tools:[{name:'browser.navigate',description:'Navigate the authorized target.',input_schema:{type:'object'}}]});
 assert.equal(context.available_tools[0].name,'browser.navigate','the model must receive a callable registered tool name');
 assert.equal(context.task_tool_invocations[0].tool_name,'browser.navigate','local lifecycle guards must recognize persisted navigation');
 assert.equal(context.task_tool_invocations[0].status,'completed');
 assert.equal(Object.hasOwn(context.task_tool_invocations[0].output_json,'action'),false);
 assert.equal(context.task.execution_plan.intent,'learn_business_flow');
 assert.equal(JSON.stringify(context).includes('private-cookie-material'),false);
});

test('final model transport keeps only route shape/query names and removes custom private capture scalars',async()=>{
 const nonce='nonce_custom_9f4a11c2';
 const state='state_custom_7ab3d810';
 const objectRef='tenant_object_3ec77914';
 const rawUrl=`https://authorized.example.test/api/orders/${objectRef}?nonce_custom=${nonce}&state_custom=${state}#private-fragment`;
 const task={id:'task',scan_run_id:'scan',title:'Inspect an observed order route',task_type:'autonomous_agent_task',endpoint_ids:['endpoint'],execution_plan:{intent:'ordinary_task',
  workflow_execution_plan:{nodes:[{endpoint_id:'endpoint',path:`/api/orders/${objectRef}?nonce_custom=${nonce}&state_custom=${state}`}]}}};
 const snapshot={run:{id:'scan',user_prompt:'Inspect current route',base_url:'https://authorized.example.test',scan_config:{},selected_vuln_types:[]},tasks:[task],
  endpoints:[{id:'endpoint',method:'GET',path:`/api/orders/${objectRef}?nonce_custom=${nonce}&state_custom=${state}`,url:rawUrl,request_summary:'Observed request'}],
  features:[],candidates:[],shared_resources:[],agent_memories:[],planner_decisions:[],
  browser_contexts:[{id:'context',context_key:'task:fixture',scope_type:'task',identity_key:'anonymous',status:'active',current_url:rawUrl,last_used_at:'2026-01-01T00:00:00.000Z'}],
  artifacts:[{id:'capture',task_id:'task',artifact_type:'business_capture_event',content_json:{private:true,
    url:rawUrl,response_body_text:JSON.stringify({nonce_custom:nonce,state_custom:state,object_ref:objectRef})}}],
  tool_invocations:[{id:'browser-result',task_id:'task',tool_name:'browser.navigate',input_json:{url:rawUrl},
    output_json:{current_url:rawUrl,summary:`Captured ${nonce}, ${state}, and ${objectRef}`}}]};
 const repo={getSnapshot:async()=>snapshot,listAgentMemories:async()=>[],touchAgentMemories:async()=>{}};
 const context=await buildAutonomousAgentContext({repo,scanRunId:'scan',task,tools:[]});
 const providerPayload=sanitizeForAIModel({context,deterministic_next_step:{action:'tool_call',tool_name:'browser.navigate',arguments:{url:rawUrl}}});
 const wire=JSON.stringify(providerPayload);
 for(const privateValue of [nonce,state,objectRef,'private-fragment']) assert.equal(wire.includes(privateValue),false,`provider payload leaked ${privateValue}`);
 assert.equal(context.relevant_endpoints[0].path,'/api/orders/:value?nonce_custom&state_custom');
 assert.equal(context.relevant_endpoints[0].url,'https://authorized.example.test/api/orders/:value?nonce_custom&state_custom');
 assert.equal(context.browser_context_summary.contexts[0].current_url,'https://authorized.example.test/api/orders/:value?nonce_custom&state_custom');
 assert.equal(providerPayload.context.task_tool_invocations[0].output_json.current_url,'https://authorized.example.test/api/orders/:value?nonce_custom&state_custom');
 assert.equal(providerPayload.context.task.execution_plan.workflow_execution_plan.nodes[0].path,'/api/orders/:value?nonce_custom&state_custom');
 assert.ok(wire.includes('nonce_custom')&&wire.includes('state_custom'),'field names remain available for model reasoning');
});

test('a private initial navigation never redacts the server-only base URL used by native lifecycle policy',async()=>{
 const baseUrl='https://authorized.example.test/';
 const task={id:'task',scan_run_id:'scan',title:'Fresh captured sign-in',task_type:'learn_business_flow',endpoint_ids:[],execution_plan:{intent:'learn_business_flow'}};
 const snapshot={run:{id:'scan',user_prompt:'Verify normal sign-in',base_url:baseUrl,scan_config:{},selected_vuln_types:[]},tasks:[task],
  endpoints:[],features:[],candidates:[],shared_resources:[],agent_memories:[],browser_contexts:[],planner_decisions:[],tool_invocations:[],
  artifacts:[{id:'initial-navigation',task_id:'task',artifact_type:'business_capture_event',content_json:{private:true,url:baseUrl,
    request_headers:{cookie:'sid=private-cookie-material'},response_body_text:'{"nonce":"private-login-nonce"}'}}]};
 const repo={getSnapshot:async()=>snapshot,listAgentMemories:async()=>[],touchAgentMemories:async()=>{}};
 const context=await buildAutonomousAgentContext({repo,scanRunId:'scan',task,tools:[]});
 assert.equal(context.scan.base_url,baseUrl,'model-facing target data is projected later, not redacted before local policy runs');
 assert.equal(context.execution_base_url,baseUrl,'native prerequisite navigation retains the authoritative server target');
 const {execution_base_url,...modelContext}=context;
 const payload=sanitizeForAIModel({context:modelContext});const wire=JSON.stringify(payload);
 assert.equal(Object.hasOwn(payload.context,'execution_base_url'),false);
 assert.equal(payload.context.scan.base_url,baseUrl,'root target is a safe route projection');
 for(const privateValue of ['private-cookie-material','private-login-nonce'])assert.equal(wire.includes(privateValue),false);
});

test('selector correction phase, readiness feedback and dialog controls survive bulky model projection',()=>{
 const evidence={ok:false,error_code:'selector_actionability_timeout',match_count:1,failure_phase:'pre_action',action_performed:false,
  retryable:true,recovery_hint:'No click was dispatched. Inspect dialog controls; do not force clicks.',
  context_key:'task:fixture',observation:{controls:[{control_ref:'control_00000000-0000-4000-8000-000000000001',tag:'button',id:'dismiss',text:'Close dialog',intent:'cancel',in_dialog:true,receives_pointer:true,disabled:false}]},
  network_events:Array(100).fill({response_body:'large'.repeat(1000)}),screenshot_base64:'A'.repeat(150000)};
 const result=compactModelEvidence(sanitizeForAIModel(evidence),12000);
 assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);
 assert.equal(result.error_code,'selector_actionability_timeout');assert.equal(result.match_count,1);
 assert.equal(result.retryable,true);assert.equal(Object.hasOwn(result,'recovery_hint'),false);
 assert.equal(Object.hasOwn(result,'context_key'),false);assert.deepEqual(result.observation.controls,[{control_ref:'control_00000000-0000-4000-8000-000000000001',tag:'button',intent:'cancel',in_dialog:true,receives_pointer:true,disabled:false}]);
 assert.ok(JSON.stringify(result).length<=12000);
});
