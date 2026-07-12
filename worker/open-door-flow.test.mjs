import test from 'node:test';
import assert from 'node:assert/strict';
import {runOpenDoorFlow,validateOpenDoorBody} from './open-door-flow.mjs';

const reader='11111111-1111-4111-8111-111111111111';
const body={email:'person@example.test',password:'mock-password',reader};

test('accepts only credentials and a reader UUID',()=>{
  assert.deepEqual(validateOpenDoorBody(body),{ok:true,email:body.email,password:body.password,reader});
  for(const field of ['major','minor','cardReader','customerId','accessToken'])assert.equal(validateOpenDoorBody({...body,[field]:'1'}).status,400);
  assert.equal(validateOpenDoorBody({...body,reader:'arbitrary'}).status,400);
});

test('disabled flow makes zero upstream requests',async()=>{
  let calls=0;
  const result=await runOpenDoorFlow({fetcher:async()=>{calls++;throw new Error('must not run')},baseUrl:'https://mock.invalid',appId:'1',body,resolveReader:async()=>null,enabled:false,authorizationId:'UNAUTHORIZED'});
  assert.equal(result.status,503);assert.equal(calls,0);
});

test('mocked flow logs in, looks up reader, then sends one passage request',async()=>{
  const calls=[];
  const fetcher=async(url,init={})=>{
    calls.push({url:String(url),init});
    if(String(url).endsWith('/auth/login'))return new Response(JSON.stringify({access_token:'mock-access',username:'own-customer'}),{status:200,headers:{'content-type':'application/json','set-cookie':'GCLB=mock; Secure'}});
    if(String(url).includes('/passagereaders?'))return new Response(JSON.stringify({id:900002,name:'Mock reader'}),{status:200,headers:{'content-type':'application/json'}});
    return new Response('{}',{status:200,headers:{'content-type':'application/json','set-cookie':'GCLB=mock; Secure'}});
  };
  const resolved=[];
  const result=await runOpenDoorFlow({fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,resolveReader:async(customerId,readerId)=>{resolved.push({customerId,readerId});return {major:'990001',minor:'990002'}},enabled:true,authorizationId:'APPROVED-mock'});
  assert.deepEqual(result,{ok:true,status:200,message:'Door opened.'});
  assert.deepEqual(resolved,[{customerId:'own-customer',readerId:reader}]);
  assert.equal(calls.length,4);
  assert.match(calls[2].url,/passagereaders\?major=990001&minor=990002$/);
  assert.deepEqual(JSON.parse(calls[3].init.body),{cardReader:900002,printTicket:true});
});

test('rejects missing ownership and malformed lookup responses',async()=>{
  const baseFetcher=async url=>String(url).endsWith('/auth/login')?new Response(JSON.stringify({access_token:'mock',username:'own'}),{status:200,headers:{'content-type':'application/json'}}):new Response('{}',{status:200,headers:{'content-type':'application/json'}});
  const missing=await runOpenDoorFlow({fetcher:baseFetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,resolveReader:async()=>null,enabled:true,authorizationId:'APPROVED-mock'});
  assert.equal(missing.status,404);
  const malformed=await runOpenDoorFlow({fetcher:baseFetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,resolveReader:async()=>({major:'1',minor:'2'}),enabled:true,authorizationId:'APPROVED-mock'});
  assert.equal(malformed.status,502);
});

test('invalid credential errors never expose secrets',async()=>{
  const fetcher=async url=>String(url).includes('/apps/')?new Response('{}',{status:200}):new Response('{}',{status:401});
  const result=await runOpenDoorFlow({fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,resolveReader:async()=>null,enabled:true,authorizationId:'APPROVED-mock'});
  const serialized=JSON.stringify(result);assert.equal(result.status,401);
  for(const secret of [body.email,body.password,reader,'990001','990002','900002'])assert.equal(serialized.includes(secret),false);
});
