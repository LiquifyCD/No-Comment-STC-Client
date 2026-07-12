export function validateReaderDeletion({authenticated,originMatches,csrfValid,confirmed}){
  if(!authenticated)return {ok:false,status:401,error:'Inte inloggad.'};
  if(!originMatches)return {ok:false,status:403,error:'Otillåtet ursprung.'};
  if(!csrfValid)return {ok:false,status:403,error:'Ogiltig CSRF-token.'};
  if(confirmed!==true)return {ok:false,status:400,error:'Borttagningen måste bekräftas.'};
  return {ok:true};
}

export async function deleteOwnedReader({db,owner,readerId}){
  const result=await db.prepare('DELETE FROM readers WHERE id=? AND owner_id=?').bind(readerId,owner).run();
  return Boolean(result.meta.changes);
}
