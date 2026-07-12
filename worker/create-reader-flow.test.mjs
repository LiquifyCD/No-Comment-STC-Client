import test from 'node:test';
import assert from 'node:assert/strict';
import {runCreateReaderFlow,validateConfiguredReader} from './create-reader-flow.mjs';

const body={name:'Front door',major:'990001',minor:'990002',email:'person@example.test',password:'mock-password'};
test('validates a configured reader and rejects invalid major/minor',()=>{
  assert.equal(validateConfiguredReader(body).ok,true);
  for(const field of ['major','minor'])for(const value of ['','abc','12-3','1234567890123'])assert.equal(validateConfiguredReader({...body,[field]:value}).status,400);
});
test('mocked creation authenticates without returning credentials or tokens',async()=>{
  const fetcher=async url=>String(url).endsWith('/auth/login')?new Response(JSON.stringify({access_token:'mock-token',username:'own-customer'}),{status:200,headers:{'content-type':'application/json'}}):new Response('{}',{status:200});
  const result=await runCreateReaderFlow({fetcher,baseUrl:'https://mock.invalid/api',appId:'1',body});
  assert.deepEqual(result,{ok:true,customerId:'own-customer',name:'Front door',nameKey:'front door',major:'990001',minor:'990002'});
  const serialized=JSON.stringify(result);for(const secret of [body.email,body.password,'mock-token'])assert.equal(serialized.includes(secret),false);
});
