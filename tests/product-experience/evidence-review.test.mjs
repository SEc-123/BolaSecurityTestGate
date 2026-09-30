import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshot,judge} from './fixtures.mjs';
import {buildProductEvidence} from '../../server/src/services/ai-scan/product-evidence.ts';

test('test evidence cannot select an unrelated task or expose known credentials',()=>{
 const s=snapshot(2);s.tasks[0].status='completed';s.artifacts.push(judge(0,'vulnerable'));
 s.endpoints.push({id:'ep',scan_run_id:s.run.id,method:'GET',path:'/orders',url:'https://example.test/orders?token=SECRET'});
 s.artifacts.push({id:'actual',scan_run_id:s.run.id,task_id:s.tasks[0].id,artifact_type:'generic_mutation_attempt',source_ref:'ep',content_json:{target:'query:id',normal:{status:200,body_preview:'{"password":"SECRET"}'},mutated:{status:200,body_preview:'other account content'},authorization_boundary_verified:true},created_at:new Date().toISOString()});
 s.artifacts.push({...s.artifacts.at(-1),id:'unrelated',task_id:s.tasks[1].id});
 const id='test:'+s.candidates[0].id;
 const value=buildProductEvidence(s,id);assert.ok(value);assert.deepEqual(value.items.map(i=>i.id),['actual']);
 assert.match(value.items[0].proof.join(' '),/不同真实身份/);assert.doesNotMatch(JSON.stringify(value),/SECRET/);assert.doesNotMatch(JSON.stringify(value),/other account content/);
 assert.equal(value.items[0].result.body_present,true);assert.equal(value.items[0].result.body_bytes,'other account content'.length);
 assert.equal(buildProductEvidence(s,'test:another-run'),null);
});
test('accepted upload without execution proof is not described as confirmed impact',()=>{
 const s=snapshot(1);s.artifacts.push({id:'upload',scan_run_id:s.run.id,task_id:s.tasks[0].id,artifact_type:'upload_attempt',content_json:{label:'html_xss',filename:'test.html',status:200,accepted:true,uploaded_bytes_verified:true,impact_verified:false},created_at:new Date().toISOString()});
 const value=buildProductEvidence(s,'test:'+s.candidates[0].id);assert.equal(value.items.length,1);
 assert.deepEqual(value.items[0].proof,['上传文件与回访内容的摘要一致。']);assert.equal(value.items[0].result.status,200);
});
