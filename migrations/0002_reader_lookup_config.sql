ALTER TABLE readers ADD COLUMN config_ciphertext TEXT;

CREATE INDEX IF NOT EXISTS readers_configured_idx
  ON readers (created_at DESC)
  WHERE config_ciphertext IS NOT NULL;
