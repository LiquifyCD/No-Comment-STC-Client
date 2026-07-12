export const CONFIGURED_READER_UPSERT = `
INSERT INTO readers(id,owner_id,name,name_key,card_reader,created_at,last_opened_at,config_ciphertext)
VALUES(?,?,?,?,0,?,?,?)
ON CONFLICT(owner_id,name_key) DO UPDATE SET
 name=excluded.name,
 card_reader=0,
 last_opened_at=excluded.last_opened_at,
 config_ciphertext=excluded.config_ciphertext
WHERE readers.config_ciphertext IS NULL
RETURNING id`;

export async function saveConfiguredReader({db,id,owner,name,nameKey,now,ciphertext}) {
  const saved=await db.prepare(CONFIGURED_READER_UPSERT).bind(id,owner,name,nameKey,now,now,ciphertext).first();
  return typeof saved?.id==='string'?saved.id:null;
}
