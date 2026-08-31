# WA Studio Connector for OpenWA

This installable OpenWA plugin is the execution adapter between WA Runtime and OpenWA. WA Runtime
remains the sole safety and rate-limit authority. The plugin never creates campaigns, chooses targets,
or retries a send after the `SEND_STARTED` ambiguity boundary.

## Installation contract

1. Package the plugin with `npm -w @wa/openwa-connector-plugin run package`.
2. Install the generated ZIP from OpenWA **Plugins**.
3. Create an ingress instance with route `commands` and a secret matching
   `OPENWA_CONNECTOR_INGRESS_SECRET` in WA Runtime.
4. Provision a connector credential from the Event Inbox control plane, then configure its origin,
   connector token, and bound OpenWA session UUID. The token embeds the immutable connector identity;
   do not reuse the plugin instance with a token provisioned for another connector.
5. Enable the plugin and wait for WA Studio to report a healthy connector quorum before live sends.

The connector is tested against OpenWA 0.23.3. Upgrade OpenWA only after the compatibility and crash
matrix in the repository passes against the new tag.
