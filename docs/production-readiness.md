# WA Studio production readiness

This is the acceptance record for the first durable WA Studio deployment. A checked box requires a
command result, screenshot, alert event, immutable digest, or operator acknowledgement retained in
the private release record. Repository CI alone is not production acceptance.

## External prerequisites

- [ ] GitHub `main` requires a pull request with current CI and CodeQL results and blocks
      force-push/deletion. The single-maintainer repository does not require a manual approval;
      branch protection and required checks still apply to administrators.
- [ ] The protected `release` environment contains only the Apple signing, notarization, and updater
      secrets required by the signed desktop job. Tag, workflow and artifact verification gates are
      the release authorization boundary for the single-maintainer repository.
- [ ] The Cloudflare R2 bucket exists with a bucket-scoped Object Read & Write token, 35-day lock on
      `production/`, 90-day production expiry, and one-day staging expiry.
- [ ] The dedicated Telegram bot and private operator chat exist; token and chat ID are installed as
      mode-0400 files, and one synthetic firing/resolved pair has arrived.
- [ ] The age private identity and current Event Inbox master secret are escrowed in separate
      locations from the VPS and R2 credentials.

## Pre-production callback incident

The 58 failed callbacks observed on 2026-08-21 are an immutable pre-production incident slice, not
accepted production loss and not the total OpenWA failure ledger. Preserve that slice separately
from any failures recorded before or after it. Before the canary clock starts:

- [ ] Record the exact UTC interval, OpenWA session scope, aggregate failure classes, and source
      counters without copying message payloads or API keys into the release record.
- [ ] Explain all 58 outcomes as rejected test traffic, recovered/idempotent delivery, or a fixed
      defect. Any unclassified callback blocks go-live.
- [ ] Record the current cumulative OpenWA failure-ledger count and classify every delta outside the
      58-event slice. A stable historical slice must never be mistaken for the current source total.
- [ ] Prove production does not depend on OpenWA's terminal webhook-failure ledger for command or
      delivery recovery. The pinned 0.23.3 release closes queued outbox rows before delivery and does
      not redrive its terminal failure ledger, so unattended operation requires the attested WA Studio
      Connector: its durable journal must survive process restart, Event Inbox must retain evidence
      until local ACK, and a command that crossed `SEND_STARTED` must never be automatically resent.
      Any direct Runtime-to-OpenWA live-send fallback or unexplained connector-journal gap is a no-go.
- [ ] Run a full authoritative OpenWA sync, allow Runtime projections to settle, and compare group,
      participant, and retained Activity totals against the authoritative server.
- [ ] Confirm the Event Inbox has no unowned session, unexpected dead event, aged pending event, or
      unexplained delivery gap after the sync.
- [ ] Close the incident with explicit operator acknowledgement; retain the original count and
      evidence rather than deleting it.

## Canary UAT and 24-hour gate

- [ ] Install the notarized 0.2.0 canary DMG and connect through production discovery protocol v2.
- [ ] If the Mac has a legacy schema-2 profile, save the connection again and confirm it migrates to
      connector schema 3; live sends must remain effectively disabled until that migration and its
      heartbeat quorum complete.
- [ ] Verify the installed WA Studio Connector ZIP digest and provenance against the same release;
      confirm exactly one enabled, session-scoped connector instance and no foreign disabled instance;
      confirm base lifecycle, session and ingress config resolve to the same connector identity, plus
      the expected protocol/journal versions, current credential generation, current binding
      generation, and a healthy heartbeat.
- [ ] Run `npm run openwa:connector:verify -- --managed-profile` on the canary Mac and retain only its
      secret-free JSON result with the release evidence.
- [ ] Create a backup before UAT; verify R2 readback checksum and complete an isolated restore drill.
- [ ] Confirm the selected session reports OpenWA Safety policy version 5, effective state `READY`,
      profile `CANARY`, no unexpired recovery lease, and zero unexplained unknown Message Jobs.
- [ ] Synchronize sessions, groups, group lists, participants, Runs, Activity, and Settings; reopen the
      app and verify persisted state after a managed Runtime restart.
- [ ] Disconnect the desktop, generate a test callback, reconnect, and verify exactly-once drain from
      Event Inbox into local Runtime with a complete Activity trail.
- [ ] Restart the OpenWA connector after `COMMAND_ACCEPTED` but before `SEND_STARTED`; verify the
      journal resumes the command once. Repeat after `SEND_STARTED`; verify the result becomes
      evidence-backed terminal or `INDETERMINATE` and no automatic resend occurs.
- [ ] Run exactly one outbound campaign to the dedicated test group after confirming the target
      snapshot and recipient count. Verify terminal outcomes and reconcile them with OpenWA. Keep
      `CANARY`; do not promote to `STANDARD` during the acceptance window.
- [ ] Exercise durable safety block/resume between permit reservation and upstream dispatch, then
      verify the final send fence prevents a new OpenWA request and leaves an Activity trail.
- [ ] Exercise an isolated OpenWA `429` in staging and verify scope-wide throttling, cooldown,
      single-probe recovery, durable deferral, and gradual recovery without a blind message retry.
- [ ] Exercise pairing revoke/reconnect and verify the retired device token cannot reclaim a session.
- [ ] Disconnect an isolated canary workspace and verify the ingress and session override are gone,
      the plugin is disabled, and its merge-only base configuration contains the retired tombstone
      rather than the prior connector credential.
- [ ] Verify public liveness and discovery, private readiness/metrics, TLS expiry, disk alerts, backup
      freshness, restore freshness, and Telegram firing/resolved delivery. Retain synthetic firing and
      resolution evidence for Event Inbox webhook-admission loss, Runtime `UNKNOWN` Message Jobs, an
      open safety circuit, persistent throttling, stalled recovery, and a non-draining deferred queue.
- [ ] Observe the unchanged candidate digest for 24 continuous hours with no critical alert,
      new OpenWA terminal webhook failure, unexplained callback loss, duplicate outbound effect,
      `UNKNOWN` delivery, recurring OpenWA cooldown, safety metric snapshot failure, or storage
      pressure.

## Go/no-go record

Retain the attested `wa-studio-deployment.json` as the authoritative candidate identity. Record its
digest, desktop checksums, connector/binding generations, canary start/end UTC, R2 backup key/checksum,
restore-drill result, UAT run ID, test-group ID, alert test timestamps, operator acknowledgement, and
the final go/no-go decision. Store identifiers only in the private release record; never add customer
or credential data to Git.

A no-go means: route Event Inbox back to 34200, stop outbound activity, preserve evidence, and
fix-forward. A go means: prepare the reviewed 0.2.1 stable bump, converge the primary slot, verify the
signed updater from both supported predecessor builds, and keep the canary evidence for audit.
