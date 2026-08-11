import { FormEvent, useState } from "react";

import {
  probeRuntimeConnection,
  type RuntimeConnectionResult,
} from "@/shared/api/runtime-client";
import { BrandMark } from "@/shared/ui/BrandMark";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";

type ConnectionState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; result: RuntimeConnectionResult }
  | { status: "failed"; message: string };

interface ConnectionScreenProps {
  probeConnection?: typeof probeRuntimeConnection;
}

export function ConnectionScreen({
  probeConnection = probeRuntimeConnection,
}: ConnectionScreenProps = {}) {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:3100");
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
        <span className="connection-build">desktop / runtime gateway</span>
      </header>

      <div className="connection-stage">
        <section className="intro connection-intro" aria-labelledby="page-title">
          <span className="eyebrow">Secure runtime access</span>
          <h1 id="page-title">Connect to <span>Automation Runtime</span></h1>
          <p>
            Attach this workspace to the service that owns Gateway sessions and
            automation execution.
          </p>

          <dl className="connection-specs">
            <div><dt>Protocol</dt><dd>Runtime API v1</dd></div>
            <div><dt>Transport</dt><dd>HTTPS / localhost</dd></div>
            <div><dt>Credentials</dt><dd>Memory only</dd></div>
          </dl>
        </section>

        <form className="connection-form" onSubmit={handleSubmit}>
          <article aria-label="Runtime connection" className="connection-card">
            <header className="connection-terminal-bar">
              <span className="connection-window-dots" aria-hidden="true">
                <i /><i /><i />
              </span>
              <span>runtime.connect</span>
              <span className="connection-terminal-state">local</span>
            </header>

            <div className="card-content stack stack-md">
              <div className="connection-command" aria-hidden="true">
                <span>~</span> wa runtime attach
              </div>

              <div className="field connection-field">
                <label htmlFor="runtime-url">Runtime URL</label>
                <div className="connection-input-wrap">
                  <AppIcon className="connection-input-icon" name="server" size="sm" />
                  <input
                    disabled={isChecking}
                    id="runtime-url"
                    inputMode="url"
                    onChange={(event) => setBaseUrl(event.currentTarget.value)}
                    placeholder="https://runtime.example.com"
                    required
                    spellCheck={false}
                    type="url"
                    value={baseUrl}
                  />
                </div>
              </div>

              <div className="field connection-field">
                <label htmlFor="runtime-key">Runtime API key</label>
                <div className="connection-input-wrap">
                  <AppIcon className="connection-input-icon" name="key" size="sm" />
                  <input
                    aria-describedby="runtime-key-description"
                    autoComplete="new-password"
                    disabled={isChecking}
                    id="runtime-key"
                    onChange={(event) => setApiKey(event.currentTarget.value)}
                    placeholder="Enter the development key"
                    required
                    type="password"
                    value={apiKey}
                  />
                </div>
                <span className="field-description" id="runtime-key-description">
                  Stored for this process only. Never written to disk.
                </span>
              </div>

              {state.status === "idle" && (
                <div className="connection-status" role="status">
                  <span className="connection-status-dot" />
                  <strong>Waiting for credentials</strong>
                  <span className="connection-alert-copy">No active Runtime session</span>
                </div>
              )}
              {state.status === "checking" && (
                <div className="connection-status connection-status-checking" role="status">
                  <span className="connection-status-dot" />
                  <strong>Checking connection</strong>
                  <span className="connection-alert-copy">Verifying Runtime readiness…</span>
                </div>
              )}
              {state.status === "failed" && (
                <div className="connection-status connection-status-danger" role="alert">
                  <span className="connection-status-dot" />
                  <strong>Connection failed</strong>
                  <span className="connection-alert-copy">{state.message}</span>
                </div>
              )}
              {state.status === "connected" && (
                <div className="connection-status connection-status-ok" role="status">
                  <span className="connection-status-dot" />
                  <strong>Runtime connected</strong>
                  <span className="connection-alert-copy">
                    {state.result.readySessions} of {state.result.sessionCount} sessions ready.
                  </span>
                </div>
              )}
            </div>

            <footer className="card-footer">
              <span className="connection-shortcut" aria-hidden="true">↵ enter</span>
              <Button
                aria-label={isChecking ? "Checking Runtime connection" : "Test connection"}
                className="connection-submit-button"
                loading={isChecking}
                size="lg"
                type="submit"
                variant="primary"
              >
                Test connection
              </Button>
            </footer>
          </article>
        </form>
      </div>

      <footer className="connection-footer">
        <span><i /> runtime bridge</span>
        <span>credentials remain on device</span>
      </footer>
    </main>
  );
}
