export const PASSAGE_COOLDOWN_MS=1_000;
export const ACQUIRE_PASSAGE_COOLDOWN=`
INSERT INTO passage_cooldowns(owner_id,reader_id,last_attempt_ms)
VALUES(?,?,?)
ON CONFLICT(owner_id,reader_id) DO UPDATE SET
 last_attempt_ms=excluded.last_attempt_ms
WHERE excluded.last_attempt_ms-passage_cooldowns.last_attempt_ms>=?
RETURNING last_attempt_ms`;

export async function acquirePassageCooldown({db,owner,readerId,now,cooldownMs=PASSAGE_COOLDOWN_MS}){
  const acquired=await db.prepare(ACQUIRE_PASSAGE_COOLDOWN).bind(owner,readerId,now,cooldownMs).first();
  return acquired!==null;
}
