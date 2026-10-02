import test from 'node:test';
import assert from 'node:assert/strict';
import {browserContextKey} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';
import {
  activeBusinessCaptureBrowserBinding,
  bindActiveBusinessCaptureBrowserInput,
} from '../../server/src/agent/tools/ai-scan-tools.ts';

test('canonical browser context keys retain their scope and identity across Agent task boundaries',()=>{
  const identity=browserContextKey({
    context_key:'identity:victim',
    default_scope:'task',
    task_id:'planning-task',
  });
  assert.deepEqual(identity,{key:'identity:victim',scope:'identity',identity:'victim'});

  const task=browserContextKey({
    context_key:'task:planning-task',
    default_scope:'scan',
    task_id:'planning-task',
    identity_key:'victim',
  });
  assert.deepEqual(task,{key:'task:planning-task',scope:'task',identity:'victim'});

  const encoded=browserContextKey({scope_type:'identity',identity_key:'victim account'});
  assert.deepEqual(encoded,{key:'identity:victim%20account',scope:'identity',identity:'victim account'});

  const unicodeIdentity='你'.repeat(67);
  const unicode=browserContextKey({scope_type:'identity',identity_key:unicodeIdentity});
  assert.deepEqual(browserContextKey({context_key:unicode.key,default_scope:'task',task_id:'planning-task'}),unicode);
});

test('canonical browser context keys reject a scope or identity rebinding attempt',()=>{
  assert.throws(
    ()=>browserContextKey({context_key:'identity:victim',scope_type:'task',task_id:'planning-task'}),
    /scope conflicts/,
  );
  assert.throws(
    ()=>browserContextKey({context_key:'identity:victim',scope_type:'identity',identity_key:'attacker',task_id:'planning-task'}),
    /identity conflicts/,
  );
  assert.throws(
    ()=>browserContextKey({context_key:'task:planning-task',task_id:'other-task'}),
    /does not belong/,
  );
  assert.throws(
    ()=>browserContextKey({context_key:'task:planning-task'}),
    /does not belong/,
  );
  assert.throws(
    ()=>browserContextKey({context_key:'identity: victim '}),
    /canonical/,
  );
  assert.throws(
    ()=>browserContextKey({context_key:'identity:%76ictim'}),
    /canonical encoding/,
  );
});


test('an active normal-business recording binds browser operations to its exact capture context', async () => {
  const context = {
    taskId: 'normal-task',
    scanRunId: 'scan-1',
    repo: {
      getTask: async (taskId) => taskId === 'normal-task'
        ? { id: taskId, execution_plan: { intent: 'learn_business_flow', flow_id: 'flow-1' } }
        : undefined,
    },
    db: {
      repos: {
        recordingSessions: {
          findAll: async () => [{
            id: 'recording-1',
            capture_filters: {
              source: 'agent_business',
              scan_run_id: 'scan-1',
              task_id: 'normal-task',
              capture_status: 'recording',
              context_key: 'identity:attacker',
              scope_type: 'identity',
              identity_key: 'attacker',
            },
          }],
        },
      },
    },
  };
  const binding = await activeBusinessCaptureBrowserBinding(context);
  assert.deepEqual(binding, {
    recording_session_id: 'recording-1',
    context_key: 'identity:attacker',
    context_scope: 'identity',
    identity_key: 'attacker',
  });
  assert.deepEqual(bindActiveBusinessCaptureBrowserInput({ url: 'https://target.test/account' }, binding), {
    url: 'https://target.test/account',
    context_key: 'identity:attacker',
    context_scope: 'identity',
    identity_key: 'attacker',
  });
  assert.throws(
    () => bindActiveBusinessCaptureBrowserInput({ context_key: 'task:normal-task' }, binding),
    /exact bound browser context/,
  );
  assert.throws(
    () => bindActiveBusinessCaptureBrowserInput({ context_scope: 'task' }, binding),
    /exact bound browser context scope/,
  );
  assert.throws(
    () => bindActiveBusinessCaptureBrowserInput({ identity_key: 'victim' }, binding),
    /exact bound browser identity/,
  );
});

test('a normal-business recording without a persisted browser binding fails closed', async () => {
  const context = {
    taskId: 'normal-task',
    scanRunId: 'scan-1',
    repo: { getTask: async () => ({ execution_plan: { intent: 'learn_business_flow' } }) },
    db: {
      repos: {
        recordingSessions: {
          findAll: async () => [{
            id: 'recording-1',
            capture_filters: {
              source: 'agent_business',
              scan_run_id: 'scan-1',
              task_id: 'normal-task',
              capture_status: 'recording',
            },
          }],
        },
      },
    },
  };
  await assert.rejects(activeBusinessCaptureBrowserBinding(context), /no persisted browser context binding/);
});
