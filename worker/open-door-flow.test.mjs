import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReaderCatalog} from './reader-catalog.mjs';
import {runOpenDoorFlow,validateOpenDoorBody} from './open-door-flow.mjs';

const catalog=parseReaderCatalog('{"front":{"label":"Front","code":1234}}',0);
const body={email:'person@example.test',password:'mock-password',reader:'front'};

test('validates email, password, and server-configured reader alias',()=>{
  assert.deepEqual(validateOpenDoorBody(body,catalog),{ok:true,email:'person@example.test',password:'mock-password',cardReader:1234});
  assert.equal(validateOpenDoorBody({...body,reader:'unknown'},catalog).status,400);
  assert.equal(validateOpenDoorBody({...body,cardReader:9999},catalog).status,400);
  assert.equal(validateOpenDoorBody({...body,accessToken:'token'},catalog).status,400);
});

test('disabled flow makes zero upstream requests',async()=>{
  let calls=0;
  const result=await runOpenDoorFlow({fetcher:async()=>{calls++;throw new Error('must not run')},baseUrl:'https://mock.invalid',appId:'1',body,catalog,enabled:false,authorizationId:'UNAUTHORIZED'});
  assert.equal(result.status,503);
  assert.equal(calls,0);
});

test('mocked flow logs in and sends exactly one door request',async()=>{
  const calls=[];
  const fetcher=async(url,init={})=>{
    calls.push({url,init});
    if(url.endsWith('/auth/login'))return new Response(JSON.stringify({access_token:'mock-access',refresh_token:'mock-refresh',username:'own-customer'}),{status:200,headers:{'content-type':'application/json','set-cookie':'GCLB=mock; Secure'}});
    return new Response('{}',{status:200,headers:{'content-type':'application/json','set-cookie':'GCLB=mock; Secure'}});
  };
  const result=await runOpenDoorFlow({fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,catalog,enabled:true,authorizationId:'APPROVED-mock'});
  assert.deepEqual(result,{ok:true,status:200,message:'Door opened.'});
  assert.equal(calls.length,3);
  assert.match(calls[0].url,/\/apps\/1/);
  assert.equal(calls[1].url,'https://mock.invalid/api/auth/login');
  assert.equal(calls[2].url,'https://mock.invalid/api/customers/own-customer/passagetries');
  assert.deepEqual(JSON.parse(calls[2].init.body),{cardReader:1234,printTicket:true});
});

test('returns generic authentication errors without secrets',async()=>{
  const fetcher=async(url)=>url.includes('/apps/')?new Response('{}',{status:200}):new Response('{}',{status:401});
  const result=await runOpenDoorFlow({fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body,catalog,enabled:true,authorizationId:'APPROVED-mock'});
  const serialized=JSON.stringify(result);
  assert.deepEqual(result,{ok:false,status:401,error:'Invalid credentials.'});
  for(const secret of [body.email,body.password,'mock-access','own-customer','1234'])assert.equal(serialized.includes(secret),false);
});
