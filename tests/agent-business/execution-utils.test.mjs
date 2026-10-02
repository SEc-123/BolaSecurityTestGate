import test from 'node:test';
import assert from 'node:assert/strict';
import {joinRequestUrl} from '../../server/src/services/execution-utils.ts';

test('native request URL joining keeps captured origin-relative paths valid for trailing scan URLs',()=>{
  assert.equal(joinRequestUrl('https://authorized.example.test/','/login?next=%2Fworkspace'),'https://authorized.example.test/login?next=%2Fworkspace');
  assert.equal(joinRequestUrl('https://authorized.example.test','/workspace'),'https://authorized.example.test/workspace');
  assert.equal(joinRequestUrl('https://authorized.example.test/base/','/workspace'),'https://authorized.example.test/base/workspace');
  assert.equal(joinRequestUrl('https://authorized.example.test/base','workspace'),'https://authorized.example.test/base/workspace');
});
