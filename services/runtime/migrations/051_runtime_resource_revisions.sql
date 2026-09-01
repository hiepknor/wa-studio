CREATE TABLE IF NOT EXISTS runtime_resource_revisions (
  session_id text NOT NULL,
  resource text NOT NULL CHECK (resource IN (
    'sessions', 'groups', 'groupLists', 'campaigns', 'runs', 'deliveries', 'activity'
  )),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, resource)
);

INSERT INTO runtime_resource_revisions (session_id, resource, revision)
SELECT sessions.id, resources.resource, 1
FROM gateway_sessions sessions
CROSS JOIN unnest(ARRAY[
  'sessions', 'groups', 'groupLists', 'campaigns', 'runs', 'deliveries', 'activity'
]::text[]) AS resources(resource)
ON CONFLICT (session_id, resource) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_runtime_resource_revision(
  target_session_id text,
  target_resource text
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO runtime_resource_revisions (session_id, resource, revision, updated_at)
  VALUES (target_session_id, target_resource, 1, now())
  ON CONFLICT (session_id, resource) DO UPDATE
  SET revision = runtime_resource_revisions.revision + 1,
      updated_at = now();
$$;

CREATE OR REPLACE FUNCTION bump_runtime_resource_from_direct_rows()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO runtime_resource_revisions (session_id, resource, revision, updated_at)
    SELECT DISTINCT rows.session_id, TG_ARGV[0], 1, now()
    FROM old_rows rows
    ON CONFLICT (session_id, resource) DO UPDATE
    SET revision = runtime_resource_revisions.revision + 1,
        updated_at = now();
  ELSE
    INSERT INTO runtime_resource_revisions (session_id, resource, revision, updated_at)
    SELECT DISTINCT rows.session_id, TG_ARGV[0], 1, now()
    FROM new_rows rows
    ON CONFLICT (session_id, resource) DO UPDATE
    SET revision = runtime_resource_revisions.revision + 1,
        updated_at = now();
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_runtime_sessions_from_rows()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO runtime_resource_revisions (session_id, resource, revision, updated_at)
    SELECT DISTINCT rows.id, 'sessions', 1, now()
    FROM old_rows rows
    ON CONFLICT (session_id, resource) DO UPDATE
    SET revision = runtime_resource_revisions.revision + 1,
        updated_at = now();
  ELSE
    INSERT INTO runtime_resource_revisions (session_id, resource, revision, updated_at)
    SELECT DISTINCT rows.id, 'sessions', 1, now()
    FROM new_rows rows
    ON CONFLICT (session_id, resource) DO UPDATE
    SET revision = runtime_resource_revisions.revision + 1,
        updated_at = now();
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_runtime_deliveries_from_rows()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO runtime_resource_revisions (session_id, resource, revision, updated_at)
    SELECT DISTINCT runs.session_id, 'deliveries', 1, now()
    FROM old_rows rows
    JOIN campaign_runs runs ON runs.id = rows.run_id
    ON CONFLICT (session_id, resource) DO UPDATE
    SET revision = runtime_resource_revisions.revision + 1,
        updated_at = now();
  ELSE
    INSERT INTO runtime_resource_revisions (session_id, resource, revision, updated_at)
    SELECT DISTINCT runs.session_id, 'deliveries', 1, now()
    FROM new_rows rows
    JOIN campaign_runs runs ON runs.id = rows.run_id
    ON CONFLICT (session_id, resource) DO UPDATE
    SET revision = runtime_resource_revisions.revision + 1,
        updated_at = now();
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS runtime_revision_gateway_sessions_insert ON gateway_sessions;
CREATE TRIGGER runtime_revision_gateway_sessions_insert
AFTER INSERT ON gateway_sessions REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_runtime_sessions_from_rows();
DROP TRIGGER IF EXISTS runtime_revision_gateway_sessions_update ON gateway_sessions;
CREATE TRIGGER runtime_revision_gateway_sessions_update
AFTER UPDATE ON gateway_sessions REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_runtime_sessions_from_rows();
DROP TRIGGER IF EXISTS runtime_revision_gateway_sessions_delete ON gateway_sessions;
CREATE TRIGGER runtime_revision_gateway_sessions_delete
AFTER DELETE ON gateway_sessions REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_runtime_sessions_from_rows();

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('gateway_groups', 'groups'),
    ('group_members', 'groups'),
    ('group_lists', 'groupLists'),
    ('group_list_items', 'groupLists'),
    ('campaigns', 'campaigns'),
    ('campaign_targets', 'campaigns'),
    ('campaign_runs', 'runs'),
    ('campaign_run_targets', 'runs'),
    ('activity_events', 'activity')
  ) AS resources(table_name, resource_name)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS runtime_revision_%s_insert ON %I', target.table_name, target.table_name);
    EXECUTE format(
      'CREATE TRIGGER runtime_revision_%s_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_runtime_resource_from_direct_rows(%L)',
      target.table_name, target.table_name, target.resource_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS runtime_revision_%s_update ON %I', target.table_name, target.table_name);
    EXECUTE format(
      'CREATE TRIGGER runtime_revision_%s_update AFTER UPDATE ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_runtime_resource_from_direct_rows(%L)',
      target.table_name, target.table_name, target.resource_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS runtime_revision_%s_delete ON %I', target.table_name, target.table_name);
    EXECUTE format(
      'CREATE TRIGGER runtime_revision_%s_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_runtime_resource_from_direct_rows(%L)',
      target.table_name, target.table_name, target.resource_name
    );
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS runtime_revision_campaign_deliveries_insert ON campaign_deliveries;
CREATE TRIGGER runtime_revision_campaign_deliveries_insert
AFTER INSERT ON campaign_deliveries REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_runtime_deliveries_from_rows();
DROP TRIGGER IF EXISTS runtime_revision_campaign_deliveries_update ON campaign_deliveries;
CREATE TRIGGER runtime_revision_campaign_deliveries_update
AFTER UPDATE ON campaign_deliveries REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_runtime_deliveries_from_rows();
DROP TRIGGER IF EXISTS runtime_revision_campaign_deliveries_delete ON campaign_deliveries;
CREATE TRIGGER runtime_revision_campaign_deliveries_delete
AFTER DELETE ON campaign_deliveries REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_runtime_deliveries_from_rows();
