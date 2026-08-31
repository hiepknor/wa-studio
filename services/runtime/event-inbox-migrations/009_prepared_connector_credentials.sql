ALTER TABLE event_inbox_connectors
  ADD COLUMN token_hash_version smallint NOT NULL DEFAULT 1
    CHECK (token_hash_version IN (1, 2));

COMMENT ON COLUMN event_inbox_connectors.token_hash_version IS
  '1 = server HMAC of legacy server-generated secret; 2 = SHA-256 verifier of a client-prepared secret';
