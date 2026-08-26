import { FormEvent, useState } from "react";

import {
  probeRuntimeConnection,
  type RuntimeConnectionInput,
  type RuntimeConnectionResult,
} from "@/shared/api/runtime-client";
import { Button } from "@/shared/ui/Button";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { TextField } from "@/shared/ui/TextField";
import { ConnectionShell } from "./ConnectionShell";

type ConnectionState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; result: RuntimeConnectionResult }
  | { status: "failed"; message: string };

interface ConnectionScreenProps {
  probeConnection?: (input: RuntimeConnectionInput) => Promise<RuntimeConnectionResult>;
}

export function ConnectionScreen({
  probeConnection = probeRuntimeConnection,
}: ConnectionScreenProps = {}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<ConnectionState>({ status: "idle" });
  const isChecking = state.status === "checking";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "checking" });

    try {
      const result = await probeConnection({ baseUrl, apiKey });
      setState({ status: "connected", result });
    } catch (error) {
      setState({
        status: "failed",
        message: error instanceof Error ? error.message : "Connection failed.",
      });
    }
  }

  return (
    <ConnectionShell
      buildLabel="Developer fallback"
      description="The bundled desktop supervisor is unavailable. Use this fallback only when developing against a separately managed Runtime."
      eyebrow="Developer mode"
      title="Attach an external Runtime"
      titleId="page-title"
      trustNote="The API key remains in memory and is never written to disk."
    >
      <form aria-label="WA Runtime connection" className="connection-form connection-setup-card" onSubmit={handleSubmit}>
        <header className="connection-section-label"><span>Runtime attachment</span><span className="connection-step-count">Manual</span></header>
        <div className="connection-card-heading">
          <h2>Connect to WA Runtime</h2>
          <p>Verify an external Runtime endpoint before opening the workspace.</p>
        </div>
        <div className="connection-fields">
          <TextField
            disabled={isChecking}
            icon="server"
            id="runtime-url"
            inputMode="url"
            label="External Runtime base URL"
            monospace
            onChange={(event) => setBaseUrl(event.currentTarget.value)}
            placeholder="http://127.0.0.1:34100"
            required
            spellCheck={false}
            type="url"
            value={baseUrl}
          />
          <TextField
            autoComplete="new-password"
            description="Stored for this process only. Never written to disk."
            disabled={isChecking}
            icon="key"
            id="runtime-key"
            label="External Runtime API key"
            monospace
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder="Enter the development key"
            required
            type="password"
            value={apiKey}
          />
        </div>
        {state.status === "idle" && <InlineAlert className="connection-status" indicator title="Waiting for developer credentials" tone="neutral">Managed desktop setup is not available in this mode.</InlineAlert>}
        {state.status === "checking" && <InlineAlert className="connection-status" indicator title="Attaching external Runtime" tone="warning">Verifying credentials and Runtime readiness…</InlineAlert>}
        {state.status === "failed" && <InlineAlert className="connection-status" indicator title="Connection failed">{state.message}</InlineAlert>}
        {state.status === "connected" && <InlineAlert className="connection-status" indicator title="External Runtime attached" tone="success">{state.result.readySessions} of {state.result.sessionCount} sessions ready.</InlineAlert>}
        <Button
          aria-label={isChecking ? "Attaching external Runtime" : "Attach external Runtime"}
          className="connection-submit-button"
          loading={isChecking}
          size="lg"
          type="submit"
          variant="primary"
        >
          {isChecking ? "Attaching…" : "Attach Runtime"}
        </Button>
        <p className="connection-setup-footnote">Use managed desktop setup for normal WA Studio operation.</p>
      </form>
    </ConnectionShell>
  );
}
