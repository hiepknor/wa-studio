CREATE TYPE openwa_message_transport_state AS ENUM (
  'DISPATCH_STARTED',
  'INGRESS_ACCEPTED',
  'SEND_STARTED',
  'SEND_ACCEPTED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED_DEFINITIVE',
  'INDETERMINATE'
);

ALTER TABLE message_attempts
  ADD COLUMN attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN command_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN transport_state openwa_message_transport_state,
  ADD COLUMN binding_generation bigint CHECK (binding_generation > 0),
  ADD COLUMN safety_permit_token uuid,
  ADD COLUMN safety_upstream_id text CHECK (safety_upstream_id ~ '^[0-9a-f]{64}$'),
  ADD COLUMN safety_policy_profile text CHECK (safety_policy_profile IN ('CANARY', 'STANDARD')),
  ADD COLUMN payload_sha256 text CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN command_body bytea,
  ADD COLUMN command_expires_at timestamptz,
  ADD COLUMN ingress_delivery_attempts integer NOT NULL DEFAULT 0
    CHECK (ingress_delivery_attempts >= 0),
  ADD COLUMN ingress_next_attempt_at timestamptz,
  ADD COLUMN ingress_lease_id uuid,
  ADD COLUMN ingress_lease_expires_at timestamptz,
  ADD COLUMN ingress_last_error text,
  ADD COLUMN ingress_last_failure_kind text CHECK (ingress_last_failure_kind IN (
    'DEFINITIVE', 'RATE_LIMITED_SAFE', 'AMBIGUOUS_RETRYABLE'
  )),
  ADD COLUMN ingress_accepted_at timestamptz,
  ADD COLUMN transport_started_at timestamptz,
  ADD COLUMN transport_accepted_at timestamptz,
  ADD COLUMN last_evidence_sequence bigint NOT NULL DEFAULT 0 CHECK (last_evidence_sequence >= 0),
  ADD COLUMN last_evidence_at timestamptz,
  ADD COLUMN openwa_message_id text;

UPDATE message_attempts SET
  transport_state = CASE outcome
    WHEN 'PROCESSING' THEN 'INDETERMINATE'::openwa_message_transport_state
    WHEN 'RETRY' THEN 'FAILED_DEFINITIVE'::openwa_message_transport_state
    WHEN 'ACCEPTED' THEN 'SEND_ACCEPTED'::openwa_message_transport_state
    WHEN 'SENT' THEN 'SENT'::openwa_message_transport_state
    WHEN 'DELIVERED' THEN 'DELIVERED'::openwa_message_transport_state
    WHEN 'READ' THEN 'READ'::openwa_message_transport_state
    WHEN 'FAILED' THEN 'FAILED_DEFINITIVE'::openwa_message_transport_state
    WHEN 'UNKNOWN' THEN 'INDETERMINATE'::openwa_message_transport_state
    ELSE NULL
  END,
  transport_started_at = upstream_started_at
WHERE transport_state IS NULL;

ALTER TABLE message_attempts
  ADD CONSTRAINT message_attempts_attempt_id_unique UNIQUE (attempt_id),
  ADD CONSTRAINT message_attempts_command_id_unique UNIQUE (command_id),
  ADD CONSTRAINT message_attempts_command_payload_complete CHECK (
    (command_body IS NULL AND command_expires_at IS NULL AND payload_sha256 IS NULL
      AND safety_permit_token IS NULL AND safety_upstream_id IS NULL
      AND safety_policy_profile IS NULL)
    OR (command_body IS NOT NULL AND command_expires_at IS NOT NULL AND payload_sha256 IS NOT NULL
      AND safety_permit_token IS NOT NULL AND safety_upstream_id IS NOT NULL
      AND safety_policy_profile IS NOT NULL)
  ),
  ADD CONSTRAINT message_attempts_ingress_lease_complete CHECK (
    (ingress_lease_id IS NULL AND ingress_lease_expires_at IS NULL)
    OR (ingress_lease_id IS NOT NULL AND ingress_lease_expires_at IS NOT NULL)
  );

CREATE INDEX message_attempts_command_idx
  ON message_attempts (command_id, attempt_number DESC);
CREATE INDEX message_attempts_connector_dispatch_idx
  ON message_attempts (ingress_next_attempt_at, command_expires_at, attempt_id)
  WHERE command_body IS NOT NULL
    AND transport_state = 'DISPATCH_STARTED'
    AND ingress_lease_id IS NULL;

CREATE TABLE message_delivery_evidence (
  event_id uuid PRIMARY KEY,
  command_id uuid NOT NULL,
  attempt_id uuid NOT NULL REFERENCES message_attempts(attempt_id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  kind text NOT NULL CHECK (kind IN (
    'COMMAND_RECEIVED',
    'SEND_STARTED',
    'SEND_ACCEPTED',
    'SEND_REJECTED',
    'SEND_INDETERMINATE',
    'ACK_SENT',
    'ACK_DELIVERED',
    'ACK_READ',
    'ACK_FAILED'
  )),
  openwa_message_id text,
  delivery_status text NOT NULL CHECK (delivery_status IN (
    'PENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'INDETERMINATE'
  )),
  error_class text,
  error_code text,
  binding_generation bigint NOT NULL CHECK (binding_generation > 0),
  plugin_version text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  record_hash bytea NOT NULL,
  projection_state text NOT NULL CHECK (projection_state IN ('APPLIED', 'IGNORED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, sequence),
  FOREIGN KEY (command_id) REFERENCES message_attempts(command_id) ON DELETE CASCADE
);

CREATE INDEX message_delivery_evidence_command_occurred_idx
  ON message_delivery_evidence (command_id, occurred_at, event_id);
