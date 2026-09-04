-- Keep a bounded, aggregate-only observation ledger for the desktop-managed
-- production acceptance window. The ledger intentionally contains no session,
-- group, message, webhook payload, or credential identifiers.
CREATE TABLE runtime_operational_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observed_at timestamptz NOT NULL,
  runtime_version text NOT NULL,
  runtime_profile text NOT NULL CHECK (runtime_profile IN ('server', 'desktop-managed')),
  managed_instance_id text NOT NULL,
  studio_version text NOT NULL,
  openwa_release_tag text NOT NULL,
  live_sends_enabled boolean NOT NULL,
  gate_clean boolean NOT NULL,
  violation_codes text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  CHECK (gate_clean = (cardinality(violation_codes) = 0))
);

CREATE INDEX runtime_operational_observations_identity_time_idx
  ON runtime_operational_observations (
    runtime_version,
    runtime_profile,
    managed_instance_id,
    studio_version,
    openwa_release_tag,
    observed_at
  );
