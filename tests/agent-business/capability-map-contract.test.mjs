/** The published capability inventory is part of the Agent contract.  A name
 * here that is not actually registered makes the model plan against a tool it
 * can never call, so keep this check independent of individual tool tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {BSTG_CAPABILITIES} from '../../server/src/services/ai-scan/bstg-capability-map.ts';
import {createAgentToolRegistry} from '../../server/src/agent/index.ts';

test('every tool advertised by the BSTG capability map is registered',()=>{
  const registered=new Set(createAgentToolRegistry().list().map(tool=>tool.name));
  assert.ok(BSTG_CAPABILITIES.length>0,'the capability inventory must not be empty');
  for(const capability of BSTG_CAPABILITIES){
    assert.equal(new Set(capability.ai_tool_names).size,capability.ai_tool_names.length,
      `${capability.id} must not advertise a tool twice`);
    for(const toolName of capability.ai_tool_names){
      assert.ok(registered.has(toolName),`${capability.id} advertises unregistered tool ${toolName}`);
    }
  }
});
