UPDATE readers AS legacy
SET name = 'Main entrance', name_key = 'main entrance'
WHERE legacy.config_ciphertext IS NULL
  AND legacy.name_key IN ('standardläsare', 'standardreader')
  AND NOT EXISTS (
    SELECT 1 FROM readers AS current
    WHERE current.owner_id = legacy.owner_id
      AND current.name_key = 'main entrance'
      AND current.id <> legacy.id
  );
