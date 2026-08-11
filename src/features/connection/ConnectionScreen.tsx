import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Stack,
  TextField,
} from "@hiepknor/ink-react";
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
    <main className="shell">
      <section className="intro" aria-labelledby="page-title">
        <span className="eyebrow">WA Studio</span>
        <h1 id="page-title">Connect to Automation Runtime</h1>
        <p>
          The desktop app talks only to the stable Runtime API. Gateway details and
          automation execution stay behind that boundary.
        </p>
      </section>

      <form className="connection-form" onSubmit={handleSubmit}>
        <Card aria-label="Runtime connection">
          <CardHeader>
            <CardTitle>Runtime connection</CardTitle>
            <CardDescription>
              Verify service readiness and credentials before entering the workspace.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <Stack gap="md">
              <TextField
                disabled={isChecking}
                id="runtime-url"
                inputMode="url"
                label="Runtime URL"
                onChange={(event) => setBaseUrl(event.currentTarget.value)}
                placeholder="https://runtime.example.com"
                required
                spellCheck={false}
                value={baseUrl}
              />

              <TextField
                autoComplete="new-password"
                description="Kept in memory only and never persisted in this milestone."
                disabled={isChecking}
                id="runtime-key"
                label="Runtime API key"
                onChange={(event) => setApiKey(event.currentTarget.value)}
                placeholder="Enter the development key"
                required
                type="password"
                value={apiKey}
              />

              {state.status === "idle" && (
                <Alert title="Not connected">
                  Enter the Runtime connection details to continue.
                </Alert>
              )}
              {state.status === "checking" && (
                <Alert live="polite" title="Checking connection">
                  Verifying Runtime readiness and credentials…
                </Alert>
              )}
              {state.status === "failed" && (
                <Alert live="assertive" title="Connection failed" tone="danger">
                  {state.message}
                </Alert>
              )}
              {state.status === "connected" && (
                <Alert live="polite" title="Runtime connected" tone="ok">
                  {state.result.readySessions} of {state.result.sessionCount} sessions ready.
                </Alert>
              )}
            </Stack>
          </CardContent>

          <CardFooter>
            <Button
              loading={isChecking}
              loadingLabel="Checking Runtime connection"
              type="submit"
              variant="primary"
            >
              Test connection
            </Button>
          </CardFooter>
        </Card>
      </form>
    </main>
  );
}
