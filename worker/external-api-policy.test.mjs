import test from 'node:test';
import assert from 'node:assert/strict';
import {validateExternalOpenRequest} from './external-api-policy.mjs';

const valid={protocol:'https:',origin:null,expectedOrigin:'https://client.example',apiKey:'mock-api-key',expectedApiKey:'mock-api-key',recentAt:null,now:10_000};

test('external API requires HTTPS and a valid API key',()=>{
  assert.deepEqual(validateExternalOpenRequest(valid),{ok:true});
  assert.equal(validateExternalOpenRequest({...valid,protocol:'http:'}).status,400);
  assert.equal(validateExternalOpenRequest({...valid,apiKey:''}).status,401);
  assert.equal(validateExternalOpenRequest({...valid,apiKey:'wrong'}).status,401);
});

test('external API rejects cross-origin and repeated requests',()=>{
  assert.equal(validateExternalOpenRequest({...valid,origin:'https://evil.example'}).status,403);
  assert.equal(validateExternalOpenRequest({...valid,recentAt:9_500}).status,429);
  assert.deepEqual(validateExternalOpenRequest({...valid,recentAt:9_000}),{ok:true});
});
