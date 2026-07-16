import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshBrpSession} from './brp-refresh.mjs';

test('refresh is disabled until an observed path is configured',async()=>{
  let calls=0;const result=await refreshBrpSession({fetcher:async()=>{calls++;throw new Error('unexpected')},baseUrl:'https://mock.invalid',refreshToken:'refresh',customerId:'7'});
  assert.equal(result.ok,false);assert.equal(calls,0);
});

test('refresh accepts a mocked same-customer response without exposing credentials',async()=>{
  const calls=[];const result=await refreshBrpSession({fetcher:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({username:'7',access_token:'new',refresh_token:'next',expires_in:3600}),{status:200,headers:{'set-cookie':'GCLB=next; Secure'}})},baseUrl:'https://mock.invalid',path:'/auth/refresh',refreshToken:'old',currentCookie:'GCLB=old',customerId:'7',now:()=>1000});
  assert.equal(result.ok,true);assert.equal(result.accessToken,'new');assert.equal(result.expiresAt,3601000);assert.equal(calls.length,1);
});

test('refresh rejects a mocked customer mismatch',async()=>{
  const result=await refreshBrpSession({fetcher:async()=>new Response(JSON.stringify({username:'8',access_token:'new'}),{status:200}),baseUrl:'https://mock.invalid',path:'/auth/refresh',refreshToken:'old',customerId:'7'});
  assert.equal(result.ok,false);
});
