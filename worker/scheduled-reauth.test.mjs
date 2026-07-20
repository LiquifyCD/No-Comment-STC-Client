import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {MAX_REAUTH_BATCH,REAUTH_EXPIRY_MARGIN_MS,REAUTH_INTERVAL_MS,REAUTH_RETRY_MS,nextReauthenticationAt,runScheduledReauthentication,selectReauthenticationCandidates} from './scheduled-reauth.mjs';

const NOW=1_800_000_000_000;
const row=(changes={})=>({owner_id:'owner',session_version:1,active_device_count:1,scheduled_reauth_enabled:1,scheduled_reauth_ciphertext:'encrypted',next_reauth_at:NOW,refresh_lock_until:null,...changes});
const session={customerId:'customer',accessToken:'access',refreshToken:'refresh',upstreamCookie:'GCLB=mock',expiresAt:NOW+7*86400000};

test('migration preserves owner sessions and defaults automatic login to off',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0007_owner_upstream_sessions.sql',import.meta.url),'utf8'));
  db.prepare("INSERT INTO owner_upstream_sessions(owner_id,session_ciphertext,upstream_expires_at,created_at,updated_at) VALUES(?,?,?,?,?)").run('owner','encrypted',NOW,'created','updated');
  db.exec(readFileSync(new URL('../migrations/0008_scheduled_reauthentication.sql',import.meta.url),'utf8'));
  const stored=db.prepare('SELECT owner_id,scheduled_reauth_ciphertext,scheduled_reauth_enabled,next_reauth_at,last_reauth_at FROM owner_upstream_sessions').get();
  assert.deepEqual({...stored},{owner_id:'owner',scheduled_reauth_ciphertext:null,scheduled_reauth_enabled:0,next_reauth_at:null,last_reauth_at:null});
});

test('next full login occurs within three days and before the expiry margin',()=>{
  assert.equal(nextReauthenticationAt(NOW,NOW+7*86400000),NOW+REAUTH_INTERVAL_MS);
  assert.equal(nextReauthenticationAt(NOW,NOW+2*86400000),NOW+2*86400000-REAUTH_EXPIRY_MARGIN_MS);
  assert.equal(nextReauthenticationAt(NOW,NOW+1),NOW);
});

test('candidate selection requires opt-in credentials, active devices, due time, and an available lock',()=>{
  const due=Array.from({length:MAX_REAUTH_BATCH+2},(_,index)=>row({owner_id:`due-${index}`,next_reauth_at:NOW-index}));
  const selected=selectReauthenticationCandidates([...due,row({owner_id:'disabled',scheduled_reauth_enabled:0}),row({owner_id:'missing',scheduled_reauth_ciphertext:null}),row({owner_id:'future',next_reauth_at:NOW+1}),row({owner_id:'revoked',active_device_count:0}),row({owner_id:'locked',refresh_lock_until:NOW+1})],NOW);
  assert.equal(selected.length,MAX_REAUTH_BATCH);
  assert.ok(selected.every(item=>item.owner_id.startsWith('due-')));
});

test('disabled scheduling performs no database query or login',async()=>{
  let calls=0;
  const result=await runScheduledReauthentication({enabled:false,now:NOW,listCandidates:async()=>{calls++;return[]},acquire:async()=>false,decryptCredentials:async()=>null,authenticate:async()=>{calls++;return {ok:false,status:500}},ownerForCustomer:async()=>'',saveSuccess:async()=>{},saveFailure:async()=>{},release:async()=>{},audit:async()=>{}});
  assert.deepEqual(result,{status:'disabled',selected:0,renewed:0,failed:0});
  assert.equal(calls,0);
});

test('successful scheduled login atomically replaces the shared owner session',async()=>{
  let locked=false,logins=0,saved;
  const options={enabled:true,now:NOW,listCandidates:async()=>[row()],acquire:async()=>{if(locked)return false;locked=true;return true},decryptCredentials:async()=>({username:'person@example.test',password:'mock-password'}),authenticate:async()=>{logins++;return {ok:true,session}},ownerForCustomer:async()=> 'owner',saveSuccess:async(_row,fresh,nextAt)=>{saved={fresh,nextAt}},saveFailure:async()=>{},release:async()=>{locked=false},audit:async()=>{}};
  const [first,second]=await Promise.all([runScheduledReauthentication(options),runScheduledReauthentication(options)]);
  assert.equal(logins,1);
  assert.equal(first.renewed+second.renewed,1);
  assert.deepEqual(saved,{fresh:session,nextAt:NOW+REAUTH_INTERVAL_MS});
});

test('wrong credentials and owner mismatch disable retries without exposing secrets',async()=>{
  for(const scenario of ['credentials','owner']){
    let failure,audit;
    const result=await runScheduledReauthentication({enabled:true,now:NOW,listCandidates:async()=>[row()],acquire:async()=>true,decryptCredentials:async()=>({username:'person@example.test',password:'sensitive-password'}),authenticate:async()=>scenario==='credentials'?{ok:false,status:401}:{ok:true,session},ownerForCustomer:async()=>scenario==='owner'?'other':'owner',saveSuccess:async()=>{},saveFailure:async(_row,status,error,disable)=>{failure={status,error,disable}},release:async()=>{},audit:async(_row,eventType,status)=>{audit={eventType,status}}});
    assert.equal(result.failed,1);
    assert.equal(failure.disable,true);
    assert.equal(failure.status,'reauthorization_required');
    assert.equal(JSON.stringify({result,failure,audit}).includes('sensitive-password'),false);
  }
});

test('transient login failure stays enabled and retries at the next cron window',async()=>{
  let failure;
  await runScheduledReauthentication({enabled:true,now:NOW,listCandidates:async()=>[row()],acquire:async()=>true,decryptCredentials:async()=>({username:'person@example.test',password:'mock-password'}),authenticate:async()=>({ok:false,status:502}),ownerForCustomer:async()=> 'owner',saveSuccess:async()=>{},saveFailure:async(_row,status,error,disable,now)=>{failure={status,error,disable,nextAt:now+REAUTH_RETRY_MS}},release:async()=>{},audit:async()=>{}});
  assert.deepEqual(failure,{status:'refresh_failed',error:'reauth_failed',disable:false,nextAt:NOW+REAUTH_RETRY_MS});
});
