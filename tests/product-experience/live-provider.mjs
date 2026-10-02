import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

export function providerReference(providerId){
 return typeof providerId==='string'&&providerId
  ? 'provider:'+createHash('sha256').update(providerId).digest('hex').slice(0,20)
  : undefined;
}

/** A real operator-selected provider is required. This helper never fabricates completions. */
export async function loadAcceptanceProvider(){
 const file=process.env.BSTG_ACCEPTANCE_AI_PROVIDER_FILE;
 if(!file)throw Error('Set BSTG_ACCEPTANCE_AI_PROVIDER_FILE to a private provider JSON file for real-model acceptance. Native-only results are not AI acceptance.');
 const input=JSON.parse(await readFile(file,'utf8'));
 for(const key of ['base_url','api_key','model'])if(typeof input[key]!=='string'||!input[key])throw Error('Acceptance provider configuration is incomplete: '+key);
 return {name:'Actual model acceptance provider',provider_type:'openai_compat',...input,is_enabled:true,is_default:true};
}
export async function configureAcceptanceProvider(api,provider){
 const response=await fetch(api+'/api/ai/providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(provider)});
 assert.equal(response.status,201,'Actual model provider must be configured before creating a scan');
 return (await response.json()).id;
}
export function verifyModelDecisions(technical,provider){
 const decisions=technical.artifacts.filter(a=>a.artifact_type==='agent_decision').map(a=>a.content_json);
 assert.ok(!decisions.some(d=>d.source==='fallback'),'Fallback decisions cannot count as real-model acceptance');
 const actual=decisions.filter(d=>d.source==='ai_provider');
 assert.ok(actual.length>0,'At least one actual upstream model decision is required');
 assert.ok(actual.every(d=>d.model===provider.model&&d.provider_response_id),'Every model decision must retain its exact upstream model and receipt ID');
 const expectedProvider=providerReference(provider.id);
 if(expectedProvider)assert.ok(actual.every(d=>d.provider_reference===expectedProvider),
  'Every model decision must belong to the configured provider reference.');
 return {model:provider.model,decisions:actual.length,response_ids:actual.map(d=>d.provider_response_id),
  ...(expectedProvider?{provider_reference:expectedProvider}:{})};
}
