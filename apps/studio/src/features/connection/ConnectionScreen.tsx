import { FormEvent, useState } from "react";

import {
  probeRuntimeConnection,
  type RuntimeConnectionInput,
  type RuntimeConnectionResult,
} from "@/shared/api/runtime-client";
import { BrandMark } from "@/shared/ui/BrandMark";
import { Button } from "@/shared/ui/Button";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { TextField } from "@/shared/ui/TextField";

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
    <main className="shell connection-shell">
      <header className="connection-brand">
        <BrandMark />
        <strong>WA Studio</strong>
        <span className="connection-build">developer fallback</span>
      </header>

      <div className="connection-stage">
        <section className="intro connection-intro" aria-labelledby="page-title">
          <span className="eyebrow">Developer mode</span>
          <h1 id="page-title">Attach an external <span>Runtime</span></h1>
          <p>
            The bundled desktop supervisor is unavailable. Use this fallback only when developing
            against a separately managed Runtime.
          </p>

          <dl className="connection-specs">
            <div><dt>Protocol</dt><dd>WA Runtime API v1</dd></div>
            <div><dt>Mode</dt><dd>external / unmanaged</dd></div>
            <div><dt>Secrets</dt><dd>memory only</dd></div>
          </dl>
        </section>

        <form className="connection-form" onSubmit={handleSubmit}>
          <article aria-label="WA Runtime connection" className="connection-card">
            <header className="connection-terminal-bar">
              <span className="connection-window-dots" aria-hidden="true">
                <i /><i /><i />
              </span>
              <span>runtime.attach</span>
              <span className="connection-terminal-state">external</span>
            </header>

            <div className="card-content stack stack-md">
              <div className="connection-command" aria-hidden="true">
                <span>~</span> wa runtime attach
              </div>

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

              {state.status === "idle" && (
                <InlineAlert
                  className="connection-status"
                  indicator
                  title="Waiting for developer credentials"
                  tone="neutral"
                >
                  Managed desktop setup is not available in this mode.
                </InlineAlert>
              )}
              {state.status === "checking" && (
                <InlineAlert
                  className="connection-status"
                  indicator
                  title="Attaching external Runtime"
                  tone="warning"
                >
                  Verifying credentials and Runtime readiness…
                </InlineAlert>
              )}
              {state.status === "failed" && (
                <InlineAlert className="connection-status" indicator title="Connection failed">
                  {state.message}
                </InlineAlert>
              )}
              {state.status === "connected" && (
                <InlineAlert
                  className="connection-status"
                  indicator
                  title="External Runtime attached"
                  tone="success"
                >
                  {state.result.readySessions} of {state.result.sessionCount} sessions ready.
                </InlineAlert>
              )}
            </div>

            <footer className="card-footer">
              <span className="connection-shortcut" aria-hidden="true">↵ enter</span>
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
            </footer>
          </article>
        </form>
      </div>

      <footer className="connection-footer">
        <span><i /> developer fallback</span>
        <span>credentials remain in memory</span>
      </footer>
    </main>
  );
}
