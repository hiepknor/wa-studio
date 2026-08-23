import { ConnectionScreen } from "@/features/connection/ConnectionScreen";
import { ManagedRuntimeSetupScreen } from "@/features/connection/ManagedRuntimeSetupScreen";
import { ToastProvider } from "@/shared/ui/Toast";
import { RuntimeConnectionProvider, useRuntimeConnection } from "./RuntimeConnectionContext";
import { WorkspaceShell } from "./WorkspaceShell";
import "./app.css";

function AppContent() {
  const {
    connect,
    configureManagedRuntime,
    connected,
    managedConnectionFlow,
    managedConnectionError,
    managedRuntime,
  } = useRuntimeConnection();
  if (connected) return <WorkspaceShell />;
  if (managedRuntime.phase !== "unavailable") {
    return (
      <ManagedRuntimeSetupScreen
        connectionError={managedConnectionError}
        flow={managedConnectionFlow}
        onConnect={configureManagedRuntime}
        snapshot={managedRuntime}
      />
    );
  }
  return <ConnectionScreen probeConnection={connect} />;
}

export function App() {
  return (
    <ToastProvider>
      <RuntimeConnectionProvider>
        <AppContent />
      </RuntimeConnectionProvider>
    </ToastProvider>
  );
}
