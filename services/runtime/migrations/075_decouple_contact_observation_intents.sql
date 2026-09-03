ALTER TABLE contact_message_observation_intents
  DROP CONSTRAINT IF EXISTS contact_message_observation_intents_event_id_fkey;

COMMENT ON COLUMN contact_message_observation_intents.event_id IS
  'Stable source event identity; intentionally independent from the compact runtime event ledger.';
