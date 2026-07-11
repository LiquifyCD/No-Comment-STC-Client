import test from 'node:test';
import assert from 'node:assert/strict';
import {sendDoorRequest} from './door-service.mjs';

test('door service uses only server-provided credentials and reader code',async()=>{
  let captured;
  const fetcher=async(url,init)=>{captured={url,init};return new Response('{}',{status:200})};
  const response=await sendDoorRequest({fetcher,baseUrl:'https://mock.invalid/api',customerId:'customer-own',cardReader:1234,accessToken:'mock-token',cookie:'mock-cookie'});
  assert.equal(response.status,200);
  assert.equal(captured.url,'https://mock.invalid/api/customers/customer-own/passagetries');
  assert.deepEqual(JSON.parse(captured.init.body),{cardReader:1234,printTicket:true});
  assert.equal(captured.init.headers.authorization,'Bearer mock-token');
  assert.equal(captured.init.headers.cookie,'mock-cookie');
});

test('mocked door test cannot contact a real host',async()=>{
  let calls=0;
  await sendDoorRequest({fetcher:async()=>{calls++;return new Response(null,{status:204})},baseUrl:'https://mock.invalid/api',customerId:'own',cardReader:1,accessToken:'mock'});
  assert.equal(calls,1);
});
