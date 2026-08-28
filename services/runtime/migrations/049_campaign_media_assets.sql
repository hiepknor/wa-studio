DO $$ BEGIN
  CREATE TYPE media_asset_kind AS ENUM ('IMAGE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE media_upload_status AS ENUM ('UPLOADING', 'COMPLETED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE RESTRICT,
  kind media_asset_kind NOT NULL,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 127),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, session_id),
  CHECK (kind = 'IMAGE' AND mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CHECK (octet_length(content) = byte_size)
);

CREATE INDEX IF NOT EXISTS idx_media_assets_session_created
  ON media_assets (session_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS media_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE RESTRICT,
  kind media_asset_kind NOT NULL,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  declared_mime_type text NOT NULL CHECK (char_length(declared_mime_type) BETWEEN 1 AND 127),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  chunk_size integer NOT NULL CHECK (chunk_size BETWEEN 65536 AND 786432),
  status media_upload_status NOT NULL DEFAULT 'UPLOADING',
  create_idempotency_key uuid NOT NULL UNIQUE,
  create_request_hash text NOT NULL CHECK (create_request_hash ~ '^[0-9a-f]{64}$'),
  completed_asset_id uuid UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'IMAGE' AND declared_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CHECK ((status = 'COMPLETED') = (completed_asset_id IS NOT NULL)),
  FOREIGN KEY (completed_asset_id, session_id)
    REFERENCES media_assets(id, session_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_media_uploads_expiry
  ON media_uploads (expires_at, id)
  WHERE status = 'UPLOADING';

CREATE TABLE IF NOT EXISTS media_upload_chunks (
  upload_id uuid NOT NULL REFERENCES media_uploads(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 786432),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_index),
  CHECK (octet_length(content) = byte_size)
);

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS media_asset_id uuid;

ALTER TABLE campaign_runs
  ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_asset_id uuid;

ALTER TABLE message_jobs
  ADD COLUMN IF NOT EXISTS media_asset_id uuid;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_media_asset_session_fkey
  FOREIGN KEY (media_asset_id, session_id)
  REFERENCES media_assets(id, session_id) ON DELETE RESTRICT;

ALTER TABLE campaign_runs
  ADD CONSTRAINT campaign_runs_media_asset_session_fkey
  FOREIGN KEY (media_asset_id, session_id)
  REFERENCES media_assets(id, session_id) ON DELETE RESTRICT;

ALTER TABLE message_jobs
  ADD CONSTRAINT message_jobs_media_asset_session_fkey
  FOREIGN KEY (media_asset_id, session_id)
  REFERENCES media_assets(id, session_id) ON DELETE RESTRICT;

UPDATE campaigns
SET payload = jsonb_set(payload, '{type}', '"TEXT"'::jsonb, true)
WHERE message_type = 'text' AND payload->>'type' IS NULL;

UPDATE campaign_runs
SET payload_snapshot = jsonb_set(payload_snapshot, '{type}', '"TEXT"'::jsonb, true)
WHERE message_type = 'text' AND payload_snapshot->>'type' IS NULL;

UPDATE message_jobs
SET payload = jsonb_set(payload, '{type}', '"TEXT"'::jsonb, true)
WHERE message_type = 'text' AND payload->>'type' IS NULL;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'campaigns'::regclass
      AND contype = 'c'
      AND (pg_get_constraintdef(oid) ILIKE '%message_type%'
        OR pg_get_constraintdef(oid) ILIKE '%payload%')
  LOOP
    EXECUTE format('ALTER TABLE campaigns DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'campaign_runs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%payload_snapshot%'
  LOOP
    EXECUTE format('ALTER TABLE campaign_runs DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_message_content_check CHECK (
    jsonb_typeof(payload) = 'object'
    AND message_type IN ('text', 'image')
    AND (
      (message_type = 'text'
        AND media_asset_id IS NULL
        AND jsonb_typeof(payload->'type') = 'string'
        AND payload->>'type' = 'TEXT'
        AND jsonb_typeof(payload->'text') = 'string'
        AND char_length(payload->>'text') BETWEEN 1 AND 4096)
      OR
      (message_type = 'image'
        AND jsonb_typeof(payload->'type') = 'string'
        AND payload->>'type' = upper(message_type)
        AND (
          (deleted_at IS NULL
            AND media_asset_id IS NOT NULL
            AND payload->>'mediaAssetId' = media_asset_id::text)
          OR
          (deleted_at IS NOT NULL AND media_asset_id IS NULL)
        )
        AND jsonb_typeof(payload->'caption') = 'string'
        AND char_length(payload->>'caption') <= 1024
        AND jsonb_typeof(payload->'filename') = 'string'
        AND jsonb_typeof(payload->'mimeType') = 'string'
        AND jsonb_typeof(payload->'byteSize') = 'number'
        AND jsonb_typeof(payload->'sha256') = 'string')
    )
  );

ALTER TABLE campaign_runs
  ADD CONSTRAINT campaign_runs_message_content_check CHECK (
    jsonb_typeof(payload_snapshot) = 'object'
    AND message_type IN ('text', 'image')
    AND (
      (message_type = 'text'
        AND media_asset_id IS NULL
        AND jsonb_typeof(payload_snapshot->'type') = 'string'
        AND payload_snapshot->>'type' = 'TEXT'
        AND jsonb_typeof(payload_snapshot->'text') = 'string')
      OR
      (message_type = 'image'
        AND media_asset_id IS NOT NULL
        AND jsonb_typeof(payload_snapshot->'type') = 'string'
        AND payload_snapshot->>'type' = upper(message_type)
        AND payload_snapshot->>'mediaAssetId' = media_asset_id::text)
    )
  );

ALTER TABLE message_jobs
  ADD CONSTRAINT message_jobs_message_content_check CHECK (
    jsonb_typeof(payload) = 'object'
    AND message_type IN ('text', 'image')
    AND (
      (message_type = 'text'
        AND media_asset_id IS NULL
        AND jsonb_typeof(payload->'type') = 'string'
        AND payload->>'type' = 'TEXT'
        AND jsonb_typeof(payload->'text') = 'string')
      OR
      (message_type = 'image'
        AND media_asset_id IS NOT NULL
        AND jsonb_typeof(payload->'type') = 'string'
        AND payload->>'type' = upper(message_type)
        AND payload->>'mediaAssetId' = media_asset_id::text)
    )
  );

CREATE INDEX IF NOT EXISTS idx_campaigns_media_asset
  ON campaigns (media_asset_id) WHERE media_asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_runs_media_asset
  ON campaign_runs (media_asset_id) WHERE media_asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_jobs_media_asset
  ON message_jobs (media_asset_id) WHERE media_asset_id IS NOT NULL;
