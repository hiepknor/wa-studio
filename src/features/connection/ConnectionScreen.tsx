import { FormEvent, useState } from "react";

import {
  probeRuntimeConnection,
  type RuntimeConnectionResult,
} from "@/shared/api/runtime-client";

type ConnectionState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; result: RuntimeConnectionResult }
  | { status: "failed"; message: string };

export function ConnectionScreen() {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:3100");
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<ConnectionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "checking" });

    try {
      const result = await probeRuntimeConnection({ baseUrl, apiKey });
      setState({ status: "connected", result });
    } catch (error) {
      setState({
        status: "failed",
        message: error instanceof Error ? error.message : "Connection failed.",
      });
    }
  }

  return (
    <main className="shell">
      <section className="intro" aria-labelledby="page-title">
        <span className="eyebrow">WA Studio</span>
        <h1 id="page-title">Connect to Automation Runtime</h1>
        <p>
          The desktop app talks only to the stable Runtime API. Gateway details and
          automation execution stay behind that boundary.
        </p>
      </section>

      <section className="card" aria-label="Runtime connection">
        <form onSubmit={handleSubmit}>
          <label htmlFor="runtime-url">Runtime URL</label>
          <input
            id="runtime-url"
            inputMode="url"
            onChange={(event) => setBaseUrl(event.currentTarget.value)}
            placeholder="https://runtime.example.com"
            required
            spellCheck={false}
            value={baseUrl}
          />

          <label htmlFor="runtime-key">Runtime API key</label>
          <input
            autoComplete="off"
            id="runtime-key"
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder="Enter the development key"
            required
            type="password"
            value={apiKey}
          />
          <small>The key is kept in memory only and is not persisted in this milestone.</small>

          <button disabled={state.status === "checking"} type="submit">
            {state.status === "checking" ? "Checking…" : "Test connection"}
          </button>
        </form>

        <div className={`status status--${state.status}`} aria-live="polite">
          {state.status === "idle" && "Waiting for connection details."}
          {state.status === "checking" && "Checking readiness and credentials…"}
          {state.status === "failed" && state.message}
          {state.status === "connected" && (
            <>
              Connected. {state.result.readySessions} of {state.result.sessionCount} sessions ready.
            </>
          )}
        </div>
      </section>
    </main>
  );
}
