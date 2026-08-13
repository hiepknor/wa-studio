import { ConnectionScreen } from "@/features/connection/ConnectionScreen";
import { ToastProvider } from "@/shared/ui/Toast";
import { RuntimeConnectionProvider, useRuntimeConnection } from "./RuntimeConnectionContext";
import { WorkspaceShell } from "./WorkspaceShell";
import "./app.css";

function AppContent() {
  const { connect, connected } = useRuntimeConnection();
  return connected ? <WorkspaceShell /> : <ConnectionScreen probeConnection={connect} />;
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
