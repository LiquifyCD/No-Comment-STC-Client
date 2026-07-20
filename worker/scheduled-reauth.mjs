export const REAUTH_INTERVAL_MS=3*24*60*60*1000;
export const REAUTH_EXPIRY_MARGIN_MS=36*60*60*1000;
export const REAUTH_RETRY_MS=12*60*60*1000;
export const REAUTH_LOCK_MS=2*60*1000;
export const MAX_REAUTH_BATCH=12;

export function nextReauthenticationAt(now,expiresAt){
  return Math.max(now,Math.min(now+REAUTH_INTERVAL_MS,expiresAt-REAUTH_EXPIRY_MARGIN_MS));
}

export function selectReauthenticationCandidates(rows,now=Date.now(),limit=MAX_REAUTH_BATCH){
  return rows.filter(row=>row.active_device_count>0&&row.scheduled_reauth_enabled===1&&typeof row.scheduled_reauth_ciphertext==='string'&&row.scheduled_reauth_ciphertext.length>0&&typeof row.next_reauth_at==='number'&&row.next_reauth_at<=now&&(!row.refresh_lock_until||row.refresh_lock_until<=now)).sort((a,b)=>a.next_reauth_at-b.next_reauth_at).slice(0,limit);
}

export async function runScheduledReauthentication({enabled,now=Date.now(),limit=MAX_REAUTH_BATCH,listCandidates,acquire,decryptCredentials,authenticate,ownerForCustomer,saveSuccess,saveFailure,release,audit}){
  if(!enabled)return {status:'disabled',selected:0,renewed:0,failed:0};
  const candidates=await listCandidates({now,limit});
  let renewed=0,failed=0;
  for(const row of candidates.slice(0,limit)){
    const started=Date.now();
    if(!await acquire(row,now+REAUTH_LOCK_MS))continue;
    try{
      const credentials=await decryptCredentials(row);
      if(!credentials||typeof credentials.username!=='string'||!credentials.username||typeof credentials.password!=='string'||!credentials.password){
        await saveFailure(row,'reauthorization_required','invalid_credentials',true,now);
        await audit(row,'refresh_failed','reauthorization_required',Date.now()-started);
        failed++;
        continue;
      }
      const result=await authenticate(credentials);
      if(!result.ok){
        const permanent=result.status===401;
        await saveFailure(row,permanent?'reauthorization_required':'refresh_failed',permanent?'credentials_rejected':'reauth_failed',permanent,now);
        await audit(row,'refresh_failed',permanent?'reauthorization_required':'refresh_failed',Date.now()-started);
        failed++;
        continue;
      }
      if(await ownerForCustomer(result.session.customerId)!==row.owner_id){
        await saveFailure(row,'reauthorization_required','owner_mismatch',true,now);
        await audit(row,'refresh_failed','reauthorization_required',Date.now()-started);
        failed++;
        continue;
      }
      await saveSuccess(row,result.session,nextReauthenticationAt(now,result.session.expiresAt));
      await audit(row,'reauthorize','healthy',Date.now()-started);
      renewed++;
    }catch{
      await saveFailure(row,'refresh_failed','reauth_failed',false,now);
      await audit(row,'refresh_failed','refresh_failed',Date.now()-started);
      failed++;
    }finally{
      await release(row);
    }
  }
  return {status:'completed',selected:candidates.length,renewed,failed};
}
