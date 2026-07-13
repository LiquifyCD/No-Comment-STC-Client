import test from 'node:test';
import assert from 'node:assert/strict';
import {runOpenDoorFlow,validateOpenDoorBody} from './open-door-flow.mjs';

const doorBody={email:'person@example.test',password:'mock-password',doorName:'Main entrance'};
const sequenceBody={email:'person@example.test',password:'mock-password',sequenceName:'Entry flow'};

test('accepts exactly one normalized door or sequence name',()=>{
  assert.deepEqual(validateOpenDoorBody({...doorBody,doorName:'  Main   entrance  '}),{ok:true,email:doorBody.email,password:doorBody.password,targetType:'door',targetName:'Main entrance',targetNameKey:'main entrance'});
  assert.equal(validateOpenDoorBody(sequenceBody).targetType,'sequence');
  assert.equal(validateOpenDoorBody({...doorBody,sequenceName:'Entry'}).status,400);
  assert.equal(validateOpenDoorBody({email:doorBody.email,password:doorBody.password}).status,400);
  for(const field of ['readerId','major','minor','cardReader','customerId','accessToken'])assert.equal(validateOpenDoorBody({...doorBody,[field]:'1'}).status,400);
});

test('disabled flow makes zero upstream requests',async()=>{
  let calls=0;
  const result=await runOpenDoorFlow({fetcher:async()=>{calls++;throw new Error('must not run')},baseUrl:'https://mock.invalid',appId:'1',body:doorBody,resolveTarget:async()=>null,executeTarget:async()=>({ok:true,completedSteps:1}),enabled:false,authorizationId:'UNAUTHORIZED'});
  assert.equal(result.status,503);assert.equal(calls,0);
});

test('mocked flow authenticates then executes only the owner-resolved target',async()=>{
  const calls=[];
  const fetcher=async(url,init={})=>{calls.push({url:String(url),init});if(String(url).endsWith('/auth/login'))return new Response(JSON.stringify({access_token:'mock-access',username:'own-customer'}),{status:200,headers:{'content-type':'application/json','set-cookie':'GCLB=mock; Secure'}});return new Response('{}',{status:200,headers:{'content-type':'application/json'}})};
  const resolved=[],executed=[];
  const target={id:'owned-sequence',type:'sequence',steps:[{reader_id:'owned-reader',delay_after_ms:3000}]};
  const result=await runOpenDoorFlow({fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body:sequenceBody,resolveTarget:async(customerId,type,nameKey)=>{resolved.push({customerId,type,nameKey});return target},executeTarget:async(auth,value)=>{executed.push({customerId:auth.customerId,target:value.id});return {ok:true,completedSteps:2}},enabled:true,authorizationId:'APPROVED-mock'});
  assert.deepEqual(resolved,[{customerId:'own-customer',type:'sequence',nameKey:'entry flow'}]);
  assert.deepEqual(executed,[{customerId:'own-customer',target:'owned-sequence'}]);
  assert.deepEqual(result,{ok:true,status:200,message:'Request completed.',customerId:'own-customer',targetId:'owned-sequence',targetType:'sequence',completedSteps:2});
  assert.equal(calls.length,2);
});

test('rejects unknown, ambiguous, unauthorized, and partial-failure targets',async()=>{
  const fetcher=async url=>String(url).endsWith('/auth/login')?new Response(JSON.stringify({access_token:'mock',username:'own'}),{status:200,headers:{'content-type':'application/json'}}):new Response('{}',{status:200});
  const base={fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body:doorBody,executeTarget:async()=>({ok:true,completedSteps:1}),enabled:true,authorizationId:'APPROVED-mock'};
  assert.equal((await runOpenDoorFlow({...base,resolveTarget:async()=>null})).status,404);
  assert.equal((await runOpenDoorFlow({...base,resolveTarget:async()=>({ambiguous:true})})).status,409);
  const failed=await runOpenDoorFlow({...base,resolveTarget:async()=>({id:'owned',type:'sequence',steps:[]}),executeTarget:async()=>({ok:false,status:502,error:'Rejected.',failedStep:2,completedSteps:1})});
  assert.deepEqual(failed,{ok:false,status:502,error:'Rejected.',failedStep:2,completedSteps:1});
});

test('invalid credential errors never expose secrets',async()=>{
  const fetcher=async url=>String(url).includes('/apps/')?new Response('{}',{status:200}):new Response('{}',{status:401});
  const result=await runOpenDoorFlow({fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body:doorBody,resolveTarget:async()=>null,executeTarget:async()=>({ok:true,completedSteps:1}),enabled:true,authorizationId:'APPROVED-mock'});
  const serialized=JSON.stringify(result);assert.equal(result.status,401);
  for(const secret of [doorBody.email,doorBody.password,doorBody.doorName,'8251','543516','1306'])assert.equal(serialized.includes(secret),false);
});
