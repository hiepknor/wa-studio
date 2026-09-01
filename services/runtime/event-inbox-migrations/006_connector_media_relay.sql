CREATE TABLE event_inbox_media_usage (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  stored_blobs bigint NOT NULL CHECK (stored_blobs >= 0),
  stored_bytes bigint NOT NULL CHECK (stored_bytes >= 0)
);
INSERT INTO event_inbox_media_usage (singleton, stored_blobs, stored_bytes)
VALUES (true, 0, 0);

CREATE TABLE event_inbox_media_blobs (
  blob_id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES event_inbox_devices(device_id) ON DELETE CASCADE,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, content_sha256),
  CONSTRAINT event_inbox_media_blob_size_matches CHECK (octet_length(content) = byte_size)
);
CREATE INDEX idx_event_inbox_media_blobs_device
  ON event_inbox_media_blobs (device_id, created_at, blob_id);

CREATE TABLE event_inbox_media_leases (
  attempt_id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES event_inbox_devices(device_id) ON DELETE CASCADE,
  token_generation bigint NOT NULL CHECK (token_generation > 0),
  session_id uuid NOT NULL REFERENCES event_inbox_session_owners(session_id) ON DELETE CASCADE,
  blob_id uuid NOT NULL REFERENCES event_inbox_media_blobs(blob_id) ON DELETE CASCADE,
  download_token_hash bytea NOT NULL CHECK (octet_length(download_token_hash) = 32),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz,
  access_count bigint NOT NULL DEFAULT 0 CHECK (access_count >= 0)
);
CREATE INDEX idx_event_inbox_media_leases_expiry
  ON event_inbox_media_leases (expires_at, attempt_id);
CREATE INDEX idx_event_inbox_media_leases_blob
  ON event_inbox_media_leases (blob_id, expires_at);

CREATE FUNCTION event_inbox_update_media_usage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE event_inbox_media_usage
    SET stored_blobs = stored_blobs + 1,
        stored_bytes = stored_bytes + NEW.byte_size
    WHERE singleton;
    RETURN NEW;
  END IF;
  UPDATE event_inbox_media_usage
  SET stored_blobs = GREATEST(0, stored_blobs - 1),
      stored_bytes = GREATEST(0, stored_bytes - OLD.byte_size)
  WHERE singleton;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_event_inbox_media_usage
AFTER INSERT OR DELETE ON event_inbox_media_blobs
FOR EACH ROW EXECUTE FUNCTION event_inbox_update_media_usage();

ALTER TABLE event_inbox_media_blobs SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 100
);
ALTER TABLE event_inbox_media_leases SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 100
);
