# Post-deployment system model

## Topology

```mermaid
flowchart LR
  subgraph Mac["Operator Mac · trusted boundary"]
    Studio["WA Studio · Tauri UI"]
    Native["Native supervisor<br/>discovery + pairing + local secret file"]
    Runtime["WA Runtime<br/>API · worker · scheduler"]
    LocalDb[("Managed PostgreSQL<br/>business state + durable queue")]
    Studio <-->|"loopback only"| Runtime
    Studio --> Native
    Native --> Runtime
    Runtime <--> LocalDb
  end

  subgraph VPS["VPS · public ingress boundary"]
    Caddy["Caddy / Cloudflare edge<br/>TLS + exact routes"]
    OpenWA["OpenWA 0.22.0<br/>unchanged"]
    Inbox["WA Event Inbox<br/>pair · ingress · claim · ACK/NACK"]
    InboxDb[("Dedicated PostgreSQL<br/>transient bounded events")]
    Caddy --> OpenWA
    Caddy --> Inbox
    Inbox <--> InboxDb
  end

  Native -->|"GET /.well-known/wa-studio"| Caddy
  Native -->|"one-time pair with OpenWA credentials"| Inbox
  Inbox -->|"credential validation only; API key not stored"| OpenWA
  OpenWA -->|"signed webhook"| Inbox
  Runtime -->|"HTTPS claim / lease / receipt ACK-NACK"| Inbox
  Runtime -->|"supported OpenWA API"| OpenWA
```

Only Caddy exposes TCP 443. Runtime and managed PostgreSQL bind locally on the Mac. Event Inbox
PostgreSQL has no published port and no shared volume with OpenWA.

## Connect and startup

```mermaid
sequenceDiagram
  actor User
  participant Studio
  participant Native
  participant OpenWA
  participant Inbox as Event Inbox
  participant Runtime

  User->>Studio: OpenWA Base URL + API key
  Studio->>Native: provision
  Native->>OpenWA: health / release 0.22.0
  Native->>OpenWA: GET /.well-known/wa-studio
  Native->>Inbox: POST /event-inbox/pair
  Inbox->>OpenWA: validate API key + list sessions
  OpenWA-->>Inbox: authorized configured sessions
  Inbox-->>Native: device token + secret + callback + scope
Native->>Native: atomically store protected local schema-v2 secret file
  Native->>Runtime: start local API / worker / scheduler
  Runtime->>OpenWA: reconcile callback via supported API
```

React never receives the OpenWA key, Runtime key, webhook secret or device token. A v1 local secret
record is treated as absent rather than migrated or used as fallback.

## Durable callback delivery

```mermaid
sequenceDiagram
  participant OpenWA
  participant Inbox as Event Inbox
  participant DB as Inbox PostgreSQL
  participant Runtime
  participant Local as Local PostgreSQL

  OpenWA->>Inbox: signed POST /webhooks/openwa
  Inbox->>Inbox: verify HMAC + session + payload bound
  Inbox->>DB: INSERT idempotently + capacity ledger
  Inbox-->>OpenWA: 201 accepted
  Runtime->>Inbox: POST /events/claim (device bearer)
  Inbox->>DB: fence rows with lease UUID + expiry
  Inbox-->>Runtime: raw bytes + signature + receipt
  Runtime->>Local: verify + commit local ingress + enqueue
  alt committed or duplicate
    Runtime->>Inbox: ACK receipt
    Inbox->>DB: DELETE only matching device + lease
  else transient local failure
    Runtime->>Inbox: NACK retry
    Inbox->>DB: release lease + bounded backoff
  else deterministic poison event
    Runtime->>Inbox: NACK dead
    Inbox->>DB: isolate until bounded expiry
  end
```

A crash before ACK leads to redelivery after lease expiry. A stale receipt cannot delete a row that
has been re-leased. Local idempotency collapses duplicates.

## Ownership and bounds

| State | Authority | Bound |
| --- | --- | --- |
| Campaigns, messages, projections, queues | Local Runtime PostgreSQL | Retention and encrypted desktop backups |
| WhatsApp sessions and gateway facts | OpenWA stores | OpenWA lifecycle |
| Uncommitted callback bytes | Event Inbox PostgreSQL | 100,000 events, 256 MiB, seven days |
| Device/OpenWA/Runtime secrets | App data directory | Schema v2; `0700` directory / `0600` file; never returned to React |
| Event Inbox logs | Docker JSON logs | 10 MiB × 3 files per container |

Event Inbox returns HTTP 503 when either event or byte capacity would be exceeded. Readiness exposes
stored, pending, leased, dead, oldest-pending and configured limit metrics.

## Failure behavior

| Failure | Automatic behavior | Operator action |
| --- | --- | --- |
| Mac sleeps or changes network | Event Inbox keeps signed callbacks | Reopen Studio before capacity or retention limits |
| Runtime crashes after local commit | Lease expires; duplicate collapses locally | None unless retries grow |
| Malformed callback | Runtime NACKs dead; later events continue | Inspect dead count without exposing payload |
| Event Inbox restart | PostgreSQL retains committed rows and leases | Consumer resumes |
| OpenWA unavailable during pairing | Pairing fails closed; local secret file is unchanged | Restore OpenWA, retry Connect |
| Master secret rotation | Existing device token/signature become invalid | Reconnect Studio and reconcile webhook |
| VPS disk pressure | hard row/byte/expiry/log/WAL bounds limit growth | Inspect exact owners; never broad-prune volumes |
