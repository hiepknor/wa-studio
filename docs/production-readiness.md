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
- [ ] `npm run release:environment:check` reports `ready` for the reviewed release channel; do not
      create a tag while any secret name, repository variable, or `v*` deployment policy is missing.
- [ ] Current dependency scans report no vulnerability, and every allowed transitive warning still
      matches the target-scoped disposition in `docs/dependency-risk-register.md`.
- [ ] A dedicated Ed25519 production-authorization private key is held only in the operator vault;
      its public PEM is stored as the protected GitHub Actions variable
      `PRODUCTION_ACCEPTANCE_PUBLIC_KEY_PEM`. It is not the updater, Apple, Connector, or backup key.
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

- [ ] Install the notarized 0.2.2 canary DMG and connect through production discovery protocol v2.
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
- [ ] Verify public liveness and discovery, authenticated Runtime readiness, Event Inbox private
      metrics, TLS expiry, disk alerts, backup freshness, restore freshness, and Telegram
      firing/resolved delivery. Retain synthetic firing and resolution evidence for Event Inbox
      webhook-admission loss, Runtime `UNKNOWN` Message Jobs, an open safety circuit, persistent
      throttling, stalled recovery, and a non-draining deferred queue.
- [ ] After the exact canary is installed, paired, and live sends are enabled, observe the unchanged
      candidate for 24 continuous hours with no scheduler observation gap over five minutes and no
      critical alert,
      new OpenWA terminal webhook failure, unexplained callback loss, duplicate outbound effect,
      `UNKNOWN` delivery, recurring OpenWA cooldown, safety metric snapshot failure, or storage
      pressure. Closing the app, changing WA Studio/Runtime/OpenWA identity, or exceeding the gap
      limit prevents release evidence from proving the window; do not substitute elapsed wall time.

## Go/no-go record

Retain the attested `wa-studio-server-deployment.json` as the authoritative server candidate identity
and the coordinated `wa-studio-deployment.json` once the desktop product is published. Record their
digest, desktop checksums, connector/binding generations, canary start/end UTC, R2 backup key/checksum,
restore-drill result, UAT run ID, test-group ID, alert test timestamps, operator acknowledgement, and
the final go/no-go decision. Store identifiers only in the private release record; never add customer
or credential data to Git.

Create the private, release-bound record before starting the canary. The command refuses to
overwrite an existing record and creates it without group or world permissions:

```bash
npm run release:acceptance:create -- \
  --deployment /private/release/wa-studio-deployment.json \
  --output /private/release/production-acceptance.json
```

The default criteria come from the reviewed
`release/production-acceptance-policy.json`. Its version and SHA-256 digest are embedded in the
attested coordinated deployment manifest and copied into the record. Changing the criteria,
substituting another policy file, or verifying from the wrong release checkout therefore fails
closed. A later release may version the policy without weakening or rewriting historical evidence.

At the end of the unchanged canary window, capture the live operational state before editing the
decision. `--managed-profile` reads the bound connector and Runtime credentials from the macOS
Keychain, runs the deployment verifier against OpenWA and Event Inbox, and probes Runtime's
public liveness plus authenticated readiness, operational health, and release evidence. Capture
fails unless exactly one allowed session is live-send enabled, Runtime and its workers are healthy,
OpenWA matches the pinned release, the connector is exclusively healthy and current, its journal is
drained, and storage stays below the Connector journal production-pressure threshold. The same
capture requires Runtime's bounded local ledger to prove 24 continuous hours for the exact WA
Studio, Runtime, OpenWA, and managed-instance identity, with no gap over five minutes and no
violating sample. It also fails closed when any outbound job is `UNKNOWN` or safety-deferred, a
safety scope is open, half-open, manually blocked, or throttled, any Runtime webhook is `DEAD`, callback processing
has stalled for more than five minutes, or the webhook spool cannot admit one maximum-sized event.

