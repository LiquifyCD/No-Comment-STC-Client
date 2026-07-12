import test from 'node:test';
import assert from 'node:assert/strict';
import {runOpenDoorFlow,validateOpenDoorBody} from './open-door-flow.mjs';

const body={email:'person@example.test',password:'mock-password',doorName:'Main entrance'};

test('accepts only credentials and a normalized door name',()=>{
  assert.deepEqual(validateOpenDoorBody({...body,doorName:'  Main   entrance  '}),{ok:true,email:body.email,password:body.password,doorName:'Main entrance',doorNameKey:'main entrance'});
  for(const field of ['major','minor','cardReader','customerId','accessToken'])assert.equal(validateOpenDoorBody({...body,[field]:'1'}).status,400);
  assert.equal(validateOpenDoorBody({...body,doorName:'<script>'}).status,400);
});

test('disabled flow makes zero upstream requests',async()=>{
  let calls=0;
  const result=await runOpenDoorFlow({fetcher:async()=>{calls++;throw new Error('must not run')},baseUrl:'https://mock.invalid',appId:'1',body,resolveReaderByName:async()=>null,enabled:false,authorizationId:'UNAUTHORIZED'});
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
  const result=await runOpenDoorFlow({fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,resolveReaderByName:async(customerId,nameKey)=>{resolved.push({customerId,nameKey});return {id:'owned-reader',major:'990001',minor:'990002'}},beforeOpen:async()=>true,enabled:true,authorizationId:'APPROVED-mock'});
  assert.deepEqual(result,{ok:true,status:200,message:'Door opened.',customerId:'own-customer',readerId:'owned-reader'});
  assert.deepEqual(resolved,[{customerId:'own-customer',nameKey:'main entrance'}]);
  assert.equal(calls.length,4);
  assert.match(calls[2].url,/passagereaders\?major=990001&minor=990002$/);
  assert.deepEqual(JSON.parse(calls[3].init.body),{cardReader:900002,printTicket:true});
});

test('rejects missing ownership and malformed lookup responses',async()=>{
  const baseFetcher=async url=>String(url).endsWith('/auth/login')?new Response(JSON.stringify({access_token:'mock',username:'own'}),{status:200,headers:{'content-type':'application/json'}}):new Response('{}',{status:200,headers:{'content-type':'application/json'}});
  const missing=await runOpenDoorFlow({fetcher:baseFetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,resolveReaderByName:async()=>null,beforeOpen:async()=>true,enabled:true,authorizationId:'APPROVED-mock'});
  assert.equal(missing.status,404);
  const malformed=await runOpenDoorFlow({fetcher:baseFetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,resolveReaderByName:async()=>({id:'owned-reader',major:'1',minor:'2'}),beforeOpen:async()=>true,enabled:true,authorizationId:'APPROVED-mock'});
  assert.equal(malformed.status,502);
  const ambiguous=await runOpenDoorFlow({fetcher:baseFetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,resolveReaderByName:async()=>({ambiguous:true}),beforeOpen:async()=>true,enabled:true,authorizationId:'APPROVED-mock'});
  assert.equal(ambiguous.status,409);
});

test('invalid credential errors never expose secrets',async()=>{
  const fetcher=async url=>String(url).includes('/apps/')?new Response('{}',{status:200}):new Response('{}',{status:401});
  const result=await runOpenDoorFlow({fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,resolveReaderByName:async()=>null,beforeOpen:async()=>true,enabled:true,authorizationId:'APPROVED-mock'});
  const serialized=JSON.stringify(result);assert.equal(result.status,401);
  for(const secret of [body.email,body.password,body.doorName,'990001','990002','900002'])assert.equal(serialized.includes(secret),false);
});

test('rate-limited request stops before reader lookup and passage',async()=>{
  let passageCalls=0;
  const fetcher=async url=>{
    if(String(url).endsWith('/auth/login'))return new Response(JSON.stringify({access_token:'mock',username:'own'}),{status:200,headers:{'content-type':'application/json'}});
    if(String(url).includes('/passagereaders'))passageCalls++;
    return new Response('{}',{status:200,headers:{'content-type':'application/json'}});
  };
  const result=await runOpenDoorFlow({fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,resolveReaderByName:async()=>({id:'owned-reader',major:'1',minor:'2'}),beforeOpen:async()=>false,enabled:true,authorizationId:'APPROVED-mock'});
  assert.equal(result.status,429);assert.equal(passageCalls,0);
});
