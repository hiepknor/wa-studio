# WA Studio production readiness

This is the acceptance record for the first durable WA Studio deployment. A checked box requires a
command result, screenshot, alert event, immutable digest, or reviewer acknowledgement retained in
the private release record. Repository CI alone is not production acceptance.

## External prerequisites

- [ ] GitHub `main` requires CI and CodeQL, blocks force-push/deletion, dismisses stale approvals,
      and requires one independent reviewer.
- [ ] The protected `release` environment has the same independent reviewer and contains only the
      Apple signing, notarization, and updater secrets required by the signed desktop job.
- [ ] The Cloudflare R2 bucket exists with a bucket-scoped Object Read & Write token, 35-day lock on
      `production/`, 90-day production expiry, and one-day staging expiry.
- [ ] The dedicated Telegram bot and private operator chat exist; token and chat ID are installed as
      mode-0400 files, and one synthetic firing/resolved pair has arrived.
- [ ] The age private identity and current Event Inbox master secret are escrowed in separate
      locations from the VPS and R2 credentials.

## Pre-production callback incident

The 58 failed callbacks observed before go-live are a pre-production incident baseline, not accepted
production loss and not a counter to erase. Before the canary clock starts:

- [ ] Record the exact UTC interval, OpenWA session scope, aggregate failure classes, and source
      counters without copying message payloads or API keys into the release record.
- [ ] Explain all 58 outcomes as rejected test traffic, recovered/idempotent delivery, or a fixed
      defect. Any unclassified callback blocks go-live.
- [ ] Run a full authoritative OpenWA sync, allow Runtime projections to settle, and compare group,
      participant, and retained Activity totals against the authoritative server.
- [ ] Confirm the Event Inbox has no unowned session, unexpected dead event, aged pending event, or
      unexplained delivery gap after the sync.
- [ ] Close the incident with operator and independent reviewer acknowledgement; retain the original
      count and evidence rather than deleting it.

## Canary UAT and 24-hour gate

- [ ] Install the notarized 0.2.0 canary DMG and connect through production discovery protocol v2.
- [ ] Create a backup before UAT; verify R2 readback checksum and complete an isolated restore drill.
- [ ] Synchronize sessions, groups, group lists, participants, Runs, Activity, and Settings; reopen the
      app and verify persisted state after a managed Runtime restart.
- [ ] Disconnect the desktop, generate a test callback, reconnect, and verify exactly-once drain from
      Event Inbox into local Runtime with a complete Activity trail.
- [ ] Run exactly one outbound campaign to the dedicated test group after confirming the target
      snapshot and recipient count. Verify terminal outcomes and reconcile them with OpenWA.
- [ ] Exercise pairing revoke/reconnect and verify the retired device token cannot reclaim a session.
- [ ] Verify public liveness and discovery, private readiness/metrics, TLS expiry, disk alerts, backup
      freshness, restore freshness, and Telegram firing/resolved delivery.
- [ ] Observe the unchanged candidate digest for 24 continuous hours with no critical alert,
      unexplained callback loss, duplicate outbound effect, `UNKNOWN` delivery, or storage pressure.

## Go/no-go record

Record candidate commit, desktop checksums, Event Inbox digest, OpenWA reviewed tag, canary start/end
UTC, R2 backup key/checksum, restore-drill result, UAT run ID, test-group ID, alert test timestamps,
operator, independent reviewer, and the final go/no-go decision. Store identifiers only in the
private release record; never add customer or credential data to Git.

A no-go means: route Event Inbox back to 34200, stop outbound activity, preserve evidence, and
fix-forward. A go means: prepare the reviewed 0.2.1 stable bump, converge the primary slot, verify the
signed updater from both supported predecessor builds, and keep the canary evidence for audit.