```bash
npm run release:operational:capture -- \
  --managed-profile \
  --deployment /private/release/wa-studio-deployment.json \
  --output /private/release/production-operational-snapshot.json

npm run release:operational:verify -- \
  --deployment /private/release/wa-studio-deployment.json \
  --snapshot /private/release/production-operational-snapshot.json
```

Managed capture is pinned to WA Runtime's loopback origin at `http://127.0.0.1:34100`; it will not
forward the Keychain API key to an alternate origin. The snapshot is an owner-only, secret-free
evidence file containing release identities, health states, connector generations, current aggregate
safety and callback-spool state, plus the candidate-bound 24-hour observation summary. The private
release-evidence endpoint exposes only aggregate counts and ages, is excluded from OpenAPI, and
requires the Runtime API credential.
The snapshot still belongs in the encrypted immutable evidence archive, never in Git. Attach it
atomically to the still-`PENDING` record; this
copies the verified connector generations and health timestamps and refuses a different snapshot,
pre-populated evidence, or an inconsistent repeat:

```bash
npm run release:acceptance:attach-operational -- \
  --deployment /private/release/wa-studio-deployment.json \
  --operational-snapshot /private/release/production-operational-snapshot.json \
  --record /private/release/production-acceptance.json
```

Run the Event Inbox restore drill with the exact attested coordinated manifest installed on the
VPS. Preserve the owner-only JSON path printed by the drill, transfer that file through the private
evidence channel, and verify then attach it while the acceptance record is still `PENDING`:

```bash
npm run release:recovery:verify -- \
  --deployment /private/release/wa-studio-deployment.json \
  --evidence /private/release/production-recovery-evidence.json

npm run release:acceptance:attach-recovery -- \
  --deployment /private/release/wa-studio-deployment.json \
  --recovery-evidence /private/release/production-recovery-evidence.json \
  --record /private/release/production-acceptance.json
```

The attachment derives the backup object, archive checksum, verification time, drill time, outcome,
and evidence digest from that closed-schema file. Do not type those fields manually. Reusing an
artifact from another release, changing it after attachment, restoring an older migration head, or
setting `restoreSucceeded` without the artifact all fail closed.

The operational snapshot does not inspect WA Studio's native managed PostgreSQL filesystem or local
recovery directory. Those paths and their storage policy are owned by the Tauri supervisor rather
than Runtime's HTTP surface. At the end of the unchanged canary, open **Settings → Backups &
recovery**, refresh the view, and select **Copy acceptance evidence**. Paste that exact secret-free
JSON object into the record's `managedStorage` section; the action preserves the native generation
timestamp and byte values rather than rounded display labels. Retain a screenshot of the same view
in the encrypted evidence archive. A `GO` requires all of the following:

- `verifiedAt` and the operational snapshot are captured within the final 15 minutes of the recorded
  canary interval;
- `pressure` is `normal` and `filesystemAvailableBytes` is at least 20 GiB;
- at least one recovery point exists, with both `recoveryFreshness` and `integrityFreshness` equal
  to `fresh`;
- `automaticRecoveryBytes` does not exceed `automaticRecoveryBudgetBytes`.

Do not substitute Connector `storageUtilization` for this evidence: that value describes the remote
event journal, not the desktop database or its recovery points. Missing, stale, rounded, or unsafe
managed-storage evidence makes `release:acceptance:verify-go` fail closed.

Fill the remaining record fields only from retained evidence. `release:acceptance:verify` requires
the edited file to remain owner-readable and inaccessible to group/world, validates the closed
schema, rejects secret-bearing fields, and proves that the release, connector artifact, Event Inbox
image, and coordinated deployment manifest still have the exact recorded identity:

```bash
npm run release:acceptance:verify -- \
  --deployment /private/release/wa-studio-deployment.json \
  --operational-snapshot /private/release/production-operational-snapshot.json \
  --recovery-evidence /private/release/production-recovery-evidence.json \
  --record /private/release/production-acceptance.json
```

