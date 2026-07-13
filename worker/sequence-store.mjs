export async function resolveSequenceReaders({db,owner,steps}){
  const resolved=[];
  for(const step of steps){
    const rows=await db.prepare('SELECT id FROM readers WHERE owner_id=? AND name_key=? AND (config_ciphertext IS NOT NULL OR card_reader>0) LIMIT 2').bind(owner,step.doorNameKey).all();
    if(rows.results.length!==1)return {ok:false,status:rows.results.length>1?409:404,error:rows.results.length>1?'Dörrnamnet är tvetydigt.':'En sparad dörr hittades inte.'};
    resolved.push({readerId:rows.results[0].id,position:step.position,delayAfterMs:step.delayAfterMs});
  }
  return {ok:true,steps:resolved};
}

export async function getDefaultSelection({db,owner}){
  const preference=await db.prepare('SELECT default_type,default_id FROM user_preferences WHERE owner_id=?').bind(owner).first();
  if(preference?.default_type==='door'){
    const door=await db.prepare('SELECT id FROM readers WHERE id=? AND owner_id=?').bind(preference.default_id,owner).first();
    if(door)return {type:'door',id:door.id};
  }
  if(preference?.default_type==='sequence'){
    const sequence=await db.prepare('SELECT s.id FROM sequences s WHERE s.id=? AND s.owner_id=? AND EXISTS(SELECT 1 FROM sequence_steps ss JOIN readers r ON r.id=ss.reader_id AND r.owner_id=s.owner_id WHERE ss.sequence_id=s.id)').bind(preference.default_id,owner).first();
    if(sequence)return {type:'sequence',id:sequence.id};
  }
  const door=await db.prepare('SELECT id FROM readers WHERE owner_id=? ORDER BY COALESCE(last_opened_at,created_at) DESC LIMIT 1').bind(owner).first();
  if(door)return {type:'door',id:door.id};
  const sequence=await db.prepare('SELECT s.id FROM sequences s WHERE s.owner_id=? AND EXISTS(SELECT 1 FROM sequence_steps ss JOIN readers r ON r.id=ss.reader_id AND r.owner_id=s.owner_id WHERE ss.sequence_id=s.id) ORDER BY s.updated_at DESC LIMIT 1').bind(owner).first();
  return sequence?{type:'sequence',id:sequence.id}:null;
}
