export const REFRESH_WINDOW_MS=36*60*60*1000;
export const REFRESH_LOCK_MS=2*60*1000;
export const MAX_REFRESH_BATCH=12;

export function sessionStatus(row,now=Date.now()){
  if(!row||row.upstream_expires_at<=now||row.refresh_status==='reauthorization_required')return 'reauthorization_required';
  if(row.refresh_lock_until&&row.refresh_lock_until>now)return 'refresh_pending';
  if(row.refresh_status==='refresh_pending')return 'refresh_failed';
  return row.refresh_status;
}

export function selectRefreshCandidates(rows,now=Date.now(),limit=MAX_REFRESH_BATCH){
  return rows.filter(row=>row.active_device_count>0&&row.upstream_expires_at>now&&row.upstream_expires_at<=now+REFRESH_WINDOW_MS&&(!row.refresh_lock_until||row.refresh_lock_until<=now)&&row.refresh_status!=='reauthorization_required').sort((a,b)=>a.upstream_expires_at-b.upstream_expires_at).slice(0,limit);
}

export async function runProactiveRefresh({enabled,contractVerified,now=Date.now(),limit=MAX_REFRESH_BATCH,listCandidates,acquire,decryptSession,refreshSession,saveSuccess,saveFailure,release,audit}){
  if(!enabled)return {status:'disabled',selected:0,refreshed:0,failed:0};
  if(!contractVerified)return {status:'contract_unavailable',selected:0,refreshed:0,failed:0};
  const candidates=await listCandidates({now,before:now+REFRESH_WINDOW_MS,limit});
  let refreshed=0,failed=0;
  for(const row of candidates.slice(0,limit)){
    const started=Date.now();
    if(!await acquire(row,now+REFRESH_LOCK_MS))continue;
    try{
      const current=await decryptSession(row);
      if(!current||!current.refreshToken||!current.customerId||current.expiresAt<=now){
        await saveFailure(row,'reauthorization_required','invalid_session');
        await audit(row,'refresh_failed','reauthorization_required',Date.now()-started);
        failed++;
        continue;
      }
      const fresh=await refreshSession(current);
      if(!fresh||!fresh.accessToken||!fresh.refreshToken||fresh.customerId!==current.customerId||fresh.expiresAt<=now){
        await saveFailure(row,'reauthorization_required','refresh_rejected');
        await audit(row,'refresh_failed','reauthorization_required',Date.now()-started);
        failed++;
        continue;
      }
      await saveSuccess(row,fresh);
      await audit(row,'refresh_success','healthy',Date.now()-started);
      refreshed++;
    }catch{
      await saveFailure(row,'refresh_failed','refresh_failed');
      await audit(row,'refresh_failed','refresh_failed',Date.now()-started);
      failed++;
    }finally{
      await release(row);
    }
  }
  return {status:'completed',selected:candidates.length,refreshed,failed};
}
