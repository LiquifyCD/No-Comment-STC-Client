import test from 'node:test';
import assert from 'node:assert/strict';
import {constantTimeEqual,createDeviceCredential,hashDeviceSecret,parseDeviceCredential,validateDeviceInput,validateDeviceTargetBody} from './device-credential.mjs';

test('device credential is random, parseable, and only its hash needs storage',async()=>{
  const first=createDeviceCredential('123e4567-e89b-42d3-a456-426614174000'),second=createDeviceCredential('123e4567-e89b-42d3-a456-426614174000');
  assert.notEqual(first.credential,second.credential);assert.deepEqual(parseDeviceCredential(first.credential),{id:first.id,secret:first.secret});
  const hash=await hashDeviceSecret(first.secret,'server-secret');assert.equal(constantTimeEqual(hash,await hashDeviceSecret(first.secret,'server-secret')),true);assert.equal(constantTimeEqual(hash,await hashDeviceSecret(second.secret,'server-secret')),false);
});

test('fast request accepts exactly one named target and no credentials',()=>{
  assert.equal(validateDeviceTargetBody({sequenceName:'Morning entry'}).ok,true);
  for(const body of [{},{doorName:'Main',sequenceName:'Entry'},{doorName:'Main',password:'secret'},{customerId:'1',doorName:'Main'}])assert.equal(validateDeviceTargetBody(body).ok,false);
});

test('device input limits expiry and allowlist',()=>{
  assert.equal(validateDeviceInput({name:'My iPhone',expiresInDays:30,targets:[]}).ok,true);
  assert.equal(validateDeviceInput({name:'My iPhone',expiresInDays:'never',targets:[]}).ok,true);
  assert.equal(validateDeviceInput({name:'My iPhone',expiresInDays:91}).ok,false);
  assert.equal(validateDeviceInput({name:'My iPhone',targets:[{type:'door',id:'bad'}]}).ok,false);
});
