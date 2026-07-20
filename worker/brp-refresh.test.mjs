import test from 'node:test';
import assert from 'node:assert/strict';
import {BRP_REFRESH_CONTRACT_VERIFIED,refreshBrpSession} from './brp-refresh.mjs';

test('unverified refresh contract is disabled and performs no network request',async()=>{
  const originalFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('unexpected network request')};
  try{
    const result=await refreshBrpSession({customerId:'7',accessToken:'access',refreshToken:'refresh',expiresAt:Date.now()+60_000});
    assert.equal(BRP_REFRESH_CONTRACT_VERIFIED,false);
    assert.deepEqual(result,{ok:false,status:501,error:'Refresh contract unavailable.',reason:'contract_unavailable'});
    assert.equal(calls,0);
  }finally{globalThis.fetch=originalFetch}
});
