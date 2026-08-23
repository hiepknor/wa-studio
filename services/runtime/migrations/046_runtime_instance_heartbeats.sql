SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE runtime_process_heartbeats
  ADD COLUMN instance_id text NOT NULL DEFAULT 'legacy';

ALTER TABLE runtime_process_heartbeats
  DROP CONSTRAINT runtime_process_heartbeats_pkey;

ALTER TABLE runtime_process_heartbeats
  ADD CONSTRAINT runtime_process_heartbeats_pkey PRIMARY KEY (instance_id, process_name);

ALTER TABLE runtime_process_heartbeats
  ADD CONSTRAINT runtime_process_heartbeats_instance_id_check
  CHECK (instance_id <> '' AND length(instance_id) <= 128);

CREATE INDEX idx_runtime_process_heartbeats_expiry
  ON runtime_process_heartbeats (heartbeat_at);
