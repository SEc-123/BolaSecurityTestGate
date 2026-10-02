import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {AIClient} from '../../server/src/services/ai/ai-client.ts';

const paths = [
  {name: 'normal learning', task_type: 'learn_business_flow', intent: 'learn_business_flow'},
  {name: 'generic vulnerability', task_type: 'test_generic_vuln', intent: 'execute_test'},
  {name: 'upload vulnerability', task_type: 'test_file_upload', intent: 'execute_test'},
];

for (const path of paths) test(`${path.name} model message stays valid JSON after secret redaction`, async t => {
  const opaqueRecording = `recording-${path.task_type}`;
  const secretSession = `session-material-${path.task_type}`;
  const secretCookie = `cookie-material-${path.task_type}`;
  let received;
  const provider = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const wire = JSON.parse(raw);
      received = JSON.parse(wire.messages.find(message => message.role === 'user').content);
      assert.equal(received.context.task.task_type, path.task_type);
      assert.equal(received.context.task.execution_plan.intent, path.intent);
      assert.equal(received.context.recording_session_id, opaqueRecording,
        'assessment-owned recording references remain callable after sanitization');
      assert.equal(received.context.browser.session_id, '[REDACTED]');
      assert.equal(received.context.browser.cookie, '[REDACTED]');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({id: `serialized-${path.task_type}`, model: 'fixture-model', choices: [{message: {role: 'assistant', content: '{}'}}]}));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({error: {message: String(error)}}));
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));

  const client = new AIClient({
    id: `serialized-${path.task_type}`,
    name: 'Serialized model message fixture',
    provider_type: 'openai_compat',
    base_url: `http://127.0.0.1:${provider.address().port}/v1`,
    api_key: 'fixture-only-key',
    model: 'fixture-model',
    is_enabled: true,
    is_default: false,
  });
  const response = await client.chat({
    model: 'fixture-model',
    max_retries: 0,
    messages: [{role: 'user', content: JSON.stringify({
      context: {
        task: {task_type: path.task_type, execution_plan: {intent: path.intent}},
        recording_session_id: opaqueRecording,
        browser: {session_id: secretSession, cookie: secretCookie},
      },
    })}],
  });

  assert.equal(response.id, `serialized-${path.task_type}`);
  assert.ok(received);
  assert.equal(JSON.stringify(received).includes(secretSession), false);
  assert.equal(JSON.stringify(received).includes(secretCookie), false);
});
