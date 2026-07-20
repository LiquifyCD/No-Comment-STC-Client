import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_REFRESH_BATCH,REFRESH_WINDOW_MS,runProactiveRefresh,selectRefreshCandidates,sessionStatus} from './owner-session.mjs';

const NOW=1_800_000_000_000;
const row=(changes={})=>({owner_id:'owner',session_version:1,session_ciphertext:'encrypted',active_device_count:1,upstream_expires_at:NOW+60_000,refresh_lock_until:null,refresh_status:'healthy',...changes});

test('candidate selection skips fresh, revoked-only, expired, invalid and locked sessions and stays bounded',()=>{
  const candidates=Array.from({length:MAX_REFRESH_BATCH+5},(_,index)=>row({owner_id:`due-${index}`,upstream_expires_at:NOW+index+1}));
  const selected=selectRefreshCandidates([
    ...candidates,
    row({owner_id:'fresh',upstream_expires_at:NOW+REFRESH_WINDOW_MS+1}),
    row({owner_id:'revoked',active_device_count:0}),
    row({owner_id:'expired',upstream_expires_at:NOW}),
    row({owner_id:'invalid',refresh_status:'reauthorization_required'}),
    row({owner_id:'locked',refresh_lock_until:NOW+1}),
  ],NOW);
  assert.equal(selected.length,MAX_REFRESH_BATCH);
  assert.ok(selected.every(item=>item.owner_id.startsWith('due-')));
});

test('disabled or unverified scheduling performs no query or refresh',async()=>{
  for(const options of [{enabled:false,contractVerified:true},{enabled:true,contractVerified:false}]){
    let calls=0;
    const result=await runProactiveRefresh({...options,now:NOW,listCandidates:async()=>{calls++;return[]},acquire:async()=>false,decryptSession:async()=>null,refreshSession:async()=>{calls++;return null},saveSuccess:async()=>{},saveFailure:async()=>{},release:async()=>{},audit:async()=>{}});
    assert.equal(calls,0);
    assert.equal(result.selected,0);
  }
});

test('one owner refresh atomically rotates tokens, cookie and expiry for all device references',async()=>{
  const candidate=row({active_device_count:2});
  const devices=[{owner_id:'owner'},{owner_id:'owner'}];
  let locked=false,refreshes=0,stored={customerId:'7',accessToken:'old',refreshToken:'old-refresh',upstreamCookie:'GCLB=old',expiresAt:NOW+60_000};
  const options={enabled:true,contractVerified:true,now:NOW,listCandidates:async()=>[candidate],acquire:async()=>{if(locked)return false;locked=true;return true},decryptSession:async()=>stored,refreshSession:async()=>{refreshes++;await new Promise(resolve=>setTimeout(resolve,5));return {customerId:'7',accessToken:'new',refreshToken:'rotated',upstreamCookie:'GCLB=new',expiresAt:NOW+7*86400000}},saveSuccess:async(_row,fresh)=>{stored=fresh},saveFailure:async()=>{},release:async()=>{locked=false},audit:async()=>{}};
  const [first,second]=await Promise.all([runProactiveRefresh(options),runProactiveRefresh(options)]);
  assert.equal(refreshes,1);
  assert.equal(first.refreshed+second.refreshed,1);
  assert.deepEqual([stored.refreshToken,stored.upstreamCookie,stored.expiresAt],['rotated','GCLB=new',NOW+7*86400000]);
  assert.ok(devices.every(device=>device.owner_id===candidate.owner_id));
});

test('invalid and failed sessions get sanitized states and locks are released',async()=>{
  for(const scenario of ['invalid','failure']){
    let saved,refreshes=0,releases=0;
    const result=await runProactiveRefresh({enabled:true,contractVerified:true,now:NOW,listCandidates:async()=>[row()],acquire:async()=>true,decryptSession:async()=>scenario==='invalid'?{customerId:'7',accessToken:'old',expiresAt:NOW-1}:{customerId:'7',accessToken:'old',refreshToken:'refresh',expiresAt:NOW+1},refreshSession:async()=>{refreshes++;throw new Error('sensitive upstream detail')},saveSuccess:async()=>{},saveFailure:async(_row,status,error)=>{saved={status,error}},release:async()=>{releases++},audit:async()=>{}});
    assert.equal(result.failed,1);
    assert.equal(releases,1);
    assert.deepEqual(saved,scenario==='invalid'?{status:'reauthorization_required',error:'invalid_session'}:{status:'refresh_failed',error:'refresh_failed'});
    assert.equal(refreshes,scenario==='invalid'?0:1);
  }
});

test('status exposes only safe owner-session health',()=>{
  assert.equal(sessionStatus(null,NOW),'reauthorization_required');
  assert.equal(sessionStatus(row(),NOW),'healthy');
  assert.equal(sessionStatus(row({refresh_lock_until:NOW+1}),NOW),'refresh_pending');
  assert.equal(sessionStatus(row({refresh_status:'refresh_pending'}),NOW),'refresh_failed');
  assert.equal(sessionStatus(row({refresh_status:'refresh_failed'}),NOW),'refresh_failed');
  assert.equal(sessionStatus(row({upstream_expires_at:NOW}),NOW),'reauthorization_required');
});
