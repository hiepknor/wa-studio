# WA Studio Connector for OpenWA

This installable OpenWA plugin is the execution adapter between WA Runtime and OpenWA. WA Runtime
remains the sole safety and rate-limit authority. The plugin never creates campaigns, chooses targets,
or retries a send after the `SEND_STARTED` ambiguity boundary.

## Installation contract

1. Package the plugin with `npm -w @wa/openwa-connector-plugin run package`.
2. Install the generated ZIP from OpenWA **Plugins**.
   Automated Studio provisioning requires an OpenWA API key with the `ADMIN` role and no API-key
   session restriction because OpenWA protects plugin and integration-instance administration as
   unscoped control-plane operations. The OpenWA deployment itself must contain exactly one visible
   session; connector protocol v1 rejects a multi-session result.
3. Provision a connector credential from the Event Inbox control plane. Write the same origin, token
   and session UUID to the plugin base config, its one managed-session override and the ingress
   instance config. OpenWA supplies only base config during `onEnable`; omitting that layer prevents
   the connector from starting, while omitting the instance layer lets scope reconciliation erase the
   session override.
4. Create exactly one `commands` ingress instance with a secret matching
   `OPENWA_CONNECTOR_INGRESS_SECRET` in WA Runtime. The token embeds an immutable connector identity;
   never reuse this plugin deployment for another connector or local workspace.
5. Activate only the bound session, enable the plugin and wait for WA Studio to observe a fresh
   heartbeat with matching connector, credential and binding generations before live sends.

WA Studio performs these steps transactionally enough to resume an interrupted provisioning intent,
rejects a foreign ingress before pairing, and reconciles every config layer during credential
rotation. On final disconnect it disables the plugin before replacing the merge-only base config with
a non-secret retired tombstone.

The connector is tested against OpenWA 0.23.3. Upgrade OpenWA only after the compatibility and crash
matrix in the repository passes against the new tag.
