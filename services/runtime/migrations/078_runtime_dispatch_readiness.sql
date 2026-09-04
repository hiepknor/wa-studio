CREATE TABLE runtime_dispatch_readiness (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state text NOT NULL CHECK (state IN ('RECOVERING', 'READY', 'DEGRADED')),
  recovery_watermark bigint CHECK (recovery_watermark IS NULL OR recovery_watermark >= 0),
  reason text,
  recovery_started_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  heartbeat_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_dispatch_readiness_ready_fields_check CHECK (
    (state = 'READY' AND ready_at IS NOT NULL AND heartbeat_at IS NOT NULL AND reason IS NULL)
    OR (state <> 'READY' AND ready_at IS NULL AND heartbeat_at IS NULL)
  )
);

COMMENT ON TABLE runtime_dispatch_readiness IS
  'Database-backed outbound fence. READY means Event Inbox recovery reached its captured watermark and the consumer heartbeat is fresh.';