Before a `GO`, store the supporting screenshots, command results, health snapshots, and alert events
as an encrypted immutable evidence archive. Put only its object key and SHA-256 digest in
`evidenceArchive`; do not put payloads, API keys, tokens, credentials, or customer data in the JSON.
Then run the fail-closed gate:

```bash
npm run release:acceptance:verify-go -- \
  --deployment /private/release/wa-studio-deployment.json \
  --operational-snapshot /private/release/production-operational-snapshot.json \
  --recovery-evidence /private/release/production-recovery-evidence.json \
  --record /private/release/production-acceptance.json
```

This gate requires the complete 58-callback incident classification, an unchanged 24-hour candidate,
zero critical/loss/duplicate/unknown/cooldown counters, current connector generations and health,
normal and fresh managed desktop storage evidence, successful off-device backup and restore,
terminal UAT results, every required resilience drill, reconciled Event Inbox/Runtime state, and an
explicit operator acknowledgement after the canary ends.
Every time-based UAT, drill, connector, backup, and health observation must fall inside the recorded
canary interval. The final operational snapshot, Connector verification, and managed-storage
diagnostics must also fall within the policy-bound final 15-minute evidence window. A structurally
valid `PENDING` or `NO_GO` record passes `verify` for preservation but
can never pass `verify-go`. Any record whose decision is already `GO` receives the full GO checks
even under the ordinary `verify` command, so selecting the weaker command cannot bypass the gate.

After `verify-go` succeeds for a published canary, create the sanitized receipt that authorizes one
specific newer stable tag. The command re-runs the full private GO verification and records only
release identities and SHA-256 commitments; it does not copy the operator, UAT target, Runtime
instance, or connector identifiers into Git:

Create the dedicated signing key once in the operator vault (or use the equivalent vault-backed
Ed25519 generation flow), export only its public half to the protected repository variable, and
retain both the public key and its printed key ID with the private release evidence:

```bash
umask 077
openssl genpkey -algorithm Ed25519 \
  -out /private/keys/wa-studio-production-authorization.pem
openssl pkey \
  -in /private/keys/wa-studio-production-authorization.pem \
  -pubout \
  -out /private/keys/wa-studio-production-authorization-public.pem
```

```bash
npm run release:promotion:create -- \
  --accepted-deployment /private/release/wa-studio-deployment.json \
  --operational-snapshot /private/release/production-operational-snapshot.json \
  --recovery-evidence /private/release/production-recovery-evidence.json \
  --acceptance-record /private/release/production-acceptance.json \
  --target-tag v<next-stable-version> \
  --signing-private-key /private/keys/wa-studio-production-authorization.pem \
  --output release/production-promotion.json
```

Review and commit `release/production-promotion.json` with the stable-only version/channel bump. The
receipt is a signed, domain-separated authorization over the exact target and every retained private
evidence digest, not a substitute for that evidence. The private key never enters GitHub Actions.
The release workflow requires the receipt only for `stable`, verifies its Ed25519 signature against
the protected public-key variable, checks its policy and exact target, downloads
the referenced published canary deployment manifest, verifies its GitHub attestation against the
recorded source commit, and compares every accepted release identity before publication. It also
requires the accepted tag to resolve to that commit, proves the stable commit descends from it, and
rejects every source delta except the coordinated Studio/Tauri version fields, release-channel field,
and new receipt. The gate executes the verifier from the accepted canary checkout, not from the stable
candidate being judged; version-bearing files may not hide semantic or file-mode changes. A `canary`
build fails if it carries a stale receipt, so remove the prior receipt when beginning the next canary
cycle. A missing key, wrong key, altered receipt, altered target, or unsigned legacy schema fails
closed. Rotate this key only through a new canary cycle, update the protected public-key variable
before its stable promotion, and archive the retired public key for historical verification.

A no-go means: route Event Inbox back to 34200, stop outbound activity, preserve evidence, and
fix-forward. A go means: prepare the reviewed 0.2.3 stable bump, converge the primary slot, verify the
signed updater from both supported predecessor builds, and keep the canary evidence for audit.
