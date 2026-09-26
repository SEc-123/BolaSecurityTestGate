import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAuthenticationOrigins,assertBrowserNavigationUrl} from '../../server/src/services/ai-scan/browser/authentication-scope.ts';
import {assertUrlInTargetScope} from '../../server/src/services/ai-scan/target-scope.ts';

test('SSO login navigation stays distinct from vulnerability execution scope',()=>{
  const target='https://app.example/dashboard',sso='https://identity.example/signin';
  const origins=normalizeAuthenticationOrigins([sso,'https://identity.example/other']);
  assert.deepEqual(origins,['https://identity.example']);
  assert.equal(assertBrowserNavigationUrl(sso,target,origins).origin,'https://identity.example');
  assert.equal(assertBrowserNavigationUrl(target,target,origins).href,target);
  assert.throws(()=>assertUrlInTargetScope(sso,target),/Out-of-scope/);
  assert.throws(()=>assertBrowserNavigationUrl('https://identity.example.evil.test',target,origins),/未配置/);
  assert.throws(()=>assertBrowserNavigationUrl('http://identity.example',target,origins),/未配置/);
  assert.throws(()=>assertBrowserNavigationUrl('https://user:password@identity.example',target,origins));
  assert.throws(()=>assertBrowserNavigationUrl('file:///etc/passwd',target,origins));
});
test('invalid authentication destinations are rejected before account use',()=>{
  for(const value of ['https://identity.example',['//identity.example'],['http://identity.example'],['https://user:pass@identity.example'],Array(9).fill('https://identity.example')])assert.throws(()=>normalizeAuthenticationOrigins(value));
  assert.deepEqual(normalizeAuthenticationOrigins(undefined),[]);
});
